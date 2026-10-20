# Changelog

All notable project changes will be documented here.

The format is based on Keep a Changelog and Semantic Versioning.

## [Unreleased]

### Added

- Advisory Percy visual review of 18 deterministic, authored synthetic states across phone,
  810×1080 tablet and desktop CSS viewports, with fail-closed serialized DOM/resource canary
  guards and source/serialized layout parity. CI always validates locally and uploads only for
  same-repository PRs, main pushes and GitHub-hosted dispatches; forks and gateway-ci dispatches
  receive no Percy secret. No production source or runtime assets change.
- BrowserStack setup/baseline/renewal runbook and ADR-035 separating Percy visual review,
  TestingBot release deviceCloud, Automate fallback under ADR-032, and capability-free manual
  Live review. Sponsorship review is due 2027-09-20 before the 2027-10-20 expiry.

### Changed

- Move the OMP engineering baseline to published v18.12.3 (#409), with pins derived by
  `scripts/upstream-pins.ts`. Registry v1, the discovery file format and socket paths, the relay
  protocol, `collab.autoStart`, and the collaboration `host.ts`, `registry.ts`, `settings.ts`,
  and `packages/wire/src/index.ts` sources are unchanged from v18.10.2. Session entries gain an
  optional `runtime` build identity (can1357/oh-my-pi#15680), a CLI guest's prompt-cache key
  changes (can1357/oh-my-pi#15467), and the `collab-web` eval renderer changes
  (can1357/oh-my-pi#12730); none changes what the gateway reads or sends. The embedded client
  remains at v18.4.2. No qualification is claimed; published v0.7.7 stays bound to OMP v18.10.2.

- Rewrite the README, public site home page, and operator and user documentation reader-first.
  The README leads with the product promise, demo, a three-step quickstart, everyday use, the
  privacy model, and a two-column supported-platforms table, and drops release-ledger prose,
  fork-era history, and the architecture diagram. New `docs/README.md` indexes every document by
  task (use, trust, build on, dated records) and new `docs/USAGE.md` explains the directory,
  View and Control, Needs you, hold and hide, background alerts, app installation, and error
  states from the phone holder's point of view. `docs/OPERATIONS.md` keeps its numbered headings
  but reads as a task guide with a configuration table, doctor check list, and
  troubleshooting-by-symptom table; installer transaction internals move to
  `docs/ARCHITECTURE.md`. `docs/UPGRADE_ROLLBACK.md` opens with upgrade, rollback, boundary
  recovery, and what rollback never does, and restores the v0.6.0–v0.7.0 predecessor sections the
  release ledger links. `docs/COMPATIBILITY.md` leads with the support table and a plain
  current claim. Stale current-state claims (v0.4.0 status, Windows and background Web Push
  "not yet qualified", the ADR-018 worker-navigation gap) are corrected across the root security
  policy, package READMEs, and runbook introductions; the site home page, `llms.txt`, and all
  four site pages gain a Docs link. `scripts/docs-links.test.ts` fails on any relative Markdown
  link or heading fragment that does not resolve.
- Visual QA of the README on GitHub's desktop and phone renders: the install step is now one
  copyable block (`tar`, `cd`, `install`, `serve-guidance`, shared with Operations) instead of
  archive names in prose; the supported-platforms table shows the qualified OMP commit as a short
  SHA linked to the exact upstream commit so the table no longer scrolls sideways on a phone; the
  settings-sheet capture appears once, beside the background-alerts bullet. `release-generate`
  approve emits the linked short commit.
- The README adds BrowserStack's open-source attribution ("This project is tested with
  BrowserStack") below the TestingBot real-device acknowledgement.

### Fixed

- Run the Percy CLI under native Node instead of Bun's incompatible HTTP server layer, and pin
  its CI Node 24.22.0 LTS runtime. Preserve sanitized phase/reason/count diagnostics through both
  runner layers so a created build with zero accepted snapshots cannot hide its failing boundary.
- Poll for the installed WebAPK's DevTools page target before judging the published-byte smoke render, with a fail-closed deadline and sanitized timeout diagnostics.
- Open sessions on tablet and desktop widths are no longer squeezed into the directory's 35rem
  column (#411, #412). The directory's `main` rule also sized the embedded client's `<main>`, so the
  transcript stayed 542px wide and code lines showed about 45 characters. From 37rem up, the
  session, its header, and its triage bar share one centered `min(100% − 2rem, 60rem)` column, and
  the transcript reaches the client's own 900px width (about 88 characters per code line). The
  directory keeps its 35rem triage column, and nothing changes below 37rem.

## [v0.7.7] — 2026-10-13

This release uses stock OMP v18.10.2 as its engineering baseline. The 2 changelog entries below record the changes since v0.7.6. Historical receipts do not qualify these bytes.

### Fixed

- Classify a timed-out 1Password identity probe as a host fault with the macOS installed-path
  recovery recipe. Kill an unresponsive probe at its 30-second deadline, distinguish external
  signals from timeouts, and preserve the release driver's explicit new-candidate retry gate.

### Changed

- Move the OMP engineering baseline to published v18.10.2 (#398), with pins derived by
  `scripts/upstream-pins.ts`. Registry v1, the discovery file format, the relay protocol,
  `collab.autoStart`, and the collaboration `host.ts`, `settings.ts`, and `collab-web` sources
  are unchanged from v18.8.9. The registry moves onto native IPC with the same request and
  response lines and relocates overlong sockets under `/tmp/omp-<euid>`
  (can1357/oh-my-pi@a608a9ca07); host relay
  pings (can1357/oh-my-pi#14387) and `ctx.annotations` (can1357/oh-my-pi#15260) change nothing the
  gateway reads or sends. The embedded client remains at v18.4.2. No qualification is claimed;
  published v0.7.6 stays bound to OMP v18.8.9.

## [v0.7.6] — 2026-10-10

This release uses stock OMP v18.8.9 as its engineering baseline. The 8 changelog entries below record the changes since v0.7.5. Historical receipts do not qualify these bytes.

### Added

- Request a gateway release weekly on Mondays at 15:17 UTC after the exact-version stock OMP
  canary. Scheduled requests skip when the lock already equals or exceeds npm `latest` or any
  trusted open tracking request exists, including a re-check before filing. Manual dispatch and
  fixes-only requests are unchanged.

### Changed

- Move the OMP engineering baseline to published v18.8.9 (#390), with pins derived by
  `scripts/upstream-pins.ts`. Registry v1, discovery, the relay protocol, `collab.autoStart`, and
  the collaboration host and `collab-web` sources are unchanged from v18.8.3; the relevant-path
  changes add `/fork pane|window|tab` (can1357/oh-my-pi#13620) and `/dump anon`
  (can1357/oh-my-pi#15077), which the gateway does not use. The embedded client remains at
  v18.4.2. No qualification is claimed; published v0.7.5 stays bound to OMP v18.8.3.
- The release driver lands an order only from `carrythroughsystems[bot]` on a `carrythrough/*`
  head: the delivery App's new name and branch prefix.

### Fixed

- Verify only the exact digest-pinned v0.7.5 rollback predecessor using its retained original
  Cosign identity when historical build attestations are absent. Record that proof truthfully
  in qualification and approval; candidates and every other predecessor still require online
  GitHub attestations. Changed historical bytes or a failed signature refuse qualification.
- Run the release driver's detached jobs at interactive priority, as an operator's SSH session
  does. Its LaunchAgent ran as `Background`, then `Standard`, and every job it started inherited
  launchd's limits: on the Studio, `Standard` lowered their base priority from 31 to 20 and
  stretched a 10 ms sleep to 58–73 ms. v0.7.5's approve check failed three times on
  cross-process lease tests that pass over SSH, stopping the release after its campaign had passed.
- A busy release-host lease now refuses after one busy timeout instead of two. Bun's
  `Database.exec` ignores a failed statement unless it is the last one, so a contender went on
  past its busy `BEGIN IMMEDIATE` and waited again on its next statement. The repository check
  now rejects multi-statement `exec` calls on `bun:sqlite`.
- Publication and revocation waits now fail with their deadline message when a session-list read
  is still pending at the deadline, instead of the read's own timeout.
- A retried published-byte smoke can now be recorded. The release driver ran the smoke without
  `--force-reinstall`, so a retry found v0.7.5 already active from the failed attempt, skipped the
  install and reported `gateway.installed: false`, which the record generator rejects. The driver
  now always reinstalls the published bytes.

## [v0.7.5] — 2026-10-08

This release uses stock OMP v18.8.3 as its engineering baseline. The 8 changelog entries below record the changes since v0.7.4. Historical receipts do not qualify these bytes.

### Added

- Opt-in release requests gated by the existing stock OMP canary, and a resumable Studio release
  driver whose automated writes use the release bot. The founder alone merges the generated
  approve PR; exact-head checks, signed tags, candidate qualification, runtime equality, published
  provenance, rebuilt digests and installed-byte smoke remain mandatory.
- Deterministic prepare/approve/record generation with v0.7.4 golden evidence, workflow-independent
  release text, and a device-free offline `check:order` lane for Carrythrough patches.

### Changed

- Move the OMP engineering baseline to published v18.8.3 (#368), with pins derived by
  `scripts/upstream-pins.ts`. Registry v1, discovery, the relay protocol, and `collab.autoStart`
  are unchanged; upstream stops mirroring frames while no guest is joined
  (can1357/oh-my-pi#14714), and from 18.8.1 a generated session name may begin with a title-card
  icon and code. The embedded client remains at v18.4.2. No qualification is claimed; published
  v0.7.4 stays bound to OMP v18.5.1.

### Fixed

- Derive a session's folder label in linear time. The trailing-separator regex backtracked
  quadratically when a long run of path separators did not end the `cwd`: 200,000 separators took
  about 17 seconds. Parsed host snapshots already cap `cwd` at 256 code points, so the daemon never
  hit this; the exported `observedSessionFromSnapshot` no longer relies on that cap (CodeQL
  `js/polynomial-redos`, #365).
- Serialize stable qualification and published-byte smoke across processes and checkouts on the
  release account using a crash-released OS lock. Keep durable campaign ownership after a failure
  so only that campaign can recover its receipts before another tag or smoke acquires the host.
- Report a 1Password CLI that fails or never exits as itself in the real-device cloud lane's
  admission. v0.7.5's first campaign stopped at preflight with "the 1Password token is not a
  service account of my.1password.com" because the release host's `op` hung at exec; the
  admission now names the timeout, or `op`'s exit status and first error line.
- Re-plan when the release driver's pinned merge finds its PR moved. During v0.7.5, #369's head
  was replaced after the driver saved its merge intent, and every tick replayed the stale merge
  until the state file was edited by hand. An intent refused before any effect is now dropped,
  and the next tick plans from a fresh snapshot.
- Retry a failed release from a new request for the same OMP version. The order PR's "Closes #368"
  closed the tracking issue when the order merged, so the retry request opened #374, and the driver,
  which looked only for #368, waited indefinitely. It now takes the newest open request for the
  same version when the original issue is closed.

## [v0.7.4] — 2026-10-03

This release carries no gateway runtime fixes since v0.7.3. The OMP engineering baseline moves
to v18.5.1, the first release that retries a `collab.autoStart` launch whose relay is
unreachable or times out; the embedded collaboration client and its 18.4.2 wire pin remain
unchanged. A new script derives the upstream lock and Windows qualification pins.

### Added

- `bun scripts/upstream-pins.ts <version> [--write]` derives the exact tag, commit, tree, package
  versions, and Darwin arm64 and Windows x64 native pins for a published OMP release, hashing each
  native tarball only after it matches registry integrity. It refuses a Bun range the pin does not
  satisfy and any relevant path missing at the tag. That check found the lock still listing a
  settings schema upstream deleted before v18.4.2; it now names `collab/settings.ts`.

### Changed

- Move the OMP engineering baseline to published v18.5.1, the first release that retries a
  `collab.autoStart` launch whose relay is unreachable or times out (can1357/oh-my-pi#14112, #343).
  The upstream canary passed all ten Linux stages and all seven supported Windows stages. The
  embedded client remains at v18.4.2. Published v0.7.3 qualification stays bound to OMP v18.4.12
  (#361; canary run 37140425389).

## [v0.7.3] — 2026-10-02

This release carries no gateway runtime fixes since v0.7.2. The OMP engineering baseline moves
to v18.4.12; the embedded collaboration client and its 18.4.2 wire pin remain unchanged.
Qualification tooling tightens Mac reboot proof, admits any Pixel on Android 13+, and waits for
the launched WebAPK task. ADR-033 plans a retained Virtualization.framework Mac guest;
preparation and historical receipts do not qualify the new candidate.

### Changed

- Move the OMP engineering baseline to published v18.4.12 and refresh the measured Darwin arm64
  and Windows x64 native pins. The upstream canary passed all ten Linux stages and all seven
  supported Windows stages. The embedded client remains at v18.4.2; upstream Markdown-rendering
  changes are not imported. Published v0.7.2 qualification stays bound to OMP v18.4.8 (#351;
  canary run 37040958377).
- Document the planned retained Virtualization.framework macOS guest under ADR-033 (#348).
  Guest kernel, launchd, loginwindow, and reboot coverage do not cover physical firmware,
  FileVault, or Secure Boot; published bare-metal qualification remains historical evidence.

### Fixed

- Require the Mac persistence verdict to prove a changed guest boot identity, console login,
  recovered gateway readiness and doctor, and unchanged full readiness-token digest. Old-boot
  SSH or gateway output cannot qualify a reboot; identifying values are not printed (#349).
- Admit any identified Pixel on Android 13+ to background-Push qualification instead of
  requiring one handset model; refusals identify the attached model or Android release (#350).
- Poll for the launched WebAPK task every second for up to 30 seconds during published-byte
  smoke instead of sampling once after two seconds; the unchanged task assertion still fails
  closed at the deadline (#346).

## [v0.7.2] — 2026-10-02

This release carries no gateway runtime fixes. Qualification tooling adds session-lifecycle and
Push-triage scenarios, and the configured Mac Studio replaces the retained Scaleway Mac as the
qualification host, with a host-owned reboot guard. The OMP engineering baseline moves to v18.4.8;
its embedded collaboration client is byte-identical to v18.4.2 and stays unchanged.

### Added

- Support an optional host-owned Mac qualification reboot guard. Both preflights refuse busy
  or misconfigured guards before lane effects; persistence rechecks immediately before shutdown
  and reports up to 400 diagnostic bytes on refusal, without rebooting a busy shared host.
- Extend the upstream OMP canary with new-session, immediate fork, in-session rewind, and saved
  session continuation checks. Windows runs continuation and explicitly skips the three
  keystroke-driven stages; bounded summaries include the platform.
- Add retained-Mac `ompPublication` lifecycle evidence for `/new`, `/fork`, stop/revocation,
  `--continue`, and final revocation. Add `bun scripts/omp-lifecycle-development.ts --omp <path>`
  to prove the shared runner in an isolated loopback gateway before a stable campaign.
- Add physical Push triage and delayed-tap phases with two owned fixture hosts: FIFO,
  Hold/requeue, Hide/Undo/Show all, and stale attention taps. Delayed taps re-present the original
  notification's metadata-only data, proving tap handling rather than push delay or ordering.
  These scenarios qualify only after the next passed signed-candidate campaign.
- Document granular tailnet/device posture guidance in the operations and security guides.

### Changed

- Select the stable-qualification Mac through an explicit SSH destination and expected hardware
  model instead of a retained cloud lease lookup. Support a private sudo-password file or narrow
  passwordless sudo, record the measured hardware in schema-3 receipts, and make Homebrew tools
  available to noninteractive remote lanes. Existing qualification claims are unchanged.
- Move the OMP engineering baseline to published v18.4.8. Its collaboration host source and
  `collab-web` are byte-identical to v18.4.2, so the embedded client and its `@oh-my-pi/pi-wire`
  18.4.2 pin are unchanged. The Mac, Debian, and Windows qualification lanes now build stock OMP
  18.4.8; upstream reports that 18.4.3 through 18.4.7 crash at startup on Apple silicon macOS
  earlier than 27. The minimum host stays 18.1.20, and qualified release claims stay with v18.4.2
  until a candidate built from this baseline qualifies.
- Archive restored Push development progress automatically when the candidate, origin, or OMP
  pin changes, while retaining unfinished cleanup requirements.

### Fixed

- Require stock OMP >=18.1.20 on the Mac lane PATH during both preflights, before doctor can
  fail its compatibility check on a fresh account. Missing or unsupported OMP now refuses before
  any lane and reports the exact coding-agent install command from the upstream package pin.
- Bind Mac qualification effects to their configured SSH host in schema-3 receipts; refuse
  retargeted resume and unbound legacy cleanup before any remote call, and never clean an unowned
  host after admission refusal. Resolve remote measurement tools from a fixed system-first PATH
  and use the absolute system hardware probe so account-local executables cannot shadow it.
- Re-arm a Push phase after its one permitted foreign-notification overlap by waiting only for
  pending attention clears, then dismissing remaining owned notices. An activity-stop notice has
  no clear and previously held the re-arm until its 160-second timeout.

## [v0.7.1] — 2026-09-30

Tapping a notification no longer reloads an open collaboration or reopens it as View, a session
list left in the background no longer keeps the phone waking for live-update keepalives, and the
gateway releases event streams that stop reading. The other changes are qualification tooling and
evidence; the OMP engineering baseline stays v18.4.2.

### Added

- Add an isolated, bounded synthetic endurance command with scheduled metadata changes and host
  churn, sustained SSE subscribers, View launch and delivery latency distributions, and daemon
  CPU/RSS/descriptor trends. Numeric-only evidence and shared metadata leak checks keep capabilities
  out of artifacts; the weekly capacity workflow reuses the extracted discovery host fixture.
  Its first eight-hour run is recorded as tested evidence and is not a release-qualification claim.
- Record the first eight-hour observations of the v0.7.0 runtime in the release ledger and in test
  plan §6, as tested evidence rather than qualification. One is a default-relay soak of the
  installed release that includes the gateway's resident-memory series. The other is a 50-host
  synthetic endurance run of the release source, covering launch and delivery latency, CPU,
  resident memory and descriptors.

### Changed

- The default-relay soak (`bun run qualify:relay-soak`) also measures the gateway process named by
  `OMP_GATEWAY_SOAK_GATEWAY_PID`: it samples resident memory and CPU time when the relay goes live,
  about every minute, and at completion, fails if the gateway exits, and reports start/end/min/max
  RSS, the RSS trend per hour, and in-window CPU. `OMP_GATEWAY_SOAK_SAMPLES` appends every sample to
  a new CSV. The process is never inferred from the listening port, which may be a tunnel, as in
  stable qualification's SSH-forwarded relay lane, which also clears any inherited PID or samples
  path. Without a PID the soak takes no gateway measurement. The procedure had required start/end
  memory readings before any bounded-growth claim without taking them.

### Removed

- Post-release smoke no longer accepts `OMP_ANDROID_SERIAL` to bypass ambiguous device admission.
  All Android paths require exactly one authorized device; disconnect other devices before running.

### Fixed

- SSE streams that stop reading now release their subscription and keepalive timer when the queue
  fills, even while the session directory is quiet. Completed subscription admission also drops
  buffered events instead of retaining their metadata for the lifetime of the stream.
- Provider/control-plane reads retry transient connection, DNS and deadline failures within the
  same five-attempt budget as HTTP 5xx. GitHub state checks, Windows egress discovery and TestingBot
  reads/downloads share the helper; mutations and programming errors are never replayed. Repository
  admission rejects new direct harness fetches without a reviewed non-provider exemption.
- Tapping a notification no longer reloads an open collaboration. Chromium reports a window's
  creation URL, so on the Pixel's WebAPK a live `/client/` page looked like the directory, and the
  worker navigated it: the live client and any unsent composer text were lost, and an activity-stop
  tap relaunched a Control session as View. The worker now hands the tap to the open page, which
  revalidates it against current metadata and switches in place; a tap for the session already open
  keeps it. With no open page, the tap opens its route as before.
- A directory left in the background no longer keeps its live-update stream open. Chrome freezes a
  hidden page about a minute after it is hidden, but kept the connection, and the phone kept waking
  for its five-second keepalives: a backgrounded Pixel received them for all of a twelve-minute
  measurement. The page now closes the stream when it is frozen and rebuilds it from a fresh
  snapshot when it is shown again; a briefly hidden page keeps its stream.
- Android harness commands share one adb runner that rejects non-zero exits and withholds device
  identifiers, argv and subprocess output from errors. Acceptance no longer treats a failed device
  mutation as success. Shared restoration attempts every step and reports restoration failures with,
  never instead of, the phase failure. Acceptance restores and verifies the airplane, Wi-Fi and
  mobile-data baseline it found, leaving data off when it started off. On a multi-SIM phone, mobile
  data is read from the default data subscription, as the Push lane now does too, because the global
  setting can stay stale. Nested restoration errors retain the unrestored-Pixel flag, and a failed or
  timed-out acceptance child, whose restoration cannot be verified from outside, leaves the campaign
  refusing later Pixel lanes. Repository checks reject unsafe throws/returns in finally.
  Reachability observations consume ping failures inside the device shell, including Toybox's
  unknown-host exit during Airplane mode, while adb transport failures still fail the lane.
- Stable qualification refuses to start while the Pixel under test shares its connection through
  a hotspot, USB or Bluetooth tethering. This is checked at orchestrator admission, before provider
  lookup or any lane, and independently by Android acceptance, post-release smoke and the background
  Push lane. An unavailable or unrecognized tethering probe refuses admission too. Stable and Push
  admission also require Do Not Disturb (`zen_mode`) off before spending earlier lanes; a Bedtime
  schedule once intercepted every WebAPK notification. Notification phases keep their rechecks,
  and the harness never changes DND. Acceptance and post-release smoke do not need notifications,
  so they still run with DND on. The Push lane switches radios, so a
  controller on its hotspot lost WinRM, SSH and the gateway origin mid-campaign; this failed two
  v0.7.0-prealpha.1 campaign attempts.
- Background Push qualification enables the Pixel's mobile data only after Wi-Fi validates when it
  leaves Airplane mode. Mobile data validated first, Play Services opened its push socket there, and
  once Wi-Fi took over that socket held the authoritative clear past the 160-second recovery window.
- A Vultr instance or firewall listing that comes back without its array is re-read once after five
  seconds before the Windows lane fails, as a missing lookup already was. One such answer failed a
  v0.7.0-prealpha.1 attempt while its VM was still booting.
- The Windows qualification VM moves from 2 vCPU and 4 GiB (`vc2-2c-4gb`) to 4 vCPU and 8 GiB
  (`vc2-4c-8gb`). Building stock OMP 18.4.2 on the guest failed in two of the three
  v0.7.0-prealpha.1 attempts that reached it; the guest now also keeps that install and build
  output, for inspecting a retained development VM. The controller pin moves to FreeRDP 3.32.1.
- Qualification's provider reads retry a 5xx five times over about half a minute instead of three
  times over six seconds. Vultr answered 502 to all three reads of one staging lookup, which failed
  a development Windows run with its VM healthy.
- Windows qualification cleanup no longer fails after the lane's reboots when Windows has reused
  the stored OMP process ID: an ID that names another executable means OMP already exited, and that
  process is left alone. Cleanup can also be repeated after a completed teardown, where it failed
  restoring the Pixel from the removed vault and left the shared Pixel lock behind.

## [v0.7.0] — 2026-09-29

The embedded collaboration client moves to OMP 18.4.2's redesigned web client, and the OMP
engineering baseline moves to v18.4.2. The client also ships React's production build, and on
Windows the gateway fails closed when its scheduled task cannot be queried.

### Changed

- Refresh the embedded collaboration client and OMP engineering baseline to published v18.4.2,
  with `@oh-my-pi/pi-wire` pinned to 18.4.2. Adopt upstream’s buffered snapshot publication,
  completion-by-count, finished-stream clearing, redesigned client surfaces, and coarse-pointer
  text sizing. Keep gateway chrome, in-memory capabilities, photo/Ask controls, bounded recovery,
  and reader-preserving explicit transcript expansion; exclude OMP artwork. The minimum host
  stays 18.1.20 and qualified release claims remain unchanged pending a new qualification campaign.

### Fixed

- Fail closed on Windows when the gateway's scheduled task cannot be queried. Any failure other than
  a missing task read as a stopped gateway, which is how the WMI refusal fixed in v0.6.3 misreported
  a running one. Acting on that answer, `uninstall` could delete the task while the gateway kept
  running, and `stop`, readiness-token rotation and `install --no-start` could treat it as stopped.
  They now fail with the error, `status` reports it, and `doctor` fails its two service checks while
  keeping the rest of its report.
- On an iPad or a phone in landscape, iOS Safari no longer zooms into the collaboration composer
  when it takes focus. The client kept its text fields at 16px, the size below which iOS zooms on
  focus, only for screens narrower than 640px; it now does so for any touch screen. This adopts
  upstream collab-web [#13371](https://github.com/can1357/oh-my-pi/pull/13371), first shipped in
  OMP v18.4.1.
- The collaboration client shipped React's development build, which React documents as larger and
  slower. The web build never defined `process.env.NODE_ENV`, so React bundled its development
  variant. Every browser bundle now builds for production, and the build fails if the client still
  contains React's development build. The client's JavaScript shrinks from 884 KB to 644 KB.

## [v0.6.3] — 2026-09-27

On Windows, the gateway installs and runs from a standard (non-elevated) account. v0.6.2 and
earlier failed there twice: re-securing private folders required a privilege only administrators
hold (#293), and the logon task could only be registered by an administrator (#294).

### Added

- The `windows-service-lifecycle` CI lane also installs, reinstalls, and uninstalls the gateway as
  a standard local user, whose token has no `SeSecurityPrivilege` and may register tasks only for
  its own logon, and starts the registered task's command as that user until it reports ready.
  Every earlier step runs as the runner's administrator, which is why neither defect below was
  caught.
- The stable campaign's Windows lane (ADR-031, amended) now installs the candidate fresh as a local
  account outside Administrators whose token lacks `SeSecurityPrivilege`, after the Administrator
  journey on the same VM. It reboots, requires automatic start at that account's logon, then runs
  the full doctor, rotation, and uninstall as the account. Every Windows doctor and pre-login sample
  also requires the logon trigger to name the account the task runs as.

### Fixed

- On Windows, a standard (non-elevated) user's install failed with "The process does not possess
  the 'SeSecurityPrivilege' privilege" and rolled back
  ([#293](https://github.com/alphastorm/omp-session-gateway/issues/293)). The private-ACL helper
  re-secured each private path through `Get-Acl` and `Set-Acl`. Once a path's DACL was protected,
  `Set-Acl` also tried to write its SACL, which needs a privilege only administrators hold, so every
  command after the first failed. The helper now writes only the owner and the DACL, from a fresh
  security object, whether or not the caller is elevated. The ACL it checks for is unchanged.
- On Windows, a standard user's install also failed with "Access is denied" from `schtasks`
  ([#294](https://github.com/alphastorm/omp-session-gateway/issues/294)). The scheduled task's
  logon trigger named no user, so it fired on any user's logon, and only an administrator may
  register that. The trigger now names the installing user's SID. The gateway still starts at that
  user's interactive logon, with that user's token and least privilege.
- On Windows, `status` and `doctor` reported a standard user's running gateway as stopped when run
  over SSH or another network logon, and an upgrade or uninstall then stopped waiting for the task
  to end. The gateway read the task's state through `Get-ScheduledTask`, and WMI refuses those
  cmdlets to a standard user's network logon. It now asks the Task Scheduler's COM interface, which
  answers any account for its own task. The stable qualification's standard-user lane found this.
- On Windows, stopping the gateway for a restart, upgrade, or uninstall returned once the Task
  Scheduler reported the task ended, but its process could hold the port about 600 ms longer, so a
  restart inside that window could fail to bind. The slow `Get-ScheduledTask` poll had hidden
  that window. Stopping now waits for the gateway's own process to exit.

## [v0.6.2] — 2026-09-26

The gateway, PWA, and collaboration client are unchanged from v0.6.1. This release qualifies iPhone,
iPad, and Galaxy browsers on real cloud devices.

### Added

- Stable qualification (`qualify:stable`) also qualifies iPhone, iPad, and Android browsers on real
  devices in TestingBot's cloud (ADR-032). The `deviceCloud` lane opens the candidate gateway
  through TestingBot's tunnel. On each device it runs the directory, View, Control, prompt, and
  capability-sink journey against the campaign's live OMP session. The iPhone also installs the
  Home Screen app, enables background alerts with a real tap on the permission prompt, and taps a
  delivered alert into Control. Afterwards every test record TestingBot kept is checked for the
  sessions' live links. Each device must report itself as the requested kind of device, browser,
  and OS release, and the receipt records what it reported.

  The tunnel's local proxy is the lane's own, which reaches only the candidate origin and the
  relay its CSP names, never the workstation's loopback, LAN, or other tailnet services. The
  tunnel's Selenium relay and metrics server stay closed: stock, they listen on every interface,
  and the relay lends the TestingBot account to anyone who can reach it. The lane closes the
  tunnel and its fixture before handing the Pixel to another lane.
  Credentials come from the 1Password service account without a prompt. The lane has its own
  cleanup lane, and the receipt schema moves to version 3, so older receipts cannot resume.
- Stable approval from 0.6.2 requires passed `deviceCloud` evidence in `STABLE_RELEASE.lock.json`,
  as it has required Windows and background Push evidence since 0.6.0. The documentation checks
  now also flag "the next stable release" once nothing is unreleased, and iPhone or iPad described
  as untested on a physical device once the lock holds cloud evidence.

### Fixed

- The capability-sink scan no longer fails in iPhone and iPad Safari tabs, whose service-worker
  registration has no `getNotifications`, and it now also checks cache and database names.

## [v0.6.1] — 2026-09-26

### Added

- `bun run release:compare` checks a stable build against its qualified candidate: both archives
  must hold the same members, and every member outside the promotion metadata must have the same
  mode and bytes, read from the archive's own headers rather than an extraction.

### Fixed

- iPhone and iPad can enable background alerts. WebKit's `PushSubscription.toJSON()` leaves out
  an `expirationTime` of null, and the exact subscription check rejected that shape before the PWA
  sent anything, so the new subscription was removed and the control read "Background alerts
  unavailable" (#274). A missing `expirationTime` now means null in the PWA and the gateway.

## [v0.6.0] — 2026-09-25

### Added

- CI checks every change on Linux, macOS, and Windows (`portable-source`): repository scan,
  typecheck, web build, the test suite, and both leak scans. Linux and macOS run every test; Windows
  excludes five host-bound test files, each named with its reason in `scripts/test-portable.ts`.
- CI runs the browser-neutral end-to-end tests (tagged `@core`) on desktop Chromium, Firefox, and
  WebKit and on WebKit with iPhone-class emulation (`browser-core`): directory, View and Control
  launch, stale-route refusal, capability-sink sweeps, bfcache resume, reconnect, the software
  keyboard, and a service-worker update. The Pixel/Chromium lane keeps the full suite.
- The upstream OMP canary also runs on Windows (`canary-windows`): stock OMP starts in its own
  hidden console and publishes its named pipe, and the gateway's reader, stale-generation refusal,
  View and Control joins through the relay, prompt echo, and host-death checks run against it. A
  scheduled failure names the failing host in the tracking issue. OMP's own commands now have a
  60-second bound, because a fresh profile's first command also unpacks OMP's native addon.
- Windows install and checksum steps in PowerShell, rehearsed against the published v0.5.3 archive
  on a Windows runner.
- Stable qualification (`qualify:stable`) also qualifies a Windows host and background Web Push
  (ADR-031). The Windows lane creates a disposable Windows Server 2025 VM firewalled to the
  operator's address. On it, the exact signed candidate and predecessor run with stock OMP through
  install, a real reboot, automatic start at interactive logon, the physical Pixel, rotation,
  rollback, and uninstall; the VM, its firewall, and its tailnet node are destroyed afterwards. The
  background Push lane drives the Pixel's installed OMP Sessions app against the candidate gateway:
  - delivery with the app closed, at each detail level and on the lock screen;
  - taps to current Control and View, stale-generation refusal, and authoritative clear;
  - force-stop, permission revocation, Doze, network changes, and the capability sinks;
  - restoring the phone afterwards.

  Each lane has a cleanup lane bound to the attempt it released, and the Pixel's lanes take turns.

### Changed

- Support and qualification are separate claims (ADR-030). Linux, macOS, and Windows hosts;
  Chrome, Chromium, and Edge; Firefox; Safari/WebKit; and Android are supported and tested in CI,
  with iPhone and iPad tested as a WebKit browser. Qualification remains the exact hardware matrix
  each signed release passes. The README opens with a compatibility table, and the
  compatibility policy with the per-platform lanes.
- The PWA's outage messages and troubleshooting sheet no longer assume an Android phone: they
  speak of "this device", explain how to fully close the browser on Android, iPhone and iPad, and
  computers, and note that iPhone and iPad offer background alerts only to a Home Screen app.

### Fixed

- The repository scanners and several tests open files on Windows. They used a file URL's
  `pathname` as a filesystem path (`/D:/...`), and the scanners compared backslash-separated paths
  against forward-slash exemptions; the repository check now rejects the `pathname` pattern.
  Tracked text also checks out with LF line endings on every OS.
- Background notifications no longer stall after a burst of activity. Every push carried a
  per-session Web Push `Topic`, which FCM treats as a collapse key and limits to a burst of 20
  messages per device, then one every three minutes. On a Pixel, the 22nd and 23rd messages of a
  burst took 151 and 172 seconds, so an answered ask's notification stayed up for minutes. Pushes
  now carry no `Topic`; in the same test all 28 arrived within about 3 seconds. The push service
  also no longer sees a per-session identifier.
- On Android, an OMP Sessions alert cleared moments after it was shown could stay on screen for good,
  with a tap reporting it expired. This happened after a burst of queued pushes on reconnect, a
  duplicate delivery, or a replay just before the clear. Chrome can apply a notification's close
  before its own display, which leaves the display in place with nothing left to close it. The
  service worker now waits until two seconds after a display before closing it, and no longer
  re-shows an alert whose request and text are unchanged.
- The Windows qualification lane expected a pre-release candidate to install under its tag's
  version, for example `0.6.0-prealpha.1` instead of `0.6.0`, so its upgrade check failed for every
  candidate. Qualification scripts now derive a tag's package version in one place, and the
  repository check rejects slicing it from the tag (qualification tooling only, outside the
  runtime archive).
- On Windows, the gateway could exit at logon without ever listening, and it then stayed down until
  the next logon. The private-ACL helper (`powershell.exe`) starts cold, and right after install
  that start outlasted its 10-second reply deadline. The gateway stopped that helper, then waited on
  its output with nothing holding the process open, so it exited cleanly (status 0) before starting
  the retry. That wait now keeps the process alive. The retry's helper started just as cold and
  missed the same deadline, so each helper's first reply may now take 45 seconds; later replies
  keep the 10-second limit.

## [v0.5.3] — 2026-09-24

### Added

- Run a daily upstream OMP canary against latest stock OMP, checking discovery, queries, generation-
  bound View/Control joins, prompt echo, and host death; scheduled failures update one tracking issue.

### Changed

- Move the OMP engineering baseline to v18.3.0 and refresh the embedded collaboration client to
  OMP's v18.3.0 `collab-web`. The client renders the new `wait` tool, keeps the `hub`, `irc`, `job`,
  `await`, `poll`, and `cancel_job` renderers that older supported hosts still emit, and memoizes the
  transcript's active-tool scan so streaming tokens no longer re-walk the whole transcript.
  `@oh-my-pi/pi-wire` is pinned to 18.3.0. The minimum supported OMP stays 18.1.20, and the
  qualified matrix moves only when a candidate built from this baseline qualifies.

### Fixed

- Qualification, smoke, and canary fixtures start OMP with a model that stock OMP 18.3.0 resolves
  with the synthetic key. OMP 18.3.0 no longer offers `openai-codex/gpt-5.4-mini` without a signed-in
  Codex account, so its fixture host ran without a model and rejected the Control prompt. Fixtures
  now also skip OMP's onboarding wizard per process, and every lane fails when its fixture
  publishes without a model, instead of timing out a minute later at the prompt stage.
- The post-release smoke uses Bun's global stock OMP when the `omp` on `PATH` is another product,
  such as a Code Mode launcher, and refuses an unusable OMP before it changes the installed gateway.
- The upstream canary workflow runs on GitHub. It used the `runner` context in job-level `env`,
  which GitHub rejects, so the workflow never started. CI now lints every workflow with a pinned,
  checksum-verified actionlint, so a rejected workflow cannot merge as a silent no-op.

## [v0.5.2] — 2026-09-24

### Changed

- Prune superseded staged runtimes after successful ready installs, retaining the active runtime,
  two distinct predecessors, and any divergent service runtime; cleanup is bounded, crash-safe,
  best-effort, and never runs during rollback or failed/stopped installs (#231).

### Fixed

- Keep sessions visible when OMP adds a field to its registry v1 discovery file, snapshot, or
  replies. OMP added `busy` that way, and the next such field would have hidden every session again
  (#219). The gateway still requires and validates every field it reads, never forwards an unknown
  one, rejects other registry versions, and refuses a snapshot that names ask content.
- Stop leftover discovery files from killed OMP processes hiding new sessions. OMP deletes them only
  while listing and the gateway never does, so every round re-read and re-queried each one against
  the 100-publication budget. The gateway now reads unknown publications newest first and skips
  unchanged files whose socket already proved dead; `omp collab list` still prunes them immediately.
- Recognize the installed service's runtime when the installation path contains `&`, `<`, `>`, or
  `"`. LaunchAgent and task XML escape those characters and systemd quotes them, so `status`
  reported a false divergence and cleanup deferred.
- Remove the stale capacity qualification registry key and validate the workflow-generated config
  through the real gateway loader in script tests (qualification tooling only, outside the runtime archive).
- Measure Android recovery from the first successful rendered-directory probe with 250 ms between
  attempts and unchanged scenario windows, rather than a multi-second initial sleep (qualification tooling only).
- Retry a release-asset download up to three times into an emptied directory when GitHub answers
  HTTP 5xx, for stable qualification and the post-release smoke. A transient 500 had failed a
  qualification run before any lane started (qualification tooling only, outside the runtime archive).

## [v0.5.1] — 2026-09-23

### Fixed

- Stop an activated PWA update from closing a View/Control page or a launch in progress. Chromium
  reports a window's creation URL, so the worker saw every page opened from the directory as an
  idle `/` and navigated it to `/update/`. Activation now only retires old shells and claims
  clients; the page reloads itself only once no launch is pending, no routed notification awaits
  its snapshot, and no collaboration client is mounted (ADR-018 amendment). This matches the
  first-attempt View/Control smoke failures after gateway upgrades.
- Keep a mounted collaboration intact when a concurrent launch fails afterwards. The failure no
  longer rewrites that page's route, removes the shared collaboration stylesheet, or reloads it.
  An expired routed notification now applies a deferred PWA update instead of leaving it pending.
- Wait for the installed PWA shell to match the release before the post-release smoke drives
  View/Control, and report the last announced physical-lane stage when a withheld Android lane
  fails. Malformed lane output no longer reaches a JSON parse error, which Bun quotes.
- Wait about a minute for a freshly registered DigitalOcean SSH key to become readable before Debian
  qualification provisions a droplet, and delete the exported key id in teardown. DigitalOcean's
  eventually consistent key reads failed a qualification run before any droplet existed and hid
  that run's key record from teardown.

## [v0.5.0] — 2026-09-23

### Added

- Optional activity status and metadata-only stop alerts for OMP hosts publishing `busy` (#197).
  Only an observed continuing working-to-idle transition can alert; ask transitions take precedence.
  Stops reuse existing privacy settings and delivery limits, and taps revalidate then open View.
  Older/unknown hosts, observation gaps, replacement, and disappearance never imply completion.

### Fixed

- Check published OMP sockets during retained-Mac qualification cleanup instead of treating a
  reused PID as a live host. Missing/refused endpoints are dead; other failures remain blocking.
  Cleanup preserves OMP-owned discovery files and unrelated processes.
- Align browser JSON Schemas with emitted ask metadata and OMP's 8–64 character identities.
  List/SSE validation shares identity and numeric bounds, requires ask metadata exactly while
  input is required, and rejects private fields. Real HTTP/SSE regressions cover the contract.
- Accept the optional `busy` snapshot field introduced by OMP 18.2.9 without hiding live
  sessions (#219). Boolean activity is validated; absent/null remains unknown, and unrelated
  fields and malformed values remain rejected. No host-version or browser-client upgrade is required.

### Security

- Refuse a request that carries evidence of a second HTTP hop before reading its identity header.
  Pointing a tunnel or reverse proxy at the gateway's loopback port was a complete authentication
  bypass: the forwarder runs locally, so it satisfies the loopback check, the host really is on a
  tailnet, so the tunnel-device probe passes, and `Tailscale-User-Login` becomes whatever the remote
  caller typed — the session directory plus live View and Control. Measured against Tailscale
  Serve's own proxy, a Serve-originated request carries `X-Forwarded-For` set to exactly one tailnet
  address and `X-Forwarded-Host` set to the host Serve answered on, so a forwarded chain, a
  non-Tailscale source, a mismatched host, a `Forwarded`/`X-Real-IP`/`CF-Connecting-IP`/`CF-Ray`/
  `X-Forwarded-Server` marker, or a Funnel marking is now refused. A remote caller cannot instruct
  the proxy in front of it to stop inserting those. This is defence in depth, not authentication: a
  raw TCP forwarder inserts nothing and stays indistinguishable from Serve, so the operator rule
  against exposing the loopback port still stands.
- Dispatch exhaustively on the authentication mode. Reading the Tailscale identity header was the
  implicit default for "not dev-localhost", so a mode added later would have inherited header trust
  by omission; a new mode now denies until it is given an explicit arm.

## [v0.4.2] — 2026-09-22

### Fixed

- Serve a Windows private-path ACL request from a second helper when the cached one dies before
  replying, instead of failing the caller. A Windows CI run showed why the old behaviour was wrong:
  a `powershell.exe` helper never answered its first request, failing the whole check, and the very
  next request — served by a freshly started helper — succeeded in under three seconds. The reply
  wait is halved to 10 seconds so two attempts cost what one attempt used to, and a reply whose id
  does not match its request stays fatal and is never retried.
- Return to the session you were in after backgrounding the app, instead of to the session
  directory. Backgrounding an installed PWA fires `pagehide`, which disposes the collaboration
  client and drops its capability, so restoring the page produced an inert shell that had to be
  handed back to the directory — momentarily switching apps was indistinguishable from the session
  dying. The restore now relaunches the same session when it is still listed at the same generation
  with the same access, carrying the pending question back only while it is still the one waiting. A
  restarted host bumped its generation and legitimately ended that session, so that case still falls
  back to the directory rather than opening its successor. No capability is retained across the
  background: the resume fetches one from OMP exactly as the first launch did. Recorded as ADR-029.

### Changed

- Derive the qualification campaign's rollback predecessor from `STABLE_RELEASE.lock.json` instead
  of a hand-maintained constant. That constant went stale exactly once per release and then
  qualified the upgrade and rollback pair against a release nobody was running: #200 corrected it
  from `v0.3.0` to `v0.4.0`, and it was still `v0.4.0` while `0.4.2` was being cut. Publication
  rewrites the lock, so every later campaign inherits the right predecessor with no edit, and a
  reintroduced literal now fails the orchestrator's tests.

## [v0.4.1] — 2026-09-22

### Changed

- Qualify `v0.4.1-prealpha.3` for `0.4.1`, with published `v0.4.0` as the rollback predecessor. The
  stable lock binds that exact candidate source and archive digest. The release carries three
  behaviour changes over `v0.4.0`: the VAPID `sub` contact is the repository URL instead of a
  reserved `.invalid` address, the gateway chrome sizes from the live visual viewport instead of
  `100dvh`, and Windows private-path ACL checks are served by one long-lived helper. Eight-hour
  endurance is not rerun and not claimed; the founder-approved 1,800-second relay check stands in
  for it, and the qualified matrix and its limits are recorded in the release ledger.

## [v0.4.1-prealpha.3] — 2026-09-22

### Changed

- Serve every Windows private-path ACL check from one long-lived `powershell.exe` helper over a
  newline-delimited JSON protocol, instead of starting a separate process per path. A cold start
  performed eleven of those starts before the loopback listener could bind, which on a 2-vCPU host
  measured about 1,854 ms each. The validation itself is unchanged — protected ACL, current-user
  owner, exactly the current-user and `S-1-5-18` entries — and a reply whose id does not match its
  request now kills the helper rather than risk attributing a failure to the wrong path. The
  Windows CI lane fell from roughly four to seven minutes to about two.

## [v0.4.1-prealpha.2] — 2026-09-22

### Fixed

- Size the gateway chrome around the collaboration client from the live visual viewport instead of
  `100dvh`, so an open software keyboard no longer hides the composer. A phone keyboard shrinks the
  visual viewport without changing the layout viewport, so the `dvh`-sized shell kept its full
  height and pushed the composer row underneath the keyboard; the mounted client already publishes
  the measured height as `--viewport-height`, and the chrome wrapping it now sizes from the same
  measurement. Browsers without the Visual Viewport API keep the previous `100dvh` behavior. Covered
  by a browser test that drives a shrinking visual viewport and asserts the composer stays inside
  it. Reported against an installed iOS PWA, which remains outside every compatibility claim; the
  layout defect itself is not iOS-specific.

## [v0.4.1-prealpha.1] — 2026-09-18

### Fixed

- Sign Web Push requests with the repository URL as the VAPID contact instead of a reserved
  `.invalid` `mailto:` address. Apple's push service rejected every JWT carrying the unreachable
  contact with `403 BadJwtToken`, so no iOS subscriber received an attention alert; FCM never
  checked it, which hid the defect on the qualified Android path. Reported and reproduced
  externally in [#173](https://github.com/alphastorm/omp-session-gateway/issues/173). iOS Safari
  remains outside every compatibility claim.
- Reject malformed media manifests before using their asset records, preserving validation
  diagnostics instead of throwing a type error. Cover canonical-package acceptance and realistic
  corruption, private metadata, and stale provenance with isolated package-level tests.
- Validate media capture provenance against the vendored browser-client pin rather than the
  independent OMP host baseline. Replace stale editorial-copy waits with rendered-state checks
  and regenerate the canonical synthetic media with Bun 1.4.0 and the v18.1.14 browser client.
  The strict media gate remains enabled; synthetic demonstrations do not qualify live workflows.

## [v0.4.0] — 2026-09-14

### Changed

- Qualify `v0.4.0-prealpha.1` for `0.4.0`, the first stock-mainline-compatible release, with
  published `v0.3.0` as the explicit fork-era predecessor. The stable lock binds the exact
  qualified candidate; publication status is recorded in the release ledger. Require an exact
  candidate for on-demand Debian qualification instead of scheduled runs on a stale default.
- Pass fresh Debian 13 x86-64, Mac14,3/macOS 26.6.1 arm64, and Pixel 10 Pro/Android 17/Chrome
  152.0.7977.82 qualification with stock OMP 18.1.20 and Bun 1.4.0. The approved 1,800-second
  relay check replaces the eight-hour gate for this release: eight-hour endurance was not rerun,
  no historical evidence transfers, and residual prolonged-operation risk is accepted.
- Scope Linux ARM64 upstream checks to the three discovery/query registry suites consumed by the
  gateway, rather than unrelated collaboration tests and upstream-wide checks. Keep the required
  Windows gate on gateway contracts, ACLs, and service lifecycle; upstream Windows fixtures fail
  on SIGTERM handling and a Bun 1.4.0 crash. Windows OMP integration remains unqualified.
- Cut over to stock mainline OMP `>= 18.1.20` after upstream PR #11908 (`4999b98bd5`), shipped
  in `v18.1.20`. Remove the fork-era OMP patch set and gateway publisher transport; read OMP’s
  discovery directory, poll metadata, and fetch capabilities per launch without storing them.
  `collab.autoStart` is the only OMP setting required. Rename the gateway-only readiness token
  to `readiness-token` and its rotation command to `rotate-readiness-token`; installation removes
  the legacy fork-era `publisher-token`. Add `omp.discoveryDir` and `omp.queryTimeoutMs` config;
  `registry.heartbeatSeconds` now controls polling. Launch returns `409 mode_unavailable` when
  the host no longer shares the requested role. Qualification uses fresh mainline evidence;
  no published fork-era result transfers.

### Added

- Publish a canonical public site at `alphastorm.github.io/omp-session-gateway` (overview, compare,
  status, security, `llms.txt`, sitemap) from `site/` through a SHA-pinned GitHub Pages workflow that
  stages brand and media assets from their single sources. `bun run check` now fails when the site
  stops stating the locked stable release or OMP baseline, references a missing asset, or drifts
  from its sitemap.

### Fixed

- Accept bare and `omp/`-prefixed version banners during post-release OMP inspection, preserving
  the minimum supported version instead of rejecting an already compatible installation.
- Bound discovery enumeration, file reads, and query concurrency; preserve metadata through transient
  directory faults, reject mismatched host identities, and isolate malformed snapshot projections.
- Revalidate launch authorization after capability queries and close late or already-settled query
  sockets without sending a request after timeout.
- Reject snapshot timestamps outside the JavaScript date range before ISO projection.
- Enforce the approved 1,800-second relay floor and reject inadequate resumed proof without
  bypassing pending cleanup.
- Verify Windows active reinstall through nonce-bound readiness and a changed listening port rather
  than PID inequality; describe the gateway readiness credential accurately in maintenance output.
- Preserve authored `omp.discoveryDir` and `omp.queryTimeoutMs` when an install changes the origin,
  allowlist, or port, without persisting omitted environment-derived OMP defaults.
- Start post-release OMP fixtures in their owned directory so discovery labels match the
  qualification target instead of the repository directory.
- Make the stable-release JSON schema version-generic while retaining exact runtime policy
  validation; a historical qualified lock cannot authorize a different release.
- Install the repository-pinned Bun in every CI job, including ephemeral fleet runners whose
  shared base image may carry an older runtime. Check this contract before running the suite.
- Run release-workflow shell fixtures without an undeclared host `jq` dependency, while preserving
  the shipped admission and publication decisions under a controlled command path.
- Accept an installed Android WebAPK resuming the collaboration route during post-release smoke,
  rather than incorrectly requiring the directory title or navigating away from the existing session.

The release entries below are **fork-era history**. Their patched OMP prerequisites, publication
credentials, exact commits, and qualification results apply only to the named historical artifacts,
not the current mainline prerequisite. They are preserved rather than reclassified as mainline proof.

## [v0.3.0] — 2026-09-09

### Added

- Phone-first Take photo / Choose existing composer in Control, with bounded metadata-free JPEG
  preparation, optional notes, previews retained until host acknowledgement, and read-only enforcement.

### Changed

- Require exact patched OMP v18.1.14 and Bun 1.4.0; carry native MathML and reconnect tail recovery.
- Qualify signed candidate v0.3.0-prealpha.3 independently on Debian 13 x86-64, Mac14,3 / macOS
  26.6.1 arm64, and Pixel 10 Pro / Android 17 / Chrome 152.0.7977.75. Fresh eight-hour relay
  endurance and 49-file runtime equivalence passed; no historical qualification transfers.
- Use v0.2.1 as the qualified gateway upgrade/rollback predecessor. Its separately activated OMP
  v17.4.1 prerequisite is not changed by gateway rollback.

### Fixed

- Preserve existing managed-install configuration unless explicitly overridden; fail closed on
  malformed configuration and reject browser-normalized unsafe Markdown link schemes.
- Correct provenance rehearsal parsing, stale prerelease notes, and ownership-safe Mac cleanup.
- Give patched-OMP qualification 8 GiB after the unchanged upstream check exhausted the 4 GiB
  host, retaining two CPUs, bounded execution, and mandatory teardown.
- Make unsafe-file fixtures independent of umask and remove redundant Windows ACL fixture work
  without widening the test timeout.

## [v0.3.0-prealpha.3] — 2026-09-08

### Changed

- Refresh the engineering OMP baseline to exact v18.1.14, including the standalone controller/publisher
  patch, wire package, browser source, native hashes, and Bun 1.4.0 toolchain. Published v0.2.1 and
  v0.3.0-prealpha.2 retain their original v17.4.1 evidence; no qualification transfers.
- Carry upstream native-MathML rendering and reconnect tail recovery into the pinned client, without
  KaTeX fonts, stylesheets, third-party runtime assets, or changes to the memory-only capability path.

### Fixed

- Reject browser-normalized unsafe Markdown link schemes, including tab-obfuscated JavaScript links.
- Repair provenance-rehearsal asset parsing and remove historical qualification claims from prerelease notes.
- Remove qualification-owned patched-OMP symlinks during Mac cleanup and detect dangling residue.
- Preserve existing managed-install configuration unless explicitly overridden; malformed configuration
  fails closed rather than being replaced with defaults.
- Remove the unshipped standalone client bootstrap and its process-wide React mock, closing the
  Linux ARM64 test-order leak without changing the shipped embedded client.
- Derive Mac qualification checks from the exact OMP pin and reject a stale Bun toolchain before
  host lanes; bind stable promotion to its qualified GitHub Latest predecessor.
- Align standalone Mac, Linux migration, and rollback helpers with the current candidate and
  predecessor so a manual invocation cannot silently qualify an obsolete pair.
- Keep Codecov's project status green across Bun's observed same-tree LCOV variance while retaining
  a blocking project gate for coverage drops beyond the two-point reporter-noise allowance.

## [v0.3.0-prealpha.2] — 2026-08-30

### Changed

- Make the Photo action explicitly offer **Take photo** and **Choose existing**. The camera path
  requests the rear-facing system camera while the library path remains an unrestricted image
  picker, avoiding Android's one-input camera-or-library ambiguity.

## [v0.3.0-prealpha.1] — 2026-08-29

### Added

- Add a phone-first photo composer to Control sessions: one tap opens the system camera/photo
  chooser, up to four previews stay beside an optional note, and the pinned OMP client sends the
  normalized images through its existing encrypted collaboration frame directly to the host.
- Reject source dimensions above an 8,192px edge or 20 megapixels, then re-encode JPEG, PNG, and
  WebP input in browser memory as metadata-free JPEG bounded to a 2,048px edge and 1 MiB per photo.
  The gateway, service worker, URLs, logs, and browser storage never receive the image; the
  normalized prompt follows ordinary OMP transcript and model-provider handling after send.

### Fixed

- Capture active composer pointers so a transient phone status row cannot move Send, Stop, or
  photo controls out from under a tap before release.
- Keep a photo and its note visible until the host transcript acknowledges the prompt; an
  interrupted send now preserves the exact draft and enables bounded Retry instead of forcing a
  retake.
- Enforce View/read-only state inside every mutating collaboration-client method rather than only
  through rendered control state.
- Preserve link-derived View state when an older host omits the optional welcome flag, suppress
  pending Ask-response replay after a read-only downgrade, and require the pre-send transcript
  baseline before any matching photo entry can acknowledge a draft.

## [v0.2.1] — 2026-08-28

### Changed

- Give working-session titles the full card width and move uptime, project, and model into one
  compact secondary row; show the useful model slug, remove wasteful flex gaps, strengthen title
  contrast, and replace the ambiguous × with a quiet 44px `Hide` action.
- Compress the all-clear state into the same left-aligned information grid as the directory,
  removing repeated live/working counts while preserving honest alert state.

### Fixed

- Report the true product version from managed installations and diagnostics: the published
  v0.2.0 archive still names its version directories, `status` output, and doctor bundles
  `0.1.0-<content-hash>` because two runtime constants sat outside the release version sweep.
  Install and rollback identity bind to the content hash and source commit, so behavior was
  unaffected; a version-coherence test now fails `bun run check` when any constant lags
  `package.json`.
- Prevent long session titles from colliding with Control and connection state in the mobile
  collaboration shell by giving the title its own full-width header row.
- Derive draft and published release asset names from the validated tag version; the first 0.2.1
  candidate failed closed after signing when draft validation still looked for 0.2.0 filenames.

## [v0.2.0] — 2026-08-28

### Added

- Restyle the couch-flow directory for phone-first triage: full-width session titles with a
  compact per-row **Dismiss here** control, sentence-case ask previews with option counts, a
  labeled **Requeue** control on held rows, a calm borderless **All clear** statement, and a real
  empty state when no session is live.
- Move background-alert control, notification detail, and build identity into one Settings bottom
  sheet behind a persistent masthead control; the seven exact alert states are unchanged, the
  toggle disables in place, and the resting screen claims "You'll get pinged" only while alerts
  are enabled.
- Precache the pinned collaboration client with the application shell, preload it from the
  document, and warm its module import while the directory idles, so View/Control taps pay only
  for the no-store launch request and relay connect; capabilities are still fetched only on tap.
- Render long transcripts incrementally in the embedded client: the initial snapshot defers to one
  loading placeholder until it completes, and the transcript windows to the newest entries with a
  **Show earlier** control instead of building the full history DOM at connect.
- Add device-local couch triage to the PWA: exact-ask **Hold for desk** preserves authoritative
  attention while advancing to the next request, and reversible **Dismiss here** hides a
  non-attention row on one device without stopping OMP.
- Add a fail-closed stable release policy: only the exact bare v0.1.0 tag selects the stable
  archive claim and GitHub Latest publication; every engineering, alpha, and beta tag remains a
  prerelease, and unknown or cross-version shapes fail before artifact creation.
- Require a signed-tag-bound stable qualification manifest plus a GitHub-verified annotated tag
  before stable publication; recheck checkout HEAD and tag target before provenance, draft creation,
  and public promotion. Move future signatures to signed-release.yml so the superseded historical
  tag workflow can be disabled.
- Retire historical GitHub workflow ID 316404456 with state deleted and activate hardened
  signed-release.yml as workflow ID 339848215, preventing old commits from selecting
  pre-remediation tag logic.
- Rehearse the exact six-asset GitHub draft/publish commands with gh 2.97.0 in a private repository:
  prerelease remained not-Latest, stable became non-prerelease Latest only when published, the
  latest-release API resolved to stable, and all synthetic releases/tags were removed.
- Validate draft and published release state through the GitHub API, including uploaded asset
  digests and Latest status; on a failed post-publication check, delete the release. A private live
  rehearsal verified draft, publication, deletion compensation, tag cleanup, and no residual release.
- Compare every GitHub asset digest to the exact locally signed file, retry draft/published state
  observation on bounded 0/2/4/8-second delays, and delete either a failed draft or an unverified
  public release. Move macOS sudo and Linux GitHub credentials from SSH argv/environment prefixes
  to a NUL-framed stdin bootstrap.
- Make physical Android acceptance browser-selectable and record the exact package, installed
  package version, Browser.getVersion revision, activity, and DevTools socket in evidence.
- Add prolonged-outage recovery guidance in a help panel carried by the loaded PWA shell. The PWA
  keeps its bounded retry path, suggests force-stop/reopen only after 45 uninterrupted seconds of
  visible failure, removes the guidance on recovery, and makes no third-party probe.
- Add a bounded post-release smoke command that verifies published stable provenance, upgrades or
  verifies the configured local Mac without changing config/token or unrelated Serve mappings,
  exercises exact patched OMP through an owned tmux fixture, and drives physical Android
  View/Control, forbidden-sink, same-page recovery, and installed-WebAPK checks before scoped cleanup.

### Changed

- Remove the completed implementation-handoff packet and consolidate its remaining contributor,
  attribution, backlog, and release guidance into maintained documents.
- Define stable 0.1 as support for the exact qualified Debian/macOS/Pixel/Tailscale/OMP matrix,
  not unnamed platforms or a promise that JavaScript can repair Chrome's process-wide network
  wedge. Windows, background Push qualification, Portal Tunnel, userspace networking, alternate
  relays, and paired OMP packaging remain explicitly outside this release.

### Fixed

- Keep Android Chrome's native EventSource reconnection alive after transport errors while retaining
  the bounded snapshot fallback, so a lost JavaScript timer cannot strand a long-lived PWA after
  Airplane mode or Doze. Physical qualification now reads rendered state without competing fetches
  and fails on any page reload.
- Make browser recovery failure tests wait for and assert an active replacement SSE stream before
  disconnecting it, eliminating a race where the snapshot hid the banner just before EventSource
  installation and the fixture's disconnect became a silent no-op.
- Let Android network recovery snapshots run for 20 seconds once a directory is loaded, and back
  repeated failures off with equal jitter to a 30-second ceiling instead of aborting and retrying
  every four seconds. This prevents reconnect churn from keeping a long-lived Chrome tab wedged
  after the phone's tailnet route returns.
- Harden stable qualification with durable Debian dispatch identity, same-commit receipts, restart-safe
  Mac cleanup, NUL-framed sudo transport, exact candidate/native-byte pins, workstation-staged rollback
  assets, bounded session paths, generic persisted failures, and zero-listener teardown evidence.
- Treat a ready Android directory with the owned target plus unrelated live sessions as recovered,
  and require disposable-target eligibility in the standalone capability leak sweep. The prior
  exactly-one-row probe falsely failed local post-release smoke while preserving unrelated sessions.
- Let the macOS patched-OMP helper consume an explicit pinned Bun executable and private build/native
  staging paths, so release smoke does not need to replace the user's global Bun runtime.
- Refuse a missing, unauthorized, or ambiguous adb device before post-release download, host
  mutation, or fixture startup instead of failing after an otherwise valid release setup.

## [v0.1.0-beta.1] — 2026-08-21

### Added

- Add deterministic, provenance-bound README media capture and verification, canonical mobile
  screenshots/GIF/MP4/product-flow assets, a product-first public README, a source-verified
  alternatives matrix, and draft launch copy. All public media uses seeded synthetic data.
- Record the protected default-relay replacement soak: the complete 28,800-second authored window,
  22 room transitions, final phase `live`, exit code 0, and no process restart.
- Add a fail-closed `beta` release channel. The release workflow accepts `v<version>-beta[.<n>]` and
  derives `OMP_RELEASE_CHANNEL=beta` only from that validated tag shape; `release-info.json` records
  a beta qualification that names the combinations recorded at the source commit and the exact
  patched OMP baseline while explicitly disclaiming stable or production readiness; and the
  conservative beta draft notes keep the Windows-unadvertised, Android network-change, and
  unsupported self-hosted/proxied relay caveats alongside the required exact OMP patch.
  `release-candidate` and stable tags stay rejected, pre-alpha and alpha archives stay
  byte-compatible, and the SBOM stays channel-independent.
- Qualify the exact signed beta candidate on Debian 13 x86-64, macOS 26.6.1 arm64, and Chrome
  151 / Android 17 on a physical Pixel 10 Pro; verify checksums, attestations, Cosign bundles,
  byte-identical rebuild, gateway lifecycle/capability isolation, exact patched-OMP source builds
  and real publication on both host architectures, alpha.1 gateway rollback-by-reinstall on Debian
  and macOS, manual exact-OMP symlink/config reversal, and a fresh default-relay smoke. Android
  radio recovery and background Push, Windows, Portal Tunnel, and self-hosted/proxied relays remain
  explicitly unadvertised.

### Changed

- Move the beta OMP baseline to exact `v17.4.1` /
  `9350b7990d26ebf69a604edc82d8558ef04adf30`, update `@oh-my-pi/pi-wire` to `17.4.1`, and
  regenerate the six-commit collaboration patch from the maintained downstream series plus the
  carried health-probe commit. The qualified route reproduced its patch tree, passed source checks,
  built a versioned binary, auto-published View/Control, and revoked on stop.
- Keep the exact tested v17.4.1 OMP patch as the beta installation prerequisite. Paired OMP
  signing/install/update/rollback stays deliberately deferred and is a disclosed limitation rather
  than a beta gate; stock OMP is never sufficient on its own. Published alphas remain immutable at
  their recorded v17.3.8 patch.

### Fixed

- Preserve OMP's immediate `Closing session…` status and arm its bounded slow-close timer before
  collaboration teardown; the v17.4.1 upstream regression test exposed the ordering defect during
  the patch rebase.
- Bind `release-info.json` qualification to the workflow-validated release channel, so alpha tags
  no longer ship the pre-alpha claim and unknown future channels fail before producing artifacts.
- Make pre-release candidate notes channel-neutral and bind them to the current OMP patch,
  advertised beta lanes, limitations, and `v0.1.0-alpha.1` rollback predecessor instead of the
  already-published alpha-point plan.
- Make the documented OMP binary route work on a fresh host without ambient Git identity or
  Rust/Cargo by supplying a scoped synthetic committer identity and staging the exact official
  `@oh-my-pi/pi-natives@17.4.1` platform addon before the upstream binary build; retain `bun setup`
  as the source-development alternative.
- Give Windows managed-service startup a measured 60-second hard readiness deadline while
  retaining 15 seconds elsewhere, so cold per-path ACL verification no longer rolls back a
  progressing service before it can bind. A persistent Server 2025 source lane now passes install,
  reboot→interactive-login startup, `doctor` 17/17, rotation, upgrade/rollback, patched OMP
  publication, and uninstall; Windows remains unadvertised until signed gateway/OMP artifacts
  repeat it.
- Reconcile every current beta support surface with candidate `.20`: replace stale alpha-era
  detailed matrix rows, narrow Push and Android outage promises, require exact Bun 1.3.14 for the
  qualified source route, name Portal Tunnel as unsupported, make gateway/OMP rollback separation
  explicit, scrub live identity/token/capability fingerprints from public evidence, and make the
  published-build verification recipe target `v0.1.0-beta.1` instead of a historical provenance
  test tag.

## [v0.1.0-alpha.1] — 2026-08-21

### Fixed

- Admit SSE consumers through an atomic registry snapshot/subscription handshake, serialize
  reentrant registry mutations, and isolate observer failures, so healthy consumers receive one
  snapshot followed by every later revision in strictly increasing order.
- Preserve a renewed Web Push subscription when an older in-flight delivery for the same endpoint
  fails permanently; stale cleanup now removes only the exact failed transport target.
- Return a collaboration page restored from the browser back/forward cache to the live session
  directory after its capability-bearing client has been disposed, rather than leaving an inert
  client shell or attempting to reuse the capability.
- Refuse install, stop, and uninstall before touching files or service-manager state when either a
  loaded manager identity or an unloaded definition belongs to another gateway installation root;
  an unavailable ownership probe now fails closed.
- Scope launch rate windows to the authenticated identity and operation instead of caller-selected
  instance IDs, preventing one allowed identity from exhausting bucket capacity for another.
- Clear systemd's start-rate counter before an explicit install or rollback restart, so several
  successful version switches cannot deadlock the next operator-requested recovery.

### Testing

- Cover identity-isolated launch rate windows, declared and streamed request-body ceilings,
  identity-scoped push deletion, reentrant registry ordering and observer failure, push-renewal
  races, file-only and manager-loaded service ownership, and capability-safe back/forward-cache
  restoration.

### Documentation

- Align the release and rollback guides with the published `v0.1.0-alpha` tag contract and the
  implemented `omp-gateway rollback [--to <version>]` command.

## [v0.1.0-alpha] — 2026-08-21

First advertised release. Qualified for Debian 13 (trixie) x86-64 and macOS 26.6.1 arm64 as hosts,
with Chrome `151.0.7922.139` on Android 17 as the client, and for nothing else. Both hosts were
qualified from a signed candidate whose executable surface is byte-identical to this release: all 46
files match, and the only differences are `sourceCommit`/`sourceCreated` in `release-info.json` and
the same commit and timestamp inside `SBOM.spdx.json`.

Requires Tailscale's **TUN-mode** client; the daemon refuses identity headers otherwise. Never enable
Tailscale Funnel. Android network-change recovery is a known limitation, Windows is implemented but
not advertised, and self-hosted or proxied relay modes remain unsupported.

### Added

- **Alpha decision is GO** for two host platforms and one client, against candidate
  `v0.1.0-prealpha.17`: Debian 13 (trixie) x86-64 and macOS 26.6.1 arm64 as hosts, with Chrome
  `151.0.7922.139` on Android 17 as the client. All six release blockers are closed. Nothing outside
  that combination is advertised, and the scope rule is unchanged: passing a platform permits
  advertising only that exact platform and version.
- Coverage reporting through Codecov, with the runtime's limits recorded in `codecov.yml` rather than
  left for a badge reader to misread: Bun emits **no** branch records at all and no per-function
  attribution, and it omits modules no test imports. `scripts/module-import-sweep.test.ts` imports
  every server-side module so an untested file becomes a visible row instead of an absent one, and it
  doubles as a smoke test for import-time side effects — which is how it found that
  `synthetic-publisher.ts` published sessions into a live gateway merely by being imported.
- `apps/gateway/test/security-mutations.test.ts` weakens seven named security guards in a copy of the
  tree and requires a specific named test to fail, so the suite demonstrates that its assertions
  discriminate rather than only that lines executed. A `find` pattern that stops matching is a
  failure rather than a skip, because a silently inapplicable mutation is worse than none.
- `runDoctorChecks` takes an injectable topology probe, closing a wiring gap an earlier commit
  recorded as unprotected in its own message.
- `doctor` now withholds `listenerLoopbackOnly` when tailscaled owns no TUN device. A loopback bind
  address is necessary but not sufficient, because userspace-networking `tailscaled` forwards inbound
  tailnet connections to localhost and the caller then arrives as a loopback peer that `auth.ts`
  trusts ([#98](https://github.com/alphastorm/omp-session-gateway/issues/98)).
- A scheduled capacity workflow and an evidence checker that compares machine-readable qualification
  records against the ledger, so a claim that contradicts its own measurement fails mechanically
  rather than relying on someone rereading a log.
- `omp-gateway rollback` is qualified on Linux, and a Linux lane now exercises the command itself
  rather than only rollback-by-reinstall.

### Security

- **The daemon now refuses to believe `Tailscale-User-Login` unless Tailscale's tunnel device is
  present.** `tailscaled --tun=userspace-networking` has no TUN device, so its netstack forwards
  inbound tailnet connections to localhost; a listener bound strictly to `127.0.0.1` was therefore
  reachable from the whole tailnet, and the caller arrived as a loopback peer whose forged identity
  header was trusted verbatim. Demonstrated against a real host, from a distinct tailnet node, on a
  build whose listener was correctly loopback-bound
  ([#98](https://github.com/alphastorm/omp-session-gateway/issues/98)).

  In `tailscale-serve` mode the gateway now reads the host's interface table and returns `403` to
  every request unless an interface carries an address in `fd7a:115c:a1e0::/48` or a
  `100.64.0.0/10` host route on a tunnel-named interface. `100.64.0.0/10` alone is not accepted: RFC
  6598 assigns it as shared space that carriers and container networks also use, so a CGNAT address
  on an ordinary interface proves nothing. `doctor` gains `loopbackTrustSound`, and an admitted SSE
  stream is re-authorized on each keepalive so a feed cannot outlive the topology that justified it.

  **This is a behaviour change.** A host running userspace-mode `tailscaled` now receives `403`
  instead of working; that configuration was never supported and is the vulnerable one.
  `auth.trustIdentityWithoutTailnetDevice` exists for loopback-only harnesses on machines with no
  Tailscale installed, logs `http.identity_trust_declared` whenever it is set, and cannot influence
  what `doctor` reports. Note that a config carrying that key will **not** load on an older gateway,
  which rejects unknown `auth` keys, so a host that sets it cannot roll back without editing config.

- `SECURITY.md` now names userspace-mode `tailscaled` as a forwarder that defeats loopback trust.
  This was previously implied by a general rule about tunnels and reverse proxies; it is now stated
  explicitly because it is the forwarder an operator is most likely to run, and because it was
  demonstrated as a working remote authentication bypass against a real host.

- Bumped `actions/attest-build-provenance` from v2.4.0 to v4.2.2, two majors on the action that
  produces release provenance. Validated by a tag run rather than a pull-request check, because
  `release.yml` executes only on tag pushes and a green check on the pull request would have proved
  nothing about the attestation path. `provenance-test-v0.1.0.11` published six assets whose
  checksums, three GitHub attestations and three Cosign bundles all verified independently from a
  clean directory, with a byte-identical rebuild from the exact tag.

### Known limitations

- Recovery after an abrupt radio transition on Android may require force-stopping Chrome.
  Chrome-for-Android wedges its own network stack browser-wide while the device remains healthy, so
  network-change and reconnect are not proven
  ([#65](https://github.com/alphastorm/omp-session-gateway/issues/65)).
- Windows is implemented and partly qualified but not advertised
  ([#90](https://github.com/alphastorm/omp-session-gateway/issues/90)).
- Self-hosted and proxied relay modes remain unsupported.

### Fixed

- Mirror the upstream fix for the silent publisher latch
  ([#61](https://github.com/alphastorm/omp-session-gateway/issues/61)) as the sixth commit of the
  OMP handoff patch. `CollabRegistryPublisher` latched publication off in one place and never reset
  it, and its setup `catch` treated every error that was not `ENOENT`/`ECONNREFUSED` as a security
  event, so a transient publisher-token read was indistinguishable from a real privacy violation.
  Because `CollabController` builds the publisher once behind `??=`, `/collab stop` then `/collab`
  reused the latched instance, and a live session stayed absent from the directory for the rest of
  the OMP process lifetime while the daemon reported healthy. Only a deterministic
  `PublisherSecurityViolation` now latches; everything else retries with backoff, a manual
  `/collab` resumes, and `/collab status` reports the publication state.

- Re-bind the registry socket when its path disappears underneath the daemon. macOS reaps idle
  per-user `TMPDIR` entries, which deleted `registry.sock` and its parent directory while Bun kept
  listening on the unlinked inode, so every OMP publisher failed to connect with `ENOENT` and no
  session could ever appear. The daemon now records the bound device/inode, re-checks the path every
  15 seconds, and recreates the private runtime directory and listener when the path is gone. A path
  owned by a different inode is reported as unhealthy instead of being clobbered.
- Report `status: "degraded"` from `GET /api/v1/health` when publishers cannot reach the registry
  endpoint. Readiness previously proved only that the HTTP listener answered, so a daemon that no
  publisher could reach still passed `status`, `doctor`, and install readiness checks.

### Changed

- Refresh the OMP pin from `v17.0.6` / `89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6` to `v17.3.8` /
  `858f7dd91fff9b84cf8a2c6a6bb85aa0e6d03a55`. The previous mbox no longer applied
  (`interactive-mode.ts`, `agent-session.ts`, `session-manager.ts`, and `builtin-registry.ts`
  conflicted), so it is regenerated as five commits reproducing tree
  `1320e3e7e7596dbe2f6a130d568072a9a38f2943`. The first four are the reviewed handoff artifact
  `gateway-collaboration-v17.3.8.mbox` (sha256 `f63f74c9…`) applied verbatim; the fifth restores the
  health-probe commit the maintained series no longer carries. `@oh-my-pi/pi-wire` moves to `17.3.8`; `collab-web`
  stays at package version `16.3.6` with refreshed source.
- Re-vendor the pinned collab client onto `v17.3.8`. Only `Composer.tsx` needed manual resolution
  (upstream added `RefObject` and composition handlers; the gateway had added `useMemo` and
  `disabled`); all eleven prior local patches survived unchanged. The client keeps npm `marked`
  rather than upstream's new `@oh-my-pi/pi-utils/marked`, because that import pulls
  `@oh-my-pi/pi-natives` and its per-platform binaries into a previously pure-JavaScript runtime
  closure. The `Marked` API is identical, so the divergence is one import line.
- Reset every native, Tailscale, relay, Android, browser, and signed-artifact ledger row to
  **NOT RUN** for the new pin. Only source-level evidence was regenerated; the previous pin's
  platform qualification does not transfer.

### Testing

- Scale the OMP publisher fixtures' per-test and handshake budgets by platform. Every Windows
  publisher-token fixture is secured, and the publisher's token ACL validated, by spawning
  `powershell.exe`; hosted runner images made that spawn cost seconds rather than milliseconds, so
  the file's first test — which pays two cold starts — exceeded the 5-second default and the
  2-second handshake budget while asserting security behavior that had not regressed. The patch is
  regenerated, so its five commit SHAs changed.
- Drive a virtual clock in the collab-client fake-timer harness. `CollabSocket` schedules its idle
  relay probe as `lastRelayActivityAt + RELAY_IDLE_PROBE_MS - Date.now()`, and `#commit()` runs
  between the two reads, so faking `setTimeout` while leaving `Date.now()` on the wall clock let
  real milliseconds shorten the delay to `9_99x`. The relay-probe test failed roughly one full-suite
  run in six. The clock now advances only when a fake timer fires; injecting 3 ms of real work into
  `#commit()` reproduced `9997` before the change and `10000` after.

## [0.1.0-prealpha.14] - 2026-07-26

### Added

- Measure the same-origin gateway path with adaptive probes and the encrypted browser-to-host relay
  path with optional idle ping/pong frames; ordinary host traffic provides passive relay liveness
  between explicit bidirectional probes.
- Keep submitted Ask actions in a disabled `Sending…` state until the host acknowledges
  `ui-request-end`, including idempotent resend and acknowledgement after relay reconnection.

### Changed

- Keep healthy collaboration chrome quiet as a green dot. Brief interruptions show only
  `Reconnecting…`; failures lasting three seconds identify the gateway or relay and show the next
  jittered retry, while recovery confirms `Connected` briefly.
- Replace fixed gateway polling and deterministic reconnects with RTT-adaptive timeouts,
  two-result hysteresis, passive liveness, hidden-page probe cancellation, bounded WebSocket
  handshakes, and capped full-jitter retry scheduling. Directory metadata cannot replace `Sending…`
  with `Answered` before host acknowledgement. The existing no-secret service worker remains
  deliberately unchanged; Workbox and Background Sync add no safe value to the capability-bearing
  live path.
- Stop collaboration path probing as soon as the client becomes terminal so the final action and
  keyboard focus remain stable. Standalone select responses now retain the chosen option and expose
  the same visible, polite `Sending…` acknowledgement state as the embedded PWA shell.

### Testing

- Exercise gateway hysteresis/timeouts, event-cancelled probes without false degradation, recovery
  without an `online` event, hidden-page relay cancellation, blackholed WebSocket handshakes,
  relay idle-probe failure, stale-pong rejection, full-jitter retry caps, delayed snapshot sync,
  response resend/acknowledgement, acknowledgement-gated answer feedback in embedded and standalone
  modes, terminal focus and probe shutdown, quiet accessible healthy chrome, keyboard triage
  dismissal, outage attribution changes, recovery confirmation, and unobscured `Sending…` feedback
  at both Android viewports.

## [0.1.0-prealpha.13] - 2026-07-26

### Fixed

- Match the approved Couch Flow 3d client body: remove the embedded client's competing header and
  agent rail, keep one transcript/composer, and render the active Ask as the native input card with
  numbered radio rows, explicit selection, recommendation badge, and green `Send` action.
- Complete all four shell triage states. Answer feedback remains dismissible; relay reconnection
  and clean session end now remain visible below the composer with exact copy, status markers, and
  the specified return action.
- Center the shell title independently of its left/right controls and keep every top-bar target,
  composer inset, and bottom safe-area boundary intact at both approved Android viewports.

### Security

- Keep the collaboration capability confined to the pinned client's in-memory bootstrap while the
  gateway shell receives lifecycle state only; no capability enters shell markup, URLs, history,
  storage, caches, or diagnostics.

### Testing

- Exercise embedded Ask selection/submission, recommendation ownership, transient relay recovery,
  clean ended-session feedback, absent duplicate chrome, and non-overlapping composer/triage
  geometry at 390×844 and 412×915.

## [0.1.0-prealpha.12] - 2026-07-26

### Fixed

- Implement the approved Couch Flow 3d shell as one fixed frame: gateway top bar, the untouched
  pinned collaboration client, and an answer-only bottom triage bar below the composer.
- Remove the embedded client's connecting window and ended-session popup; connection lifecycle is
  represented only by the shell's Connected, Reconnecting, or Offline chip.
- Show triage feedback only after the exact opened request resolves, then dismiss it after eight
  seconds, tap-out, or swipe without covering the composer or its safe-area inset.
- Route direct and historical `/client/` navigation back through the PWA directory and stop
  shipping the obsolete popup/MessageChannel bootstrap.

### Security

- Continue passing the launch capability directly into the pinned client mount in memory without
  adding it to shell state, DOM, URL, history, browser storage, or service-worker caches.

### Testing

- Exercise the exact three-child shell frame, single transcript/composer/interrupt controls,
  lifecycle-popup suppression, answer-only triage, composer geometry, Back restoration, and direct
  `/client/` recovery at both Android viewport sizes.

## [0.1.0-prealpha.11] - 2026-07-26

### Fixed

- Match the approved couch-flow resting screen exactly: remove the explanatory lede and footer,
  keep background-alert settings below the session directory, and restore all-clear state, list
  order, and scroll position immediately from route-safe history state.
- Drive the collaboration shell's Connected, Reconnecting, Offline, and ended states from the
  pinned client's lifecycle instead of rendered-text inspection; focus request Control on the
  pending composer and keep all four triage states outside its viewport.
- Complete answer feedback with exact next/all-clear copy, eight-second expiry, tap-out and swipe
  dismissal, and authoritative request-resolution gating.
- Use the exact phone, tailnet, desktop, and relay failure copy while preserving timestamped,
  authenticated session metadata through transient transport failures.

### Security

- Bind every request-specific Control launch to both generation and opaque request ID at the final
  capability lookup, closing the same-generation clear/re-arm race for home, shell, triage, and
  notification launches.

### Testing

- Exercise one through six asks, all-clear, every failure banner, exact shell lifecycle and triage,
  composer inset, request-bound Control, and cache-first Back behavior at 390×844 and 412×915.

## [0.1.0-prealpha.10] - 2026-07-26

### Added

- Complete the approved Couch Flow handoff with whole-screen waiting/all-clear modes, FIFO ask
  ordering, boolean fallback, whole-row session actions, exact collaboration-shell triage, and
  capability-free directory order/scroll restoration.
- Add per-device Private, Session, and Preview notification detail with a mobile bottom sheet,
  server-built payloads, exact-request clearing, one notification per session, app badge counts,
  and notification-to-Control request routing.

### Fixed

- Distinguish phone-offline, tailnet-unreachable, desktop-unreachable, and relay-reconnecting states
  while retaining the last authenticated directory with a freshness timestamp.
- Remove the prominent manual Refresh control; liveness detection, bounded reconnect, and PWA
  activation now own routine recovery.

### Security

- Derive opaque ask identities in gateway memory without changing the capability-bearing publisher
  contract; revalidate the exact ask and generation before every notification-launched Control.
- Keep collaboration capabilities out of push state and payloads, notification data, URLs, history,
  browser storage, caches, logs, and diagnostics while limiting optional visible detail to the
  level selected for each device.

## [0.1.0-prealpha.9] - 2026-07-26

### Fixed

- Show an accent `Recommended` badge on the explicitly recommended option while an Ask request is awaiting a remote Control response, including late joins, without treating OMP's default selection index as a recommendation.

## [0.1.0-prealpha.8] - 2026-07-25

### Added

- Replace the mixed session-card dashboard with the approved ask-first couch flow: a FIFO boolean-only attention queue, gold request hero, compact working rows, and an all-clear resting state.
- Wrap the pinned collaboration client in gateway chrome with Sessions navigation, View-to-Control upgrade, relay state, in-memory directory/scroll restoration, and authoritative answer/ended triage bars.

### Fixed

- Recover dashboard sessions automatically across half-open Wi-Fi/Tailscale transitions by closing silent SSE streams after 12 seconds, timing out snapshots after 4 seconds, and retrying on bounded 1/2/4-second backoff.
- Refresh an active collaboration relay transport after browser network changes or a failed-then-recovered 3-second same-origin health probe, without persisting or transmitting a collaboration capability.
- Activate changed PWA shells automatically without a manual Refresh: idle directories reload through a scrubbed no-store update route, while pending or active collaboration defers the new document until ordinary failure recovery, Back, or Leave.
- Run Playwright through a cross-platform Bun wrapper that clears the conflicting `NO_COLOR` value before worker startup when the harness forces color, removing Node's ignored-environment warning without suppressing other warnings.

### Security

- Keep the redesign on the existing metadata-only `inputRequired` contract: no prompt previews, request IDs, collaboration capabilities, URLs, storage, or service-worker payloads were added.

### Changed

- Record the user-reported physical Android `v0.1.0-prealpha.7` core background-Push flow as partial evidence while keeping exact-version lock-screen, force-stop, stale-generation, network-change, and forbidden-sink qualification open.

## [0.1.0-prealpha.7] - 2026-07-24

### Fixed

- Correct the release install/upgrade and rollback instructions to include the CLI's required `--origin` and `--allow` values. The signed `v0.1.0-prealpha.6` artifact remains valid, but its published install command was incomplete.

## [0.1.0-prealpha.6] - 2026-07-24

### Added

- Add explicitly enabled background Web Push using private persisted VAPID/subscription state, strict metadata-only attention/resolution payloads, duplicate collapse, resolution cleanup, and stale-endpoint pruning.
- Add one-tap notification-to-Control routing through a synchronously scrubbed metadata-only path, exact current-generation/attention validation, and the existing no-store in-memory capability launch.

### Security

- Keep prompt/session labels, paths, request data, transcript content, and collaboration capabilities out of push state, payloads, visible notification text, routes, history, service-worker messages, logs, and diagnostics.
- Treat browser push endpoints/keys and the VAPID private key as bounded user-only state; retain the session registry and collaboration capabilities in memory only.

### Changed

- Recorded the signed `v0.1.0-prealpha.2` recovery relay soak as passed after 28,800 seconds, eight room transitions, a live final phase, no restart, and a 720 KiB gateway RSS increase; physical Android relay qualification remains open.
- Recorded the corrected `v0.1.0-prealpha.4` physical trial on Pixel 10 Pro / Android 17 / Chrome 150: installed-PWA View/Control/Back, exactly-once retained response, attention clearing, metadata-only foreground and lock-screen notification, dashboard-only notification tap, lock/resume, network transition, relay reconnect, generation replacement with stale `409`, and TTL removal/republication passed. Distinct-device denial, deep browser-sink inspection, physical interrupt, remaining switch/branch/resume cases, and signed host release qualification remain deferred.
- Recorded the signed `v0.1.0-prealpha.5` physical Android three-process and silent-partition trial plus a 50-publisher capacity run: all three real OMP cards appeared automatically, Airplane mode cleared them by the 40-second observation after the configured 35-second deadline, and recovery restored exactly three, while 50 normal-cadence publishers averaged 0.125% of one CPU core and stayed below 63 MiB observed daemon RSS.

## [0.1.0-prealpha.5] - 2026-07-21

### Fixed

- Replace opaque SSE comment pings with metadata-free `keepalive` events and clear session cards after two missed heartbeats, so silent Android/Tailscale network partitions cannot leave stale sessions visible.
- Fetch a fresh authoritative snapshot when transport resumes; physical Android testing covered three real auto-published OMP sessions, Airplane-mode loss, bounded stale-state clearing, and automatic three-card recovery without Refresh.

## [0.1.0-prealpha.4] - 2026-07-21

### Fixed

- Mount the collaboration client in the installed PWA's current document so Android Chrome cannot discard the in-memory capability handoff by reusing a standalone window without `window.opener`.
- Preserve the separate same-origin `MessageChannel` bootstrap only as an ordinary-browser fallback, with Android-sized View/Control launch, back-navigation, URL, history, storage, cache, and no-popup regression coverage.

## [0.1.0-prealpha.3] - 2026-07-21
### Added

- Publish a strict metadata-only `inputRequired` boolean, surface attention-first session cards, and retain bounded host-origin response requests so a later Control guest can answer once while View remains read-only.
- Add explicitly enabled foreground browser notifications for authoritative false-to-true attention transitions; permission is never requested on load, state remains volatile, and notification taps return only to the dashboard.
- Add deterministic dashboard/service-worker tests and Android-sized Playwright coverage for attention ordering, stale-state clearing, notification dedupe, click routing, and forbidden-content canaries.

### Changed

- Pin the OMP integration and collab-web source to `can1357/oh-my-pi@89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6` (nearest release v17.0.6).
- Split the downstream OMP artifact into four reviewable commits covering controller/publisher integration, bounded pre-writer request retention, generation-scoped response-required publication, and collaboration-aware response UI/startup ordering.

### Security

- Keep prompt text, options, prefills, answers, request IDs/types/counts, and collaboration capabilities out of IPC metadata, list/SSE responses, DOM copy, notifications, service-worker messages, storage, caches, logs, diagnostics, screenshots, and traces.
- Authenticate Windows named-pipe servers with the same nonce-bound mutual HMAC handshake used on POSIX before the publisher sends any proof or capability-bearing frame.


## [0.1.0-prealpha.2] - 2026-07-21

### Fixed

- Recover established collaboration guests across transient relay room replacement with bounded exponential retries while keeping initial missing rooms and exhausted recovery terminal.

## [0.1.0-prealpha.1] - 2026-07-21

### Added

- Versioned protocol package with strict publisher, metadata, SSE, launch, and secret-separation validation.
- Authenticated local IPC registry, generation revocation, monotonic TTL expiry, publisher bounds, and privacy-safe logging.
- Loopback HTTP API with Tailscale identity allowlisting, exact-Origin launch protection, SSE, security headers, and no-store responses.
- Mobile PWA with live session states, explicit View/Control actions, safe back behavior, and shell-only service-worker caching.
- Pinned OMP collab-web source with direct in-memory one-time `MessageChannel` capability bootstrap.
- Apply-ready OMP `CollabController`, auto-start, local publisher, lifecycle revocation, and test patch.
- Cross-platform user-service definitions and management commands for install, uninstall, status, doctor, token rotation, and Serve guidance.
- Deterministic redacted diagnostics archives and Bun-runtime release archives with SPDX 2.3 dependency inventories and SHA-256 manifests.
- Keyless GitHub OIDC build attestations and Cosign signatures with immutable tag-triggered pre-alpha releases and documented verification.
- Unit/integration coverage for protocol, registry, IPC, HTTP authorization and launch, config permissions, services, diagnostics, and capability leaks.
- Explicit compatibility/support matrices and a release-status gate ledger separating implemented, smoke-tested, qualified, and supported claims.
- Protected `main` with signed commits, pull-request/CI gates, immutable releases, dependency alerts, automated security updates, secret scanning, and push protection.
- Loopback-only, no-store-enforcing default-relay soak harness with bounded duration and secret-free results.

### Changed

- Replaced handoff-only `bun run check` with TypeScript, browser/client build, full test, handoff, and capability-leak gates.
- Pinned the research baseline to OMP commit `39c95e5e29b1c8b082059f57421ce445c3dffdd4` (nearest release v17.0.5).
- Kept all platform and Android support entries unadvertised until real-device and cross-OS acceptance passes.
- Qualified the final source-review-hardened OMP patch in the complete pinned upstream checkout; checks and every official TypeScript test bucket passed with documented upstream-baseline exclusions restored afterward.
- Completed an eight-hour default-relay endurance run: the read-only client remained connected for 28,804 seconds and finished in the live phase.
- Published and independently verified the immutable provenance-test `provenance-test-v0.1.0.8` from the post-soak `main` commit, including deterministic archive/SBOM/checksum reproduction, GitHub build attestations, Cosign bundles, and immutable release-asset attestations.
- Published and independently verified immutable provenance-test `provenance-test-v0.1.0.9` from protected `main`, including the mutual-authentication and reconnect hardening, current hosted Windows qualification, byte-identical exact-tag archive/SBOM/checksum reproduction, GitHub build attestations, Cosign bundles, and a signed-artifact macOS packaging/runtime smoke through Tailscale Serve; native lifecycle and physical Android gates remain open.
- Published and independently verified corrected immutable provenance-test `provenance-test-v0.1.0.10` from protected `main`, including host-suspension reconnect recovery, current hosted Windows qualification, byte-identical exact-tag archive/SBOM/checksum reproduction, GitHub build attestations, Cosign bundles, and signed-artifact macOS Serve, restart, patched-publisher, and finite-suspension smoke; native lifecycle and physical Android gates remain open.
- Documented the distinct product boundaries and best-fit workflows for OMP Session Gateway and `omp-deck` without presenting either as a universal replacement.
- Adopted the dark-first Gate visual identity across the PWA and repository, including installable platform icons, accessible View/Control hierarchy, branded social artwork, and a normative brand specification.

- Made production install a config/service/runtime transaction with prior-endpoint checks, instance-bound HMAC readiness, verified legacy-runtime rollback, exact external Serve-port guidance, and recovery uninstall that does not require a readable application config.

### Fixed

- Kept Bun's HTTP idle timeout above the SSE keepalive interval so live updates do not cycle through reconnect state.
- Close authenticated publisher sockets without a protocol-error payload after idle expiry or missing heartbeat state so the existing bounded reconnect path republishes sessions after host suspension; isolated launchers can now select the publisher-token file without replacing child-tool XDG configuration.
- Refresh the active gateway card's bounded title, directory basename, and `provider/model` metadata after live OMP name, working-directory, or model changes without rotating its generation or capabilities.
- Redirect direct, reloaded, invalid, and BFCache-restored collaboration client documents to the secret-free session directory; discard stale reconnect sends and emit a fresh guest hello before current-generation frames.
- Force a fresh collab relay transport after mobile foreground and online transitions so suspended sockets cannot remain silently stale.
- Revoke the active OMP collaboration generation before session mutation, keep manual hosts stopped when auto-start is off, force explicit relay replacements, and revoke/re-publish same-relay View/Control mode changes.
- Harden Windows config and publisher-token paths with current-user/SYSTEM-only ACLs, write Task Scheduler XML as UTF-16, run Bun directly, and wait for exact task termination during reinstall and uninstall without exposing a loopback shutdown credential.
- Bound unauthenticated IPC handshakes and authenticated publisher idleness so stalled local clients cannot exhaust publisher capacity; partial frames now use fixed-capacity buffers that are scrubbed on release.
- Made unsafe-permission test fixtures independent of the invoking shell's `umask`.
- Bound registry authentication, frame buffering, idle connections, publisher slots, private config/token reads, diagnostics command output, and launch-path decoding; verify POSIX publisher endpoint ownership; reject cross-connection instance replacement; and derive Windows pipe names from a normalized stable user identity.
- Authenticate both registry peers with fresh nonces and domain-separated HMAC proofs before capability release; never send the publisher key over IPC; reject replayed proofs and fake named-pipe servers; and enable the OMP publisher's current-user Windows named-pipe path with strict token ACL validation.
- Detect bare default-relay capabilities in leak scans and redact malformed collaboration capabilities from parser errors so they cannot enter logs or crash reports.
- Authenticate loopback startup/doctor readiness with a publisher-token HMAC challenge so another local account cannot satisfy install health checks by pre-binding the configured port.
- Stage immutable content-addressed gateway runtimes, verify their manifests and payload digests across version upgrades, idempotently reuse a verified payload during Windows reinstall, preserve the prior runtime for rollback, and retain the fresh publisher token while stopping the service if rotation restart fails.
- Ship `bun.lock`, its SHA-256, the embedded SPDX inventory, complete reviewed license texts, and the distributed OMP coding-agent patch component in deterministic release archives.
- Detect raw extensionless publisher-token files, percent-encoded legacy collaboration links, and contextual publisher-token JSON/file leaks in staged release payloads and CI leak gates.
- Reject unknown CLI options, missing values, and query-bearing API/static requests before mutation or cache admission; rate-limit repetitive denial/protocol logs; bound readiness response bodies; order PWA snapshots and SSE events by connection epoch and revision; clear stale metadata on transport loss; distinguish empty, unauthorized, offline, unavailable-action, and busy states; and arm the client handoff before capability fetch so an immediately ready collaboration window cannot race launch.
