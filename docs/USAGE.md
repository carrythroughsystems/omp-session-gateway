# Using OMP Sessions

**OMP Sessions** is the mobile web app for your running Oh My Pi (`omp`) terminals. Open your gateway's private Tailscale Serve HTTPS address (for example `https://host.tailnet.ts.net`) to see every live collaboration session, answer prompts that are waiting for you, and open any session in one tap — without QR codes or copied links.

## The directory

The home screen switches automatically between two modes depending on whether any session is waiting for your input:

- **Sessions (`All clear`)**: when live sessions are running and none need input, the masthead shows **Sessions** with a `Live · N` pill, an **All clear** card (`Nothing needs you.`), and **Live sessions** sorted newest first.
- **Needs you**: when one or more sessions are waiting for input, the masthead switches to **Needs you** with an `N waiting` pill (or `N waiting · M held` when you have deferred requests).
- **No live sessions**: when no collaboration-enabled `omp` process is running, the empty state prompts you to start an interactive OMP process with `collab.autoStart` configured (`omp config set collab.autoStart control` or `view`). New sessions appear on the next 10-second discovery poll.

Each session row displays bounded metadata only: the session title (or working-folder label, falling back to `OMP session`), uptime (`up <1m`, `up 12m`) or wait time (`waiting 3m`), activity (`· Working`, `· Idle`, or `· Activity unknown`), folder name, and model name.

`· Idle` means no turn is currently running; the OMP process is still open in your terminal and remains selectable. The directory never renders transcripts, prompt choices, answers, or collaboration links.

There is no manual Refresh button. Live updates and automatic reconnects keep the directory current when you unlock your phone or return to the app.

## View and Control

Tapping a session fetches a fresh link from OMP and opens OMP's own encrypted `collab-web` client in the same tab. The link lives only in memory and is never written to the address bar, browser history, or storage. Tap **← Sessions** in the top bar (or use browser Back) to return to the directory.

- **View** is read-only (`Read-only session — watching only`): you can read the live transcript, streaming output, and tool cards without sending prompts or answering requests. Tapping any row under **Live sessions** opens **View**; if the session also permits Control, tap **Control** in the top bar to switch to writable mode in place.
- **Control** is writable: you can send prompts, tap **Stop** to abort a running turn, and answer input requests.

In **Control**, tap **Photo** in the composer to attach images over the encrypted collaboration channel: choose **Take photo** (rear camera) or **Choose existing** (photo library or files). You can attach up to 4 JPEG, PNG, or WebP images per prompt (source up to 8,192 px per edge or 20 megapixels, resized in the browser to metadata-free JPEGs within 2,048 px and 1 MiB each). The composer shows `Sending photo…` (or `Sending photos…`) until the host transcript confirms delivery; if confirmation takes longer than 5 seconds, the draft stays staged so you can tap **Retry**.

## Needs you

Waiting sessions form a first-in, first-out (FIFO) queue ordered by when each request arrived. The oldest waiting request is promoted to the **Up next** hero card (`Waiting for your input`, or `Waiting for your input — Control unavailable` when the session is read-only).

Tap **Open request** on the hero card to open **Control** focused directly on that prompt, or tap **Transcript** to inspect the session in read-only **View** first. When a waiting session is view-only, the primary button is **View transcript**.

Additional waiting sessions appear below the hero card under **Then** in FIFO order, followed by any **On hold · N** rows and **Live sessions · N**. Tapping any row under **Then** opens that request directly.

When you submit an answer in **Control**, the composer and bottom triage bar show `Sending…` until OMP acknowledges the response. Once acknowledged, the triage bar appears for 8 seconds: tap **Next ask →** (`✓ Answered — N more need you`) to open the next waiting request, or tap **Sessions** (`✓ Answered — all clear · N live`) to return to the exact directory order and scroll position you left.

## Hold and hide

**Hold for desk** defers an input request on this device without answering or clearing it in OMP. Tap **Hold for desk** on the **Up next** card (or **Hold → next** in the triage bar while an ask is open in Control) to close its notification on this device and advance the queue to the next waiting session.

Held requests stay visible under **On hold · N** (when every waiting request is held, the summary reads `Queue clear · N on hold — handle at desk`). Tap a held row to open it, or tap **Requeue** to return it to the active **Needs you** queue.

