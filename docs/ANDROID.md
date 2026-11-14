# Android client: physical qualification and strategy

This runbook is for release maintainers running physical Pixel qualification lanes and for contributors reviewing the Android client strategy for OMP Session Gateway, the companion to Oh My Pi (OMP). Both the physical browser-recovery and collaboration lane and the physical background-Push lane run on a USB-attached Pixel in every release campaign; see [Current claim](COMPATIBILITY.md#current-claim) and [Release status](RELEASE_STATUS.md).

A **View** or **Control** link is a bearer secret, called a capability in the contracts, that opens one session (a running interactive `omp` process shared for collaboration) without storing the secret in URLs, browser storage, or notifications.

## Browser-process recovery and physical qualification

Run [`scripts/android-acceptance.ts`](../scripts/android-acceptance.ts) and its sibling physical-client scripts to qualify session discovery, launch authorization, same-page lock/Airplane/Doze recovery, live **View** and **Control** collaboration, and capability-sink cleanliness over USB `adb` and the Chrome DevTools Protocol (CDP).

Before running the lane, confirm these prerequisites:

- Run `bun install --frozen-lockfile` with Bun `1.4.4` on `PATH`, and ensure local `adb` TCP port `9222` is free.
- Complete the one-time Tailscale (`com.tailscale.ipn`) Doze allowlist, connect Wi-Fi on the Pixel, turn off hotspot, USB, and Bluetooth tethering, and confirm the Pixel reaches the gateway's Tailscale Serve HTTPS origin (`$ORIGIN`, with no trailing slash or path, such as `https://host.example.ts.net`, and the Pixel's login in `auth.allowedLogins`); see [Device admission and one-time WebAPK setup](#device-admission-and-one-time-webapk-setup). Do Not Disturb may stay on during this lane.
- Connect one USB-authorized Pixel (`adb devices`) and store its 4–16-digit numeric lock-screen PIN in macOS Keychain under the device's `adb` serial (keep `-w` last so `security` prompts interactively instead of placing the PIN in shell history or `argv`):

  ```sh
  security add-generic-password -a '<adb-serial>' -s 'omp-session-gateway.android-qualification-pin' -U -w
  ```

  Never pass the PIN through an environment variable, command argument, file, log, receipt, or CI secret. Pattern unlock is unsupported because `adb`'s single swipe command cannot reproduce arbitrary multi-segment patterns.
- On the gateway host, start one fresh disposable interactive `omp` session (`collab.autoStart` set to `control`) in a uniquely named working directory whose basename is `$DISPOSABLE_SESSION_LABEL` (`cwdLabel`; the smoke and leak-sweep scripts require one match). [`scripts/acceptance-target.ts`](../scripts/acceptance-target.ts) refuses labels matching `soak`, `relay`, `monorepo`, `dotfiles`, or `alpha-founder`, and refuses sessions older than 30 minutes without `--disposable-target`.

1. Run the physical acceptance and recovery matrix against `"$ORIGIN"` and `"$DISPOSABLE_SESSION_LABEL"`:

   ```sh
   bun scripts/android-acceptance.ts "$ORIGIN" "$DISPOSABLE_SESSION_LABEL"
   ```

   The driver defaults to stable Chrome (`com.android.chrome`, `com.android.chrome/com.google.android.apps.chrome.Main`, and `localabstract:chrome_devtools_remote`, forwarded on local TCP port `9222`). Alternate Chromium channels require `OMP_ANDROID_BROWSER_PACKAGE`, optional `OMP_ANDROID_BROWSER_ACTIVITY`, and explicit `OMP_ANDROID_DEVTOOLS_SOCKET`:

   ```sh
   OMP_ANDROID_BROWSER_PACKAGE=com.chrome.canary \
   OMP_ANDROID_BROWSER_ACTIVITY=com.chrome.canary/com.google.android.apps.chrome.Main \
   OMP_ANDROID_DEVTOOLS_SOCKET=localabstract:chrome_devtools_remote \
   bun scripts/android-acceptance.ts "$ORIGIN" "$DISPOSABLE_SESSION_LABEL"
   ```

2. Run the collaboration journey and capability-sink sweep against the same disposable session (as the `android` lane in [`scripts/stable-qualification.ts`](../scripts/stable-qualification.ts) does; pass `--expected-app-asset /assets/app.<hash>.js` to pin an expected build asset, or `--disposable-target` to override the 30-minute age check):

   ```sh
   bun scripts/android-collab-smoke.ts "$ORIGIN" "$DISPOSABLE_SESSION_LABEL"
   bun scripts/android-leak-sweep.ts "$ORIGIN" "$DISPOSABLE_SESSION_LABEL"
   ```

`android-acceptance.ts` runs seven ordered stages (`ANDROID_ACCEPTANCE_STAGES` in [`scripts/android-stages.ts`](../scripts/android-stages.ts)):

1. `target preflight`: rejects protected labels before any network call, then reads `GET /api/v1/sessions` to confirm the target is published and eligible.
2. `Android Chrome`: checks device preconditions and gateway reachability, captures the radio baseline (`wifi_on`, `mobile_data` or active-SIM `mobile_data<N>`, and `airplane_mode_on`), wakes and unlocks the display (`isKeyguardShowing=false` via one `adb shell` stdin stream), starts Chrome out of `CACHED_EMPTY`, and requires the forwarded `/json/version` metadata (`Android-Package`, `Browser`, `ws://127.0.0.1:9222/devtools/browser…`) and `Browser.getVersion` to match the selected package.
3. `authorization matrix`: opens an owned tab at `<origin>/`, exercises `POST /api/v1/sessions/:instanceId/launch` for live **View** (`200`), live **Control** (`200`), stale **View** (`generation + 5`, `409`), stale **Control** (`generation + 5`, `409`), invalid `generation` (`0`), and an unknown session (`404`) with `Cache-Control: no-store`, and records `baselineReady` and `pageTimeOrigin`.
4. `lock resume`: locks the screen (`keyevent 26`) for 20 seconds, wakes and unlocks the phone, brings the owned tab to the foreground (`document.visibilityState === "visible"`), measures same-page directory recovery within 36 seconds without issuing competing fetches, and polls `Current Networks:` in `dumpsys connectivity` up to 60 seconds (1-second intervals, 5-second `adb` read bound; `httpsProbed: false` mid-journey; ICMP does not decide VPN recovery) for a connected VPN.
5. `airplane recovery`: enables Airplane mode, requires a rendered outage status banner (`outageBanner: true`) across up to twelve 5-second probes, disables Airplane mode, measures same-page recovery within 160 seconds plus a 10-second settled recheck, and verifies VPN recovery without opening tabs or disturbing DevTools forwards.
6. `doze recovery`: unplugs battery emulation and forces deep Doze (`dumpsys deviceidle force-idle`) for 20 seconds, exits Doze and resets battery emulation, measures same-page recovery within 48 seconds, and verifies VPN recovery.
7. `verdict` (after restoration): restores and reads back the exact radio baseline (enabling mobile data only after Wi-Fi validates within 45 seconds when both started on, so a phone that started with mobile data off finishes with it off), exits Doze and resets battery emulation, proves public DNS resolution (`android.clients.google.com`), and proves the tailnet path with VPN presence plus one owned 15-second `/api/v1/health` HTTPS navigation (`AndroidTailnetRecoveryError` on failure).

A passing `android-acceptance.ts` run prints JSON with `serial`, `packageName`, `androidPackageVersion`, `browserVersion`, `devtoolsSocket`, `browserActivity`, `authorization`, `baselineReady: true`, `appAsset`, `samePage: true`, `unlockMs`, `outageBanner: true`, `airplaneRecoveredMs`, `airplaneDeviceReachableMs`, and `dozeRecoveredMs`, and exits `0`.

`android-collab-smoke.ts` records `viewReadOnly: true`, `controlWritable: true`, `promptAccepted: true`, and `returnedToDirectory: true`. `android-leak-sweep.ts` plants a synthetic secret across all seven browser sinks (`localStorage`, `sessionStorage`, `cookie`, `cacheBody`, `indexedDB`, `locationHash`, `historyState`), requires `planted 7, detected 7` with zero residue, and verifies a real **View** capability is absent from all seven sinks, resource timings, and the DOM.

Every restoration step runs after success or failure, and restoration errors are reported alongside any phase failure rather than replacing it; if the process is killed before restoration runs, inspect and restore the Pixel's radios, Doze state, and Tailscale VPN before replaying.

Chrome on Android can wedge its network service after a radio transition while Android retains a working route and Chrome stops answering its DevTools socket until force-stopped and reopened ([#65](https://github.com/carrythroughsystems/omp-session-gateway/issues/65)).

**OMP Sessions** keeps bounded retries and opens **Troubleshooting** in the loaded shell after 45 uninterrupted seconds of visible failure ([When something looks wrong](USAGE.md#when-something-looks-wrong)), without public probes, reload loops, cache-busting URLs, extra `EventSource` streams, or outage-time navigations.

A Canary result applies only to that exact package, build, and socket; do not treat `#65` as resolved unless Stable reproduces the failure and the selected Canary completes the recorded cycle gate.

## Physical background-Push lane

Run [`scripts/android-push-qualification.ts`](../scripts/android-push-qualification.ts) (with fleet phases in [`scripts/android-push-fleet.ts`](../scripts/android-push-fleet.ts)) to qualify background Web Push v2 (home gateway, the gateway that serves the installed app) and Push v3 (fleet notifications, where the home gateway sends alerts for selected remote hosts, called sources) on the physical Pixel.

Only `bun run qualify:stable` ([Mainline stable release procedure](RELEASE.md#mainline-stable-release-procedure), [`scripts/stable-qualification.ts`](../scripts/stable-qualification.ts), and [`scripts/stable-lanes.ts`](../scripts/stable-lanes.ts)) qualifies a signed candidate.

Its read-only `preflightAndroidPush` checks only the HTTPS origin, while `runAndroidPushReadiness`, `runAndroidPush`, and `cleanupAndroidPush` bind the candidate tag, commit, archive SHA-256, [`UPSTREAM.lock.json`](../UPSTREAM.lock.json) pins, retained-Mac Serve origin, SSH executor, and shared `pixel()` lease.

To run a local development check against an already installed macOS gateway without modifying or rotating it outside the restored fleet phases, confirm these prerequisites first:

- `~/Library/LaunchAgents/omp-session-gateway.plist` is installed (with `StandardOutPath` and `StandardErrorPath` at `/dev/null`) in `tailscale-serve` mode behind a portless HTTPS `http.publicOrigin`, matches `$PUBLISHED_ARCHIVE`'s `version` and `sourceCommit` in `release-info.json`, has empty `fleet.targets` and `notifications`, has no `~/.local/state/omp-session-gateway/fleet-notifications.json`, and leaves Serve port `10443` and loopback port `14318` free.
- Workspace dependencies are installed (`bun install --frozen-lockfile`) with Bun `1.4.4` on `PATH`, the host has `python3` with `os.forkpty` and the pinned stock OMP binary or `dist/cli.js` (`OMP_PUSH_FIXTURE_BINARY` in [`scripts/android-push-runtime.ts`](../scripts/android-push-runtime.ts), matching `UPSTREAM.lock.json`), and the Pixel satisfies [Device admission and one-time WebAPK setup](#device-admission-and-one-time-webapk-setup) (including the USB/Keychain PIN above).

1. Run the full development matrix, or pass `development-step` with one step name (`fleet-identity`, `legacy-head-identity`, `coordinator-restart`, `revocation`, `fleet-sinks`, `fleet-restoration`, or `legacy-tail`; every step runs `fleet_enrolled` first, `fleet-identity` adds `stale_taps_verified` and the three `fleet_*_verified` detail phases, `legacy-head-identity` runs the nine local head phases plus those three detail phases, and `legacy-tail` restores `fleet` before the six tail phases):

   ```sh
   OMP_PUSH_FIXTURE_BINARY="$PINNED_OMP" bun scripts/android-push-qualification.ts development "$PUBLISHED_ARCHIVE"
   # Run one focused fleet or legacy slice during development:
   OMP_PUSH_FIXTURE_BINARY="$PINNED_OMP" bun scripts/android-push-qualification.ts development-step fleet-identity "$PUBLISHED_ARCHIVE"
   ```

2. If a development run was interrupted while holding the release-host lease (`~/.local/state/omp-session-gateway/release-host/lease.sqlite`) or Pixel lock (`/tmp/omp-gw-pixel.lock`), resume cleanup after the owner process exits:

   ```sh
   OMP_PUSH_FIXTURE_BINARY="$PINNED_OMP" bun scripts/android-push-qualification.ts cleanup "$PUBLISHED_ARCHIVE"
   ```

A passing run returns `{ epoch, binding, passed: true, platform: { android, browser, webApk: true, dndOff: true }, ompVersion, bunVersion, phases, cleanup }`. Local development runs add `development: true, qualified: false` and write `0600` `progress.json` and `tested-evidence.json` under `~/.local/share/omp-session-gateway/qualification/dev/androidPush/` (archiving any already-restored `progress.json` bound to another candidate, origin, or OMP pin as `progress-<epoch>-restored.json`).

Fixture operations execute `argv` through a host executor rather than assuming a local child process. On a remote host (`~/qual-tools/push/scripts` on the retained Mac), stage all seven `PUSH_FIXTURE_FILES` ([`scripts/stable-lanes.ts`](../scripts/stable-lanes.ts)) in `scripts`: `push-qualification-fixture.ts`, `omp-fixture.ts`, `omp-fixture.json`, `fixtures/push-qualification-extension.ts`, `fleet-push-fixture.ts`, `capability-leak-rules.ts`, and `identifier-leak-rules.ts`.

[`scripts/push-qualification-fixture.ts`](../scripts/push-qualification-fixture.ts) accepts either a native stock OMP binary or a Bun JavaScript entrypoint. A detached `python3` `os.forkpty()` holder keeps the PTY open and discards output without writing terminal input (no `tmux` or Homebrew is needed).

The holder starts OMP with `--no-extensions`, `--no-skills`, a synthetic model key, a private `--config <root>/fixture.yml` overlay (`collab.autoStart: control`, leaving `~/.omp/agent/config.yml` untouched), `--extension <scripts>/fixtures/push-qualification-extension.ts`, and `/push-qualification`.

Owner-only (`0600`), epoch-bound, monotonically sequenced control files (`owner`, `command.json`, `ack.json`) outside OMP discovery drive each transition without terminal injection, private OMP imports, or discovery-file edits: `ctx.ui.select` publishes an input request, a held `before_agent_start` publishes `busy: true`, and `newSession()` increments `generation` on the same `instanceId` before any provider transport.

Graceful `stop` escalates `SIGTERM` and `SIGKILL` to the verified holder process group if needed, checks `ps` for surviving `fixture.yml` or `hold.py` processes, and deletes the owned root.

For the fleet phases, [`scripts/fleet-push-fixture.ts`](../scripts/fleet-push-fixture.ts) `fsync`s `owner.json` before mutating host state, starts a disposable `Qualification source` gateway (`push-qualification`) on `127.0.0.1:14318` behind `tailscale serve --bg --https=10443`, enrolls it on the home gateway (`Qualification home`), and restores `config.json`, the LaunchAgent, and Tailscale Serve on `restore`.

Pixel `adb`/CDP, Keychain access, and the controller Bun pin remain local to the workstation driving the phone (`gatewayLogsDiscarded` inspects the retained Mac over SSH or the local LaunchAgent).

### Device admission and one-time WebAPK setup

Complete the persistent equipment steps once per Pixel and origin (with the USB-authorized Pixel and macOS Keychain PIN from above) before running any qualification campaign or post-release smoke:

1. Exempt Tailscale (`com.tailscale.ipn`) from Doze so forced-Doze cycles cannot kill the tailnet VPN. Select **Settings → Apps → Tailscale → Battery → Unrestricted**, or run:

   ```sh
   adb shell dumpsys deviceidle whitelist +com.tailscale.ipn
   adb shell dumpsys deviceidle whitelist
   ```

   Confirm the output contains `user,com.tailscale.ipn,<uid>` or `system,com.tailscale.ipn,<uid>` (`<uid>` decimal digits). Shared admission checks this allowlist read-only (including before post-release smoke downloads or mutates anything) and never changes battery policy automatically; if the VPN has stopped, reconnect Tailscale on the Pixel before replaying.

2. Install one **OMP Sessions** WebAPK (`org.chromium.webapk.*`) for the exact portless HTTPS origin under test (an app installed for a developer Mac does not qualify the retained Mac's origin):

   ```sh
   export PATH="$HOME/.local/lib/omp-session-gateway/bun/v1.4.4:$PATH"
   bun scripts/android-webapk.ts setup "$ORIGIN"
   ```

   [`scripts/android-webapk.ts`](../scripts/android-webapk.ts) is idempotent and separate from lane run or cleanup: it acquires `/tmp/omp-gw-pixel.lock`, opens `"$ORIGIN"`, taps Chrome's `universal_install` menu item (scrolling Chrome's virtualized menu when needed) and install confirmations (`option_text_install` and `positive_button`), verifies package ownership, closes the WebAPK task, and restores wake/keyguard state before releasing the lock.

   Reopen **OMP Sessions** on the Pixel once after `setup` finishes, open **Settings**, and tap **Enable background alerts** so notification permission is `"granted"`.

   If native UI cleanup fails during `setup`, it retains `/tmp/omp-gw-pixel.lock` with `pixelUnrestored: true` (close any open Chrome menu or dialog on the phone, verify the PID in `/tmp/omp-gw-pixel.lock/owner` has exited, and remove `/tmp/omp-gw-pixel.lock`, never deleting another active owner's lock). Neither `setup` nor the Push lane ever uninstalls apps or clears Chrome or WebAPK data.

Before each Push run, confirm these admission conditions (read-only parent refusals do not poison the Pixel lease):

- Do Not Disturb is off (`settings get global zen_mode` equals `0`): checked by the campaign orchestrator at device selection, at Push admission, and before and after every notification phase (a Bedtime schedule re-enabling DND fails the phase; acceptance and post-release smoke permit DND on).
- Wi-Fi is connected, an active SIM has cellular data enabled (required for `network_verified` to pass without `blocked: "cellular_path_unavailable"`), hotspot, USB, and Bluetooth tethering are off (`dumpsys tethering` reports `Upstream wanted: false`), and the controller is on its own network so radio transitions cannot disconnect SSH, WinRM, or the gateway origin.
- The Pixel resolves and answers `ping -c 1 -W 2` to the gateway origin's hostname (`AndroidReachabilityPreconditionError` distinguishes `unreachable` from `adb-transport`; DNS/ICMP reachability is an admission snapshot, not proof of HTTPS or CDP health).
- Origin notification permission is already `"granted"`, local `adb` TCP ports `9237` and `9238` are unoccupied (interrupted cleanup removes only matching device and Chrome forwards), and no unrelated session is waiting, held, or hidden in this device's directory (use **Requeue** and **Show all** in the WebAPK if needed before `triage_verified`).

For `permission_verified`, a browser-only CDP connection on `tcp:9237` holds an origin-scoped denial while the WebAPK task is closed; Chrome drops the override when that connection closes, and restoration rewarms Chrome, closes the override, verifies `"granted"`, and requires fresh delivery without touching Android runtime permissions.

Unrelated sessions may keep publishing during the lane: ownership binds to `NotificationManager`'s package, topic/tag digest, key, and post/update timestamp, and UI checks inspect only that notification's subtree (locating the fixture's unique synthetic project label under **Session** detail for taps).

On local Push v2 phases, one unowned notification post or update re-arms the phase once (`rearmCount: 1`, `rearmReason: "unowned_notification_overlap"`), settling owned requests, waiting for open attention clears (never activity-stop tags, which have no clear), and dismissing remaining owned notices. Fleet phases and second overlaps fail closed, and missing required events are never retried.

Display wake (`wakeAndroidDisplay` in [`scripts/android-device.ts`](../scripts/android-device.ts)) checks `isKeyguardShowing` before sending `MENU` (`keyevent 82`, which opens Chrome's app menu on an unlocked Pixel), taps `AlternateBouncerView`'s scrim when the standalone fingerprint bouncer holds focus, and proceeds without typing into the page if the keyguard dismisses during observation.

### Matrix and evidence

`ANDROID_PUSH_PHASES` ([`scripts/android-push-qualification.ts`](../scripts/android-push-qualification.ts) and [`scripts/android-push-fleet.ts`](../scripts/android-push-fleet.ts)) executes in this order:

1. `baseline_captured` and `subscription_ready`: captures the ten-boolean `PushDeviceBaseline` and `PushBrowserBaseline`, starts the `primary` fixture, records `notificationTopicDigest`, and sets **Private** detail.
2. `private_verified`, `session_verified`, and `preview_verified`: verifies closed-WebAPK delivery on a locked screen for each detail level (**Preview** equals **Session** for stock OMP), confirms lock-screen presentation via in-memory UIAutomator output (`adb exec-out`, reduced to booleans and counts with no screenshots or XML files), checks zero duplicate reposts across a 21-second window, and verifies authoritative clear.
3. `attention_tap_verified`, `activity_stop_verified`, `stale_generation_verified`, and `clear_verified`: verifies locked attention tap revalidation into writable **Control** (route scrubbed before network, answered with Select and Send), activity-stop delivery after two `busy: true` polls opening read-only **View** only, same-`instanceId` `generation + 1` stale tap failing closed with zero launches, and authoritative clear followed by fresh-request retention across repeated samples.
4. `triage_verified`: starts `secondary` (`secondaryNotificationTopicDigest`) and verifies arrival-order queueing, **Hold for desk** (closing only the held notification while keeping `N waiting · M held` and gateway counts unchanged), **Requeue**, holding both (`Queue clear · N on hold — handle at desk`), stale-hold release, **Hide** with **Undo** within 5 seconds and after expiry (`Live · N` unchanged), unhide on attention, and **Show all** (`mutations: 0`).
5. `stale_taps_verified`: re-presents metadata-only notifications (`replayed: true`) through the service worker and taps them from the lock screen for a desktop-resolved request, a re-armed request on the same generation (opening and settling the app before the newer request so subscription re-save does not overwrite the replay), a `generation + 1` replacement, and a stopped `secondary` host (waiting for its removal clear first), requiring route scrubbing, zero launches, and the expired notice.
6. Fleet Push v3 phases ([`scripts/android-push-fleet.ts`](../scripts/android-push-fleet.ts)):
   - `fleet_enrolled`, `fleet_private_verified`, `fleet_session_verified`, and `fleet_preview_verified`: enrolls `Qualification source` in **Settings → Hosts** (`Covered`) and verifies concurrent home and remote delivery across **Private**, **Session**, and **Preview** with 21-second deduplication and armed worker badge checks (`setAppBadge` / `clearAppBadge` observed inside the push wake).
   - `fleet_race_verified`, `fleet_taps_verified`, and `fleet_stale_taps_verified`: checks concurrent clear/replacement races and badge counts, live **Control** taps for home and remote requests, and replayed remote stale taps (resolved, `generation + 1`, and stopped source).
   - `fleet_outage_verified`, `fleet_restart_verified`, and `fleet_revocation_verified`: checks `source-down` / `source-up` stale retention and incomplete-coverage badge markers, `coordinator-down` / `coordinator-up` restart reconciliation (clearing a resolved remote request and re-alerting an open local request once with zero repeats across 35 seconds), and source revocation (`unauthorized`, notification cleared, zero launches).
   - `fleet_sinks_verified` and `fleet_restored`: verifies capability-free `push-state.json`, `fleet-notifications.json`, `notification-grants.json`, and `doctor --bundle` archives on both gateways, then revokes grants, stops the source and remote fixture, and restores Tailscale Serve and the home LaunchAgent.
7. `force_stop_verified`, `permission_verified`, and `lock_resume_verified`: force-stops `com.android.chrome` and records `delivered_while_force_stopped` or `suppressed_until_relaunch` plus fresh post-relaunch delivery; holds origin permission denial for 30 seconds with zero deliveries, restores permission, and requires fresh delivery within the 160-second recovery window (ordinary steady-state waits use 60 seconds); and verifies locked delivery and resume clear.
8. `network_verified`: checks Wi-Fi delivery/clear, cellular tailnet delivery/clear (missing cellular data records `blocked: "cellular_path_unavailable"` and sets `evidence_complete.passed` to `false`), 30-second Airplane suppression, and Wi-Fi recovery within 160 seconds. Leaving Airplane enables mobile data only after Wi-Fi validates, and Wi-Fi waits check up to 15 seconds for `GcmService` on Wi-Fi with the VPN up before reconnecting the VPN once and waiting up to 45 seconds.
9. `doze_verified`, `forbidden_sinks_verified`, and `evidence_complete`: runs forced Doze last, recording `delivered_during_doze`, `delivered_after_doze_exit`, or `undelivered_after_doze_exit` ([ADR-031](DECISIONS.md#adr-031--qualify-a-windows-host-and-pixel-background-web-push-in-every-stable-campaign)), opens the WebAPK once to clear the settled request, and checks ten sinks, `gatewayStructuredLogsSafe: true`, and `gatewayLogsDiscarded: true` (`plutil` `/dev/null`).

<!-- release-generate:campaign:start -->
The v0.12.0 campaign qualified these scenarios only for its recorded candidate and devices. Each later candidate must pass them again on its exact signed bytes; historical evidence does not transfer. See the [release ledger](RELEASE_STATUS.md).
<!-- release-generate:campaign:end -->

Each checkpoint precedes effects and stores only the attempt `epoch` UUID, SHA-256 identity `binding`, closed `phase`, `cleanupRequired`, boolean `device` and `browser` baselines, SHA-256 topic digests (`notificationTopicDigest`, `secondaryNotificationTopicDigest`, and optional `remoteNotificationTopicDigest`, without raw topics or instance IDs), optional `fleetPrepared`, bounded scalar `results` (`phaseElapsedMs` and delivery timings), and post-restoration `pixelBaseline`.

Raw OS notification keys, tags, and content stay in memory only. Cleanup attempts every `CLEANUP_STEPS` entry even after failure: `fixtureAsk` (settling open requests), `doze` (exiting Doze and resetting battery emulation), `network` (restoring radios and Wi-Fi push transport), `fleet` (restoring home `config.json`, LaunchAgent, and Serve when `fleetPrepared` is `true`), `fixture` (stopping `primary` and `secondary` OMP hosts), `notifications`, `browser`, and `task`.

Failed cleanup keeps `cleanupRequired: true`, never becomes a passing receipt, and sets `pixelUnrestored: true`, poisoning the shared campaign Pixel lease (an ordinary phase failure followed by clean restoration does not). Chrome and WebAPK Android runtime notification-permission booleans are observed before and after, never mutated.

## Client strategy

### Decision: PWA first

Hosts run stock mainline OMP `>= 18.1.20` with `collab.autoStart` alone behind `omp-gatewayd` (Bun `1.4.4`, TUN-mode Tailscale Serve, and exact login allowlisting; [Mainline OMP integration](OMP_INTEGRATION.md)), and the gateway resolves capabilities per launch without storing them ([Current claim](COMPATIBILITY.md#current-claim)).

Because the upstream OMP collaboration client is already a browser application providing live **View** and **Control**, the Android client is the **OMP Sessions** Progressive Web App (PWA) mounting that pinned client rather than a separate native protocol implementation:

- one UI and protocol implementation across desktop and Android;
- immediate compatibility with OMP's encrypted collaboration link format and client updates;
- no Android app-store release cycle for web changes;
- tailnet HTTPS origin isolation;
- standalone home-screen installation (WebAPK);
- no risk of cryptographic or wire-protocol divergence.

### PWA requirements

- responsive layout for narrow phone viewports, accounting for the virtual keyboard and `visualViewport` in the pinned `collab-web` client;
- web app manifest (`manifest.webmanifest`) with `display: standalone`, `#000000` splash `background_color` and `theme_color`, project-specific standard and maskable icons, and document `theme-color` metadata (`#000000` dark, `#f4f4f2` light) under the monochrome **Signal** system ([Color](BRANDING.md#color) and [ADR-049](DECISIONS.md#adr-049--signal-a-monochrome-system-in-which-color-is-state));
- minimal service worker precaching only versioned static shell assets ([Shell updates and caching](ARCHITECTURE.md#shell-updates-and-caching)), never API responses or collaboration navigations;
- volatile in-memory directory staleness and adaptive session reachability probes that clear retained metadata immediately on `403` ([Availability model](ARCHITECTURE.md#availability-model), [Availability behavior](ARCHITECTURE.md#5-availability-behavior), and [Current implementation audit](DECISIONS.md#current-implementation-audit--2026-09-14) on `ADR-016`);
- opt-in capability-free Web Push v2 (home gateway) and Push v3 (fleet notifications; [ADR-048](DECISIONS.md#adr-048--fleet-notifications-through-the-home-gateway-as-coordinator)) with per-device **Private**, **Session**, and **Preview** detail levels, read-only **View** taps for activity stops, and exact-request and generation revalidation before **Control** ([Needs-attention and notification detail contract](ATTENTION_SPEC.md) and [Background alerts](USAGE.md#background-alerts));
- Android Back returning from an open collaboration session to the directory without leaving a secret-bearing history entry;
- qualification on stable Chrome on Android, with alternate Chromium channels selectable via environment variables.

Top-level navigations bypass the service worker, so launching the installed PWA cold while offline stays unavailable on the OS splash screen until tailnet connectivity returns rather than caching sensitive runtime state.

In an installed WebAPK, a live `/client/` collaboration document reports `/` to the service worker, so navigating an open window on notification tap reloads and drops the live session.

The service worker therefore focuses an open window and hands the notification route over `postMessage` for in-place metadata revalidation, opening `/collab/:instanceId` (scrubbed to `/` before any network call) only when no window accepts ([Background attention push](ARCHITECTURE.md#23-background-attention-push)). Passing core Android browser smoke does not qualify the background-Push matrix.

### Launch UX

User-facing directory actions (**Open request**, **View transcript**, **View**, and **Control**) and `mode_unavailable` / expired-generation notices are specified in [Needs you](USAGE.md#needs-you) and [View and Control](USAGE.md#view-and-control). On Android, standalone PWA launch follows four architectural constraints ([Existing OMP collaboration client](ARCHITECTURE.md#15-existing-omp-collaboration-client)):

- mount the pinned collaboration client in the current standalone document via its in-memory capability bootstrap (`startCollabWithCapability`), carrying both `generation` and any request-specific `requestId`;
- never depend on `window.open` or `window.opener`, because Chrome on Android may reuse the standalone WebAPK window (a separate-page `MessageChannel` bootstrap applies only to ordinary browser tabs preserving an exact same-origin opener);
- never place a capability in a URL, DOM attribute, clipboard, browser history, or storage;
- never display or copy the raw collaboration link by default.

### Optional passkey/biometric gate

WebAuthn step-up protection for **Control** is proposed in [ADR-008](DECISIONS.md#adr-008--optional-webauthn-gate-not-native-biometrics) and is **Deferred** ([Deployment dependency matrix](COMPATIBILITY.md#deployment-dependency-matrix)); there is no passkey configuration key or enrollment flow.

Device lock, narrow tailnet access policy, and revocation are the active controls ([Lost phone and user presence](SECURITY.md#10-lost-phone-and-user-presence)), and any future gate would use browser-managed WebAuthn rather than a native protocol client.

### When to add a Trusted Web Activity

A Trusted Web Activity (TWA) is the preferred native package wrapper if the project later needs:

- Google Play Store distribution;
- a branded launcher and splash screen;
- verified Android App Links;
- managed-device enterprise deployment;
- a thin native bridge for scoped OS features.

A TWA must load the same tailnet HTTPS PWA verified with Digital Asset Links and keep all protocol and cryptographic logic out of the Android wrapper.

### When a fully native app might be justified

Reconsider a native UI only if the Web Push path proves inadequate for required delivery or OS integration. Even then, prefer a native or TWA shell that embeds the web collaboration client rather than reimplementing the OMP wire protocol.

### Why not a generic WebView wrapper?

A custom `WebView` wrapper takes on cookie and storage policy, navigation, browser-engine updates, security patching, and OS integration. A TWA uses the user's Chrome engine with verified site ownership, and the plain PWA avoids an Android wrapper altogether; a `WebView` wrapper offers no advantage over the PWA.

## Dated development observations

The sections below are dated development observations and are kept as written.

### Measurements behind the lane rules

These measurements were recorded beside the rules they explain, and are kept as written:

- Fixture holder cleanup: "Separate local holder smokes used a stop-refusing child: TERM cleanup took 10.343 s; with TERM ignored, KILL/HUP cleanup took 20.569 s. Both observed terminal stdin/stdout, no surviving owned processes, and removal of the owned root."
- One-time WebAPK setup: "The retained-origin install completed in 52.675 s on Chrome 153.0.8010.52; its authorized notification grant and subscription persisted across disconnect, with the equipment baseline restored and the lease released."
- Mobile data only after Wi-Fi validates: otherwise the push socket opens on mobile data and, once Wi-Fi becomes the default network, "holds every push until its next heartbeat (18.6 minutes on the 2026-09-29 run), which failed that attempt's post-recovery clear."
- Radio restoration after the cellular sub-phase: "Leaving Airplane after the cellular sub-phase can stall Play Services' path through the Tailscale VPN over Wi-Fi for minutes: on 2026-11-06 it stalled for 11.5 minutes and affected 4 of 13 faithful cellular → Airplane → Wi-Fi cycles. A Wi-Fi re-association did not clear it; a VPN reconnect did."

### Development observations — 2026-10-01 and 2026-09-25

Development observations on 2026-10-01, for the triage and delayed-tap phases: the runs used the
pinned Bun **1.4.0**, the installed **v0.7.1** gateway, stock OMP **18.4.8** fixtures, and the
Pixel 10 Pro on Android **17** with Chrome **154.0.8037.57**. Three runs exposed three lane
defects, each fixed with a failing-first fake regression:

- the one permitted re-arm waited on an owned activity-stop notice that never clears;
- a delayed-tap replay was replaced by the gateway's re-send of current asks after the app relaunch
  re-saved its subscription, or closed by a gone host's removal clear;
- the force-stop privacy check read Session notices, left by the new phases, as Private.

The fourth run passed every phase from `subscription_ready` through `evidence_complete` with no
re-arm. Triage recorded zero mutations, and the delayed taps recorded zero launches. Force-stop
delivered while stopped, Doze delivered after exit, and the sink sweep found ten detectable sinks
with zero findings. Cleanup restored the phone and stopped both fixture hosts. This is tested
evidence only.

Development observations on 2026-09-25: the isolated stock OMP **18.3.0** fixture published a real
ask, held known busy across two gateway polls, returned idle, and replaced the same instance by
exactly one generation; its process was stopped. The local **v0.5.3** gateway with Pixel 10 Pro,
Android **17**, and Chrome **153.0.8010.52** delivered the three requested detail variants with the
WebAPK task closed and their lock-screen presentations verified. One full-sequence attempt recorded
delivery observations of 1.950 s (Private), 2.908 s (Session), and 1.816 s (Preview), including no
duplicate repost during each repeated observation window. A focused real attention tap separately
observed exactly one successful launch, current generation/request validation, route scrubbing,
enabled native ask controls, and an authoritative answer using Select then Send. Fresh-runtime
cleanup also removed an owned, digest-bound OS notification without a fixture publication while
preserving a separate synthetic control; both controls and the device baseline were then restored.
The 632.07-second full-sequence development attempt additionally passed attention Control and
Select/Send, known-busy-to-idle View, same-instance N+1 rejection with zero stale launch requests,
authoritative clear/fresh retention, and the `delivered_while_force_stopped` variant with fresh
post-relaunch delivery. It then exposed a harness error: its denied-permission connection had already
closed. A corrected focused probe held denial for 33.158 seconds with the WebAPK task closed,
restored the real permission, received a fresh notification, and restored the baseline in 183.23 seconds.
Later full-sequence attempts passed the permission phase but repeatedly failed
`lock_resume_verified` with an authoritative-clear timeout. Waiting for initialized notification
controls and a visible directory did not resolve that failure. The Android build was
**CP2A.260805.005**, with Bun **1.4.0** throughout.

Bounded predecessor bisection and in-memory request-correlated instrumentation observed:

| Predecessor before lock/resume | Observed result | Attempt time, including restoration |
| --- | --- | --- |
| Subscription only | Exact current request cleared | 85.027 s |
| Force-stop only | Exact current request cleared | 149.501 s |
| Permission denial/restoration only | Exact current request cleared | 211.008 s |
| Clear/fresh only | Exact current request cleared | 159.149 s |
| Stale-generation only | Exact current request cleared | 210.218 s |
| Stale-generation → clear/fresh | Exact current request cleared | 285.682 s |
| Stale-generation → clear/fresh → force-stop | First post-relaunch authoritative clear timed out, before lock/resume | Failure observed at 324.204 s |

The last row is the **smallest observed failing combined prefix**, not a proven minimal cause.
Repeating that prefix with a worker-side recorder passed: force-stop clear took 1.105 s after
authoritative resolution; subsequent lock/resume clear took 0.584 s; restoration was observed at
358.663 s. In the instrumented lock/resume probes, the displayed request matched the received
clear, the gateway held the browser's current endpoint, and both browser and OS records disappeared.
The permission probe also observed a changed endpoint correctly retained by the gateway. These
passing traces do not establish why the uninstrumented failure occurred; attaching CDP changes the
observation conditions. Those traces alone did not establish a gateway or worker product defect.

The failed combined prefix left one owned active OS notification with no corresponding browser
notification handle. Ordinary cleanup failed closed and retained the Pixel lease. A separate
restoration experiment showed that immediately closing a same-tag replacement could be followed by
its late native OS post. Waiting for that replacement's actual OS post (observed after 806 ms) before
closing its browser handle removed the owned row for a 7.588-second observation window while
preserving unrelated notifications. This was explicit cleanup, not a successful authoritative clear
or a retry of the failed phase; its connection to the original clear failure remains unestablished.

Three later repetitions kept both page and worker DevTools detached throughout force-stop,
Android-only relaunch, and the first clear. All three cleared: **0 failures in 3 trials**, with
restoration observed at 313.076, 323.434, and 327.261 seconds. Passive Android notification-service
traces placed the second enqueue for the owned tag before its cancellation by 1.171, 1.288, and
2.239 seconds respectively; no later enqueue appeared in those windows. The last two trials also
observed five additional seconds without a native repost. Browser endpoint/key digests were
unchanged and matched the gateway target throughout. This does not explain the earlier failure.
The release build emitted no selected FCM receipt diagnostics; their absence is a visibility gap,
not proof of non-delivery or receipt ordering. Native content hashes, timestamps, process roles,
and request hashes were retained; raw logcat, notification content, and XML were not.

A subsequent controlled native-API probe reproduced the orphan independently of Web Push. Each
pair started with a posted, silent synthetic notice, then an in-memory button in the existing PWA
replaced it with a different synthetic title and the same tag. After awaiting `showNotification()`,
the button found exactly one notification, closed it, and observed zero browser handles. The
button was activated by an Android touch event; page and worker DevTools were detached throughout
each observation window. Neither the gateway nor the installed worker was modified.

| Controlled condition | Valid pairs | Native orphans | Native notification-service ordering |
| --- | --- | --- | --- |
| Warm browser | 5 | 5 | Replacement enqueued 48, 63, 68, 78, and 66 ms after cancellation |
| Chrome force-stop and cold relaunch before each pair | 5 | 0 | Replacement enqueued 18, 15, 15, 3, and 20 ms before cancellation |

Every warm orphan had the canceled record's key and the replacement's content hash, not the
seed's. Its native post timestamp was also after cancellation, and it remained about 15.8 seconds
after the browser reported zero handles. No Chrome process lifecycle event occurred inside any
pair; each cold setup recorded its preceding process kill and restart. The experiment completed
in 308.214 seconds including restoration. The transient button and its in-memory state were
verified absent after reload. Each orphan was removed outside its outcome window by the explicit
native-post-observed restoration procedure. These small controlled samples demonstrate a native
ordering failure, not a production failure-rate estimate or proof of the earlier sequence's cause.

Source analysis of the exact Chrome **153.0.8010.52** implementation also limits possible repairs.
Notification resources load before the browser display acknowledgement, but the Android display
path subsequently awaits WebAPK/channel work independently of close. Android reports no native
display synchronization support; `getNotifications()` reads the browser notification database.
Consequently, neither a resolved `showNotification()` nor a returned notification handle is an
acknowledgement that Android has posted the notification. Reasserting a silent same-tag placeholder
and closing it as soon as `getNotifications()` finds it is not a native-display fence. A bounded
delay is a heuristic rather than a native-display acknowledgement. The worker now retains a
monotonic display timestamp in memory and holds an exact current-request clear until 2,000 ms
after a recent show resolves, then re-queries the browser handles before closing. The budget is
about 25 times the largest observed 78 ms late enqueue, not a delivery guarantee. Old notices
and notices inherited by a fresh worker close immediately. The existing serial push queue
preserves clear/replacement ordering; an independently replaced request is not closed.
An identical current attention replay with the same title and body updates the badge without
re-showing or extending that timestamp. Changed content and dismissed notices still show.
This reduces needless native replacements but cannot recover an already native-only orphan.
Fake-timer regressions cover the timing boundary, exact-request re-query, queued replacement,
duplicate content, changed content, dismissal, and worker restart. Physical qualification is
still required; no full-matrix pass is inferred from those tests.
The pinned Chromium sources are the
[display acknowledgement](https://github.com/chromium/chromium/blob/153.0.8010.52/content/browser/notifications/platform_notification_service_proxy.cc#L40-L53),
[asynchronous Android display](https://github.com/chromium/chromium/blob/153.0.8010.52/chrome/android/java/src/org/chromium/chrome/browser/notifications/NotificationPlatformBridge.java#L724-L784),
and [unsupported native synchronization](https://github.com/chromium/chromium/blob/153.0.8010.52/chrome/browser/notifications/notification_platform_bridge_android.cc#L444-L462).

All final device baseline booleans matched, the original granted/subscribed Preview preference was
restored after a later **10 warm + 5 cold** settled native-API run as well. All 15 pairs were valid
and left **zero native orphans**. Each awaited a same-tag replacement, waited the remaining
2,000 ms, re-queried the exact browser notice, closed it, and observed zero browser handles.
Observed show-return-to-close times were 2.010–2.030 s; detached Android-only observation
continued for 13.726–14.103 s after completion. That run took 412.195 s including restoration.
The transient button/state were absent after reload, the Python-PTY fixture had published idle
and was then absent, and the lease was released. Earlier settled-probe attempts produced no valid
samples: an application-menu popup intercepted the touch. The shared wake helper now avoids
sending MENU to an unlocked phone; its regression models real keyguard/authentication state.
This native sample supports the measured mitigation but is not an uninterrupted Web Push matrix.

The original granted/subscribed Preview preference was
restored, the owned fixture was absent, and the development Pixel lease was independently observed
released. The daily gateway, global OMP installations, and user OMP configuration were unchanged.
The complete uninterrupted matrix remains **blocked at authoritative clear**. Forced Doze, the
complete real network matrix, and the final real sink sweep have not passed end to end. These are
**tested observations**, not qualification of v0.5.3 or the future v0.6.0 candidate.

### Retained-Mac development run with the mitigation

A single uninterrupted production-adapter/runner attempt at orchestrator
`aed340d50c0819aeafcd9f8bfecd7fc7325a45ef` used the retained Mac, stock OMP 18.3.0, Bun 1.4.0,
and the same physical Pixel/Android/Chrome combination. The development gateway build was
`0.5.3-ab78cd73dc1d`, archive source `ddee00de7974f7aa39ec04d2a5f766c75bbfda12`, archive
SHA-256 `c7003944f39449b909960c7abb8e44971d7219b91045a445a1ed49a3b71674ef`. Its worker
included the settle/re-query and duplicate-content mitigation. The retained origin had its own
explicitly installed WebAPK and real granted subscription; the original local-origin app was
independently observed still installed.

| Completed phase | Phase duration | Observation |
| --- | --- | --- |
| Subscription | 24.164 s | Enabled |
| Locked Private | 56.625 s | One owned notification; matching detail |
| Locked Session | 61.074 s | One owned notification; matching detail |
| Locked Preview | 59.034 s | One owned notification; matching detail |
| Attention tap | 52.653 s | Revalidated, scrubbed Control |
| Activity stop | 70.886 s | Two known-busy polls; View only |
| Stale generation | 74.332 s | Same instance, generation +1, zero launches |
| Clear/fresh | 81.999 s | Authoritative clear; fresh request retained |
| Force-stop | 131.309 s | Delivered while force-stopped; fresh delivery afterward |
| Permission | 128.772 s | Suppressed while denied; fresh delivery after restoration |

The next phase again failed with **lock/resume authoritative clear timed out**. The exact error
line was identified by its stderr digest. Total runner time was 901.483 s including cleanup; the
failed phase has no completed duration. No retry was made. Doze, networking, and the sink sweep
were not reached. This recurrence means the measured mitigation did **not** resolve the complete
sequence failure.

The passive trace retained 1,109 rows with zero drops: 26 owned-topic notification rows, 212
process rows, and 871 Chrome diagnostic rows. It contained no selected FCM receipt rows; delivery
and push-handler execution therefore remain unobserved, not disproved. The final owned-topic
enqueue preceded the final native cancellation by 90.689 s, with no intervening or later enqueue.
That sequence differs from the controlled cancel-then-late-post signature. The trace did not retain
per-request arm/resolution times, OS content/post-update hashes, browser handles, or worker
show/close times. It cannot identify the lingering request or establish the 2 s branch taken.
Timestamp-and-hash-matched read-only log recovery identified sandboxed Chrome process churn in
that interval, but no Chrome-main or WebAPK lifecycle event within it; it did not identify the
service-worker process. The exact timeout path proves fixture answer acknowledgement and a
gateway snapshot with the ask cleared before waiting for notification removal, not their time.

Cleanup passed for the same epoch, progress was restored with cleanup no longer required, and
the lease was released. A later read-only query matched all ten device baseline booleans and
found no owned notification; DND remained off. The restored browser baseline was granted,
subscribed, Session detail. This is partial **development-tested** evidence, not a matrix pass
or stable qualification. Further diagnosis must capture the missing request/native/browser
identities before cleanup rather than extending the clear deadline or retrying its missing event.

### Root cause: FCM throttled the coalescing Topic

The lock/resume clear timeouts came from Firebase Cloud Messaging, not the worker. Every push
carried a per-instance Web Push `Topic`, which FCM treats as a collapse key and limits to a burst
of 20 messages per device, refilling one every three minutes. By lock/resume the matrix had spent
that budget, so a clear could arrive minutes after the lane's 60-second deadline.

A controlled comparison on 2026-09-25 (04:46:39Z–05:07:17Z) used the retained Mac, the same Pixel
(Android 17, Chrome 153.0.8010.53), the retained-origin WebAPK, and a granted, subscribed
Session-detail baseline. Two development builds with byte-identical workers ran one ask and its
answer per cycle, with the app closed, the device locked, and no UI driving inside a cycle:

| Build | Source | Archive SHA-256 | Result |
| --- | --- | --- | --- |
| T, with `Topic` | `ddee00de7974` | `c7003944…` | Transitions 1–21 reached Android within 3.5 s; #22 (clear) took 150.807 s and #23 (attention) 172.362 s, which ended the arm |
| N, without `Topic` | `e8bfd5b91521` | `a819df96…` | Installed 9.5 s after T ended; 28 of 28 transitions within 3.053 s |

Latency runs from the first gateway snapshot showing the transition to the native Android enqueue
or cancellation. #255 removes the `Topic` and amends ADR-017.

An earlier no-Topic full-sequence attempt on the same build (04:06:16Z–04:14:21Z) completed six
phases through activity stop, then failed at the stale-generation tap. Android's event history
shows the bouncer focused at 04:13:14.898Z, the keyguard going away at 15.216Z, and
`isKeyguardShowing=false` at 15.419Z; earlier taps had kept the bouncer up for about 8 s. The
helper kept waiting for a PIN field that no longer existed. `9fdb7c3` accepts a keyguard that
dismisses during observation; its regression tests failed before the fix. Cleanup passed and the
lease was released. That attempt never reached lock/resume, so it neither confirmed nor refuted the
throttle.

### Full no-Topic run after the Pixel's September update

Before the run, the Pixel installed system update `CP3A.260905.009` (from `CP2A.260805.005`) and
rebooted. The first attempt, 2026-09-25 08:43:34Z at orchestrator `0f5c7d0`, passed Subscription
and Locked Private, then failed Locked Session before arming its ask. The lane's own cleanup and
the cleanup lane both failed: the fixture was stopped, but the phone stayed locked and the lease
stayed held. The development tracer printed only the aggregate failure, so the exact error lines
were not captured.

On the device, the Compose keyguard of that build answers the helper's MENU key with SystemUI's
standalone fingerprint bouncer window, `AlternateBouncerView`. That window carries no
`alternate_bouncer` resource and ignores the PIN swipe, so the helper typed its PIN into no field.
A tap on its scrim shows the PIN bouncer; a swipe from the plain lock screen still does.
`8a9a497` detects the window by its focus and taps the scrim well above the sensor; its two
regression tests failed before the fix. The fixed path then unlocked the phone from a locked
screen, and a second cleanup-lane attempt for the failed epoch passed and restored the baseline.

One uninterrupted attempt at orchestrator `8a9a497` then passed every phase, 09:02:52Z–09:20:40Z
(runner 1,055.873 s including cleanup), against the retained Mac's no-Topic development gateway
(source `e8bfd5b`, archive SHA-256 `a819df96…`), stock OMP 18.3.0, and Bun 1.4.0, on the Pixel 10
Pro (Android 17 `CP3A.260905.009`, Chrome 153.0.8010.53, retained-origin WebAPK version 1):

| Completed phase | Phase duration | Observation |
| --- | --- | --- |
| Subscription | 24.270 s | Enabled |
| Locked Private | 55.978 s | One owned notification; matching detail; delivered in 2.483 s |
| Locked Session | 60.221 s | One owned notification; matching detail; delivered in 3.253 s |
| Locked Preview | 59.863 s | One owned notification; matching detail; delivered in 1.419 s |
| Attention tap | 52.504 s | Revalidated, scrubbed Control |
| Activity stop | 67.057 s | Two known-busy polls; View only |
| Stale generation | 64.998 s | Same instance, generation +1, zero launches |
| Clear/fresh | 75.346 s | Authoritative clear; fresh request retained |
| Force-stop | 110.493 s | Delivered while force-stopped; fresh delivery afterward |
| Permission | 119.281 s | Suppressed while denied; fresh delivery after restoration |
| Lock/resume | 40.216 s | Locked delivery; resumed |
| Doze | 79.827 s | Delivered after Doze exit |
| Network | 169.895 s | Wi-Fi and cellular delivery; Airplane suppressed; recovered |
| Forbidden sinks | 18.483 s | Ten sinks detectable and clean; gateway streams discarded |

Cleanup passed for the same epoch with device, browser, and fixture restored, and the lease was
released. The passive trace kept 1,298 rows with zero drops. This is **development-tested**
evidence for the lane and the no-Topic gateway, not stable qualification.
