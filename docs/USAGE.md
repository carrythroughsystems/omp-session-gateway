# Using OMP Sessions

**OMP Sessions** is the mobile web app for your running Oh My Pi (`omp`) terminals. Open your gateway's private Tailscale Serve HTTPS address (for example `https://host.example.ts.net`) to see every live collaboration session, answer prompts that are waiting for you, and open any session in one tap — without QR codes or copied links.

## The directory

The home screen switches automatically between two modes depending on whether any session is waiting for your input:

- **Sessions (`All clear`)**: when live sessions are running and none need input, the masthead shows **Sessions** with a `Live · N` pill, an **All clear** card (`Nothing needs you.`), and **Live sessions** sorted newest first.
- **Needs you**: when one or more sessions are waiting for input, the masthead switches to **Needs you** with an `N waiting` pill (or `N waiting · M held` when you have deferred requests).
- **No live sessions**: when no collaboration-enabled `omp` process is running, the empty state prompts you to start an interactive OMP process with `collab.autoStart` configured (`omp config set collab.autoStart control` or `view`). New sessions appear on the next 10-second discovery poll.

Each session row displays bounded metadata only: the session title (or working-folder label, falling back to `OMP session`), uptime (`up <1m`, `up 12m`) or wait time (`waiting 3m`), activity (`· Working`, `· Idle`, or `· Activity unknown`), folder name, and model name.

`· Idle` means no turn is currently running; the OMP process is still open in your terminal and remains selectable. The directory never renders transcripts, prompt choices, answers, or collaboration links.

There is no manual Refresh button. Live updates and automatic reconnects keep the directory current when you unlock your phone or return to the app.


## Multiple hosts (`All hosts` and Host picker)