**Hide** on any non-waiting row removes that session from the list on this device only — the OMP process keeps running in your terminal.

Hiding shows a 5-second toast (`Hidden “<session>” on this device · 5s`) with **Undo**, and adds a footer (`N hidden on this device`) with **Show all** to restore every hidden session at once. If a hidden session later asks for input or starts a new generation, it reappears automatically.

## Background alerts

Tap **Settings** in the top-right masthead to open the **Background alerts** sheet, then tap **Enable background alerts** (or **Disable background alerts** to unsubscribe). **OMP Sessions** requests browser notification permission only when you tap enable.

While alerts are enabled, choose how much detail the gateway includes for this device (stored per subscription on the gateway; payloads are built at the chosen level on the gateway so the phone never redacts locally):

- **Private**: fixed title only (`OMP session needs attention` or `OMP session activity stopped`), with no session information.
- **Session** (*default*): session and project names.
- **Preview**: session details plus a bounded request preview when available. Stock OMP currently publishes only boolean `inputRequired` and optional `busy`, so **Preview** falls back to **Session** detail; choose **Private** if you do not want session names in notification history, screenshots, or wearables.

Tapping an input-request alert (`OMP session needs attention`) revalidates that the exact request is still waiting and opens **Control**. When a host publishing `busy` finishes a running turn without waiting for input, the gateway sends `OMP session activity stopped`; tapping a stop alert opens read-only **View**, never **Control**.

On iPhone and iPad, Safari in a browser tab shows `Background alerts unavailable`. Add **OMP Sessions** to the Home Screen first, then open the Home Screen app and enable alerts there.

Push delivery uses a 5-minute time-to-live and is best-effort: brief turns between 10-second discovery polls can be missed, and on Android force-stop and Doze are observed variants rather than delivery guarantees. See [exact qualified combinations and evidence](COMPATIBILITY.md#current-claim).

## Install as an app

Open your gateway's Tailscale Serve HTTPS address (`https://host.tailnet.ts.net`) from your allowlisted Tailscale device. Always install the directory address itself — never bookmark or save an individual collaboration link.

- **Chrome, Edge, and other Chromium browsers (Android and desktop)**: open the browser menu and select **Install app** (or **Add to Home screen**).
- **Safari on iPhone and iPad**: tap **Share**, then **Add to Home Screen** (required on iOS and iPadOS before enabling background alerts).
- **Safari on macOS**: choose **File → Add to Dock…** (or **Share → Add to Dock**).
- **Firefox on desktop**: desktop Firefox does not install web apps; use **OMP Sessions** in a standard browser tab.

## When something looks wrong

- **`That session changed or expired.`, `That notification changed or expired. Choose a current session.`, `That alert changed or expired.`, or `Mac/session ended`**: the request was already answered elsewhere, or the OMP process exited or restarted with a new generation. Tap **Back to Sessions** (or **Sessions**) and open the current card from the directory.
- **Directory offline vs. relay unavailable**:
  - Directory banners keep the last-seen list visible and name the failing hop: `You're offline` (this device has no connection), `Tailnet unreachable` (Tailscale is off or logged out on this device), `Desktop unreachable` (your tailnet is up, but the computer is asleep or the gateway stopped — tap **Try again**), or `Gateway unavailable` (live updates paused; reconnects automatically).
  - Inside an open session, the header chip and triage bar distinguish `Gateway unavailable — retrying…` (the tailnet connection to your computer dropped) from `Relay unavailable — retrying…` (the encrypted OMP relay connection dropped while the gateway is still reachable).
- **Stuck connection on Android after sleep or a network change**: Chrome on Android can wedge its network stack after switching between Wi-Fi and cellular while Android itself remains online. **OMP Sessions** retries automatically and, after 45 seconds of uninterrupted visible failure, shows **Troubleshooting** (`Still unreachable?`): open Android **Settings → Apps**, select the browser, tap **Force stop**, and reopen **OMP Sessions**.
- **Page reloads after a gateway update**: when the gateway activates an updated service worker, the page waits until no launch is in flight and no View or Control session is open, then reloads the idle directory automatically after 1 second.

For workstation checks, service management, and `omp-gateway doctor`, see [operator troubleshooting in `OPERATIONS.md`](OPERATIONS.md#troubleshooting-by-symptom).