When your gateway is configured with `fleet.targets` ([Multi-host setup in `OPERATIONS.md`](OPERATIONS.md#multi-host-setup)), one installed **OMP Sessions** app lists and opens sessions across up to 8 hosts (this gateway plus up to 7 remote gateways):

- **Host picker**: use the **Host** selector in the directory header to switch between **All hosts**, this gateway's label (`fleet.label`, which defaults to the first DNS label of `http.publicOrigin`, or the literal host on loopback dev origins), and each configured remote host in configuration order. Filtering only changes what is shown on screen; while the app is visible, each configured remote host is polled every 10 seconds with a 5-second request timeout.
- **Host labels everywhere**: every session row, **Up next** hero card, **On hold** row, and active collaboration shell bar shows its host label so two sessions with identical titles or folders on different machines are never ambiguous.
- **Truthful `All clear` and empty states**: **All clear** (`Nothing needs you.`) and **No live sessions** appear only when every host in the selected scope has a fresh snapshot. If any host in scope is unreachable or denied, the directory shows `Host coverage incomplete — Unavailable: <hosts>` instead of claiming that the fleet is clear or that background alerts cover them.
- **Per-host errors and `Retry`**: if a remote host cannot be reached (offline host, tailnet/DNS issue, or missing CORS trust), its last-seen rows stay visibly stale and non-launchable for a 35-second grace window and the host row shows `<Host>: Cannot reach this host from this app.` with **Retry**. If a remote host returns a readable `403` (for example, your login is not in its `auth.allowedLogins`), its rows are cleared immediately, the host row shows `<Host>: Access withdrawn.` (`forbidden`), any open shell from that host closes back to the directory, and automatic polling pauses until you tap **Retry** or bring the app back to the foreground. Older gateways without `GET /api/v1/client-config` answer `404` and run in local-only mode with browser speech recognition off; if `GET /api/v1/client-config` returns an invalid or origin-mismatched response, the directory shows `Fleet configuration unavailable — reload this app` while the local directory keeps working.
- **Direct leaf fallback**: if your home gateway is offline while a remote workstation is still running, open that remote workstation's own Tailscale Serve `https://` address directly in your browser.

### Running OMP inside Tern

Interactive `omp` sessions started inside **Tern** panes, tabs, or windows use stock OMP's native local registry and appear in **OMP Sessions** like any other terminal once `collab.autoStart` (`control` or `view`) is set. Multiple Tern windows mirroring the same `omp` process appear as one session row, and a remote Tern pane is listed by the gateway on the host where `omp` actually runs. Tapping **View** or **Control** always opens OMP's encrypted collaboration client in the browser — it never focuses or sends keystrokes to a native Tern pane.
## View and Control

Tapping a session fetches a fresh link from OMP and opens OMP's own encrypted `collab-web` client in the same tab. The link lives only in memory and is never written to the address bar, browser history, or storage. Tap **← Sessions** in the top bar (or use browser Back) to return to the directory.

- **View** is read-only (`Read-only session — watching only`): you can read the live transcript, streaming output, and tool cards without sending prompts or answering requests. Tapping any row under **Live sessions** opens **View**; if the session also permits Control, tap **Control** in the top bar to switch to writable mode in place.
- **Control** is writable: you can send prompts, tap **Stop** to abort a running turn, and answer input requests.

In **Control**, tap **Photo** in the composer to attach images over the encrypted collaboration channel: choose **Take photo** (rear camera) or **Choose existing** (photo library or files). You can attach up to 4 JPEG, PNG, or WebP images per prompt (source up to 8,192 px per edge or 20 megapixels, resized in the browser to metadata-free JPEGs within 2,048 px and 1 MiB each). The composer shows `Sending photo…` (or `Sending photos…`) until the host transcript confirms delivery; if confirmation takes longer than 5 seconds, the draft stays staged so you can tap **Retry**.


### Dictation and speech input

You can dictate prompts and answers in **Control** using either your device's built-in keyboard dictation or the optional in-page speech recognizer ([#380](https://github.com/carrythroughsystems/omp-session-gateway/issues/380); installed-iPhone acceptance for `#380` remains pending physical-device verification):

- **OS keyboard dictation (default, no gateway setup required)**: focus the **Control** composer and tap the microphone key on your system keyboard. The composer help copy reads: `"Use your keyboard's microphone key to dictate into this box. iPhone: Settings → General → Keyboard → Enable Dictation. Dictation never sends — tap Send when the text is right."`
- **Optional in-page microphone (`speech.browserRecognition: true`)**: when enabled on the home gateway and supported by your browser in **Control**, the composer shows a microphone button:
  1. Tap the microphone button and review the privacy disclosure: `"Your browser or OS may send audio to its speech provider before any OMP prompt is sent."`
  2. Tap **Start** to begin speaking, then tap **Stop** when finished (or **Cancel** to discard). The recognizer uses `navigator.language` (falling back to `en-US`), `continuous`, `interimResults`, one alternative (`maxAlternatives = 1`), and no automatic restart, with a 10-second start watchdog, a 120-second (two-minute) capture limit, a 5-second stop watchdog, and review buffer bounds of 128 segments, 8,000 code points, and 32 KiB.
  3. Review or edit the recognized transcript in the draft panel and tap **Use text** to insert it into the composer.
  4. Edit if needed and tap **Send**. **Use text** only copies text into the composer — it never submits the prompt.

The in-page microphone is never shown in read-only **View**. Switching to **View**, losing connection, hiding the app, or leaving the session stops active recognition immediately.
## Needs you

When viewing a single host, waiting sessions form a first-in, first-out (FIFO) queue ordered by when each request arrived (`ask.since`). When **All hosts** is selected, waiting sessions across hosts are ordered by when this browser first observed each exact request (`observed waiting order`). The oldest waiting request in the selected scope is promoted to the **Up next** hero card (`Waiting for your input`, or `Waiting for your input — Control unavailable` when the session is read-only).

Tap **Open request** on the hero card to open **Control** focused directly on that prompt, or tap **Transcript** to inspect the session in read-only **View** first. When a waiting session is view-only, the primary button is **View transcript**.

Additional waiting sessions appear below the hero card under **Then** in FIFO order, followed by any **On hold · N** rows and **Live sessions · N**. Tapping any row under **Then** opens that request directly.

When you submit an answer in **Control**, the composer and bottom triage bar show `Sending…` until OMP acknowledges the response. Once acknowledged, the triage bar appears for 8 seconds: tap **Next ask →** (`✓ Answered — N more need you`) to open the next waiting request, or tap **Sessions** (`✓ Answered — all clear · N live`) to return to the exact directory order and scroll position you left.

## Hold and hide

**Hold for desk** defers an input request on this device without answering or clearing it in OMP. Tap **Hold for desk** on the **Up next** card (or **Hold → next** in the triage bar while an ask is open in Control) to close its notification on this device and advance the queue to the next waiting session.

Held requests stay visible under **On hold · N** (when every waiting request is held, the summary reads `Queue clear · N on hold — handle at desk`). Tap a held row to open it, or tap **Requeue** to return it to the active **Needs you** queue.

**Hide** on any non-waiting row removes that session from the list on this device only — the OMP process keeps running in your terminal.

Hiding shows a 5-second toast (`Hidden “<session>” on this device · 5s`) with **Undo**, and adds a footer (`N hidden on this device`) with **Show all** to restore every hidden session at once. If a hidden session later asks for input or starts a new generation, it reappears automatically. Held asks and hidden sessions are stored per device in `localStorage` under `omp.sessions.held-asks.v2` and `omp.sessions.dismissed.v2` with `sourceId` and `sourceOrigin`.

## Background alerts

Tap **Settings** in the top-right masthead to open the **Background alerts** sheet, then tap **Enable background alerts** (or **Disable background alerts** to unsubscribe). **OMP Sessions** requests browser notification permission only when you tap enable.

While alerts are enabled, choose how much detail the gateway includes for this device (stored per subscription on the gateway; payloads are built at the chosen level on the gateway so the phone never redacts locally):

- **Private**: fixed title only (`OMP session needs attention` or `OMP session activity stopped`), with no session information.
- **Session** (*default*): session and project names.
- **Preview**: session details plus a bounded request preview when available. Stock OMP currently publishes only boolean `inputRequired` and optional `busy`, so **Preview** falls back to **Session** detail; choose **Private** if you do not want session names in notification history, screenshots, or wearables.

Tapping an input-request alert (`OMP session needs attention`) revalidates that the exact request is still waiting and opens **Control**. When a host publishing `busy` finishes a running turn without waiting for input, the gateway sends `OMP session activity stopped`; tapping a stop alert opens read-only **View**, never **Control**.

On iPhone and iPad, Safari in a browser tab shows `Background alerts unavailable`. Add **OMP Sessions** to the Home Screen first, then open the Home Screen app and enable alerts there.

Push delivery uses a 5-minute time-to-live and is best-effort: brief turns between 10-second discovery polls can be missed, and on Android force-stop and Doze are observed variants rather than delivery guarantees. See [exact qualified combinations and evidence](COMPATIBILITY.md#current-claim).

Background alerts and the app icon badge cover **this host only**. The Settings sheet states this scope explicitly; remote hosts in `fleet.targets` do not send Web Push through your home gateway, and holding an ask on a remote host never closes a local notification. If you want background alerts from a remote workstation, open that workstation's own HTTPS origin and install its PWA separately.

## Install as an app

Open your gateway's Tailscale Serve HTTPS address (`https://host.example.ts.net`) from your allowlisted Tailscale device. Always install the directory address itself — never bookmark or save an individual collaboration link.

- **Chrome, Edge, and other Chromium browsers (Android and desktop)**: open the browser menu and select **Install app** (or **Add to Home screen**).
- **Safari on iPhone and iPad**: tap **Share**, then **Add to Home Screen** (required on iOS and iPadOS before enabling background alerts).
- **Safari on macOS**: choose **File → Add to Dock…** (or **Share → Add to Dock**).
- **Firefox on desktop**: desktop Firefox does not install web apps; use **OMP Sessions** in a standard browser tab.

## When something looks wrong

- **`That session changed or expired.`, `That notification changed or expired. Choose a current session.`, `That alert changed or expired.`, or `Mac/session ended`**: the request was already answered elsewhere, or the OMP process exited or restarted with a new generation. Tap **Back to Sessions** (or **Sessions**) and open the current card from the directory.
- **Directory offline vs. relay unavailable**:
  - Directory banners keep the last-seen list visible and name the failing hop: `You're offline` (this device has no connection), `Tailnet unreachable` (Tailscale is off or logged out on this device), `Desktop unreachable` (your tailnet is up, but the computer is asleep or the gateway stopped — tap **Try again**), or `Gateway unavailable` (live updates paused; reconnects automatically).
  - Inside an open session, the header chip and triage bar distinguish `Gateway unavailable — retrying…` (the tailnet connection to your computer dropped), `Relay unavailable — retrying…` (the encrypted OMP relay connection dropped while the gateway is still reachable), and `Access withdrawn` (`Access withdrawn — return to sessions` when the selected gateway returns `403` / `forbidden`).
- **Stuck connection on Android after sleep or a network change**: Chrome on Android can wedge its network stack after switching between Wi-Fi and cellular while Android itself remains online. **OMP Sessions** retries automatically and, after 45 seconds of uninterrupted visible failure, shows **Troubleshooting** (`Still unreachable?`): open Android **Settings → Apps**, select the browser, tap **Force stop**, and reopen **OMP Sessions**.
- **Page reloads after a gateway update**: when the gateway activates an updated service worker, the page waits until no launch is in flight and no View or Control session is open, then reloads the idle directory automatically after 1 second.

For workstation checks, service management, and `omp-gateway doctor`, see [operator troubleshooting in `OPERATIONS.md`](OPERATIONS.md#troubleshooting-by-symptom).
