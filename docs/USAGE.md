# Using OMP Sessions

This guide is for the person holding the phone. It covers installing **OMP Sessions**, reading the directory, answering requests that are waiting for you, opening **View** and **Control**, working across several hosts, background alerts, and starting a new session. A host is a computer that runs the gateway and Oh My Pi (OMP).

## Install as an app

Before you start, install Tailscale on your device, connect to your private Tailscale network (tailnet), and confirm in the Tailscale app that the login your administrator allowed is shown ([Tailnet access policy](OPERATIONS.md#4-tailnet-access-policy)). Get your gateway's `https://` address from your host setup ([Installation and operations](OPERATIONS.md)); if you use several hosts and some sleep, install the app from one that stays awake so it can send background alerts.

Always install the directory address itself (`https://host.example.ts.net`), never an individual collaboration link. A **View** or **Control** link is a secret that grants access to a session; the app fetches one each time you open a session and never saves it. Reloading **OMP Sessions** always returns to the directory.

1. Open your gateway's Tailscale Serve HTTPS address (for example `https://host.example.ts.net`) in your browser and confirm the **Sessions** (or **Needs you**) heading loads (if no sessions are running yet, **Sessions** shows `No live sessions`). That host is your home gateway — the gateway that serves the installed app and sends its alerts.
2. Install **OMP Sessions** for your platform:
   - Android and desktop Chromium (Chrome, Edge): open the browser menu and select **Install app** or **Add to Home screen**.
   - iPhone and iPad (Safari on iOS and iPadOS 16.4 or later): tap **Share**, then **Add to Home Screen**, and open **OMP Sessions** from your Home Screen (Safari requires the Home Screen app before enabling background alerts).
   - macOS (Safari): choose **File → Add to Dock…** (or **Share → Add to Dock**).
   - Desktop Firefox: Firefox does not install web apps; use **OMP Sessions** in a standard browser tab.

## First run

When **OMP Sessions** opens on a new device or browser profile, it walks through three short floating panels, called trays, after the directory loads:

1. **Connected** confirms your phone is on your tailnet, shows how many live sessions are listed, and states `Capabilities are requested only when you tap an action.` Tap **Next** to continue, or tap the top-left close button (`Skip introduction`) or swipe the tray down to skip.
2. **Background alerts** lets you tap **Enable background alerts** right away, or tap **Not now** (or **Next**) to continue without enabling them.
3. **View or Control** summarizes read-only **View** (`Watch a session live. Nothing you do reaches it.`) and writable **Control** (`Answer requests and send prompts. Opens only when you tap it.`). Tap **Done** to finish.

Tap the top-left back arrow on **Background alerts** or **View or Control** to return to the previous tray. If you reload or close the tab while **Background alerts** or **View or Control** remains open, your next visit resumes on that step; reloading on **Connected** starts again at **Connected**.

Closing the tray on any step (with `Skip introduction`, swipe-down, or **Done**) marks the introduction complete on this device. Tap **Settings** in the top-right toolbar to open the **Background alerts** settings tray at any time.

## The directory

The directory heading and state pill tell you immediately whether any session needs input:

- **All clear**: when live sessions are running, none are waiting for input, and every host in view is up to date, the heading reads **Sessions** with a green `Live · N` pill, an **All clear** summary (`Nothing needs you.`), and **Live sessions** sorted newest first. Inside **All clear** on a single host with alerts off, **Enable alerts to get pinged** (or **Alerts blocked · Settings**) opens **Background alerts**.
- **Needs you**: when one or more sessions are waiting for input (or held), the heading switches to **Needs you** with an amber `N waiting` or `N waiting · M held` pill.
- **No live sessions**: when no shared `omp` process is running in the current view, the empty state shows `No live sessions` (`Start an interactive OMP process.`). Once automatic collaboration sharing (`control` or read-only `view`) is enabled on the host ([OMP configuration](OPERATIONS.md#5-omp-configuration)), new interactive `omp` sessions appear within 10 seconds.

Light and dark appearance follows your device setting automatically with no toggle, and color marks state only: green when live (or when an answer is accepted), amber when waiting for you, and red when access is denied.

Each row under **Live sessions** shows session details only: the session title (or working-folder name, falling back to `OMP session`), the folder name when different from the title, activity (`Working`, `Idle`, or `Activity unknown`), uptime (`up <1m`, `up 12m`), and model name. `Idle` means no agent reply is running while `omp` stays open in your terminal; `Activity unknown` means that `omp` version does not report whether a reply is running.

Waiting and held rows show the title, folder name, and wait time (`waiting 3m`). Host labels appear on rows only when **All hosts** is selected across multiple hosts.

The directory never displays transcripts, prompt choices, answers, or collaboration links, and there is no manual refresh button: live updates and automatic reconnects refresh the list when you unlock your phone or return to the app.

Interactive `omp` sessions started inside Tern (an optional terminal execution environment) panes, tabs, or windows appear in **OMP Sessions** like any other terminal session, and opening one uses **View** or **Control** in your browser rather than focusing or sending keystrokes to Tern ([Running OMP inside Tern](OMP_INTEGRATION.md#running-omp-inside-tern)).

## Needs you

On a single host, waiting sessions are ordered oldest first by when each request started waiting; when **All hosts** is selected across multiple hosts, waiting sessions are ordered by when this open page first saw each request (`observed waiting order`).

The oldest waiting request in view is promoted to the **Up next** card, showing `Waiting for your input` (or `Waiting for your input — Control unavailable` when the session was shared read-only):

- Tap **Open request** to open **Control** focused on that request inside the floating request tray (tap the expand icon in the tray header, `Expand to full screen`, to promote the same live session to full screen without reconnecting). When a waiting session is read-only, the primary button is **View transcript**.
- Tap **Options** on the **Up next** card to open the **This request** tray, which offers **Hold for desk** and **View transcript** (full-screen read-only **View**).

Additional waiting sessions appear below the card under **Then**, followed by **On hold · N** and **Live sessions · N** (or **Sessions · N** if a configured host could not be checked). Tapping any row under **Then** opens that request in the request tray.

When you submit an answer in **Control**, the bottom triage bar shows `Sending…` until OMP confirms delivery. Once confirmed, the bar stays up for 8 seconds: it offers **Next ask →** (`✓ Answered — 1 more needs you` or `✓ Answered — N more need you`) when other requests are waiting, or **Sessions** (`✓ Answered — all clear · N live`) when the queue is clear, returning to the directory at the scroll position you left.

## View and Control

Tapping a session fetches a fresh collaboration link from OMP on demand and opens OMP's encrypted collaboration client without saving the link to the address bar, browser history, or storage.

To return to the directory from full screen, tap the top-left back button (labeled **Sessions** on wider screens) or use browser Back; from a request tray, tap its close button or swipe the grip down.

- **View** is read-only (`Read-only session — watching only`): tapping any row under **Live sessions** opens **View** so you can read the live transcript and tool output without sending input. If the host shared the session with Control enabled, tap **Control** in the top bar to switch to writable mode in place.
- **Control** is writable: send prompts, answer waiting requests, or tap **Stop** to abort a running reply.

To attach images in **Control**:

1. Tap **Photo** in the composer and choose **Take photo** (rear camera) or **Choose existing** (photo library or files). You can attach up to 4 JPEG, PNG, or WebP images per prompt (source files up to 24 MiB, 8,192 px per edge, and 20 megapixels, resized in the browser to metadata-free JPEGs within 2,048 px and 1 MiB).
2. Add an optional note and tap **Send**.
3. Wait while the composer shows `Sending photo…` or `Sending photos…` and the send button reads **Sending…** until the host transcript confirms delivery. If confirmation takes longer than 5 seconds, the notice reads `Photo not confirmed. Tap Send to retry.` and the send button changes to **Retry**, keeping your staged photos and note so you can tap **Retry**.

### Dictation and speech input

In **Control**, you can dictate with your device's system keyboard on any host, or with the optional in-page recognizer when your administrator enables browser speech recognition on the home gateway ([Gateway configuration reference](OPERATIONS.md#14-gateway-configuration-reference)):

- Keyboard dictation: focus the **Control** composer, tap your system keyboard's microphone key, edit the text if needed, and tap **Send**. Tap **Dictate help** below the composer to show the built-in reminder (`Use your keyboard's microphone key to dictate into this box. iPhone: Settings → General → Keyboard → Enable Dictation. Dictation never sends — tap Send when the text is right.`).
- In-page speech recognizer (**Start speech** appears in **Control** only when enabled on the home gateway and supported by your browser's Web Speech API):
  1. Tap **Start speech**. On the first use after loading the page, read the privacy notice (`Your browser or OS may send audio to its speech provider before any OMP prompt is sent.`), tap **Start recording** (or **Not now** to cancel), and allow microphone access if your browser prompts.
  2. Speak while the status shows `Starting…` and `Listening…` (up to 2 minutes per recording), then tap **Stop recording** when finished or **Cancel recording** to discard.
  3. Edit the recognized draft under **Review speech text** (up to 8,000 characters) and tap **Use text** to insert it into the composer, or **Discard** to clear it.
  4. Check the composer text and tap **Send**. **Use text** only edits the draft and never sends automatically.

Speech controls never appear in read-only **View**, and switching to **View**, hiding the app, losing connection, or leaving the session cancels active recording immediately.

## Hold and hide

**Hold for desk** and **Hide** change only this browser and leave the `omp` process running in your terminal:

- **Hold for desk** defers a waiting request on this device without answering it in OMP. Tap **Options** on the **Up next** card and choose **Hold for desk** in the **This request** tray, or open any waiting request (including one under **Then**) and tap **Hold → next** in the bottom triage bar (`Need the desk for this one?`).
- Holding closes any open notification for that request on this device and moves the session under **On hold · N** (when every waiting request is held, the summary reads `Queue clear · N on hold — handle at desk`). Tap **Requeue** on a held row to return it to **Needs you**, or tap the row itself to open it in the request tray.
- **Hide** removes a non-waiting row under **Live sessions** on this device: tap the hide icon (crossed-out eye) at the right end of the row. A 5-second banner tray shows `Hidden on this device` and the session title with **Undo**, and a footer shows `N hidden on this device` with **Show all** to restore every hidden session in view.
- If a hidden session starts waiting for input or begins a new generation (OMP's counter that changes when a session is replaced, such as starting or resuming another session in that terminal), it reappears automatically.

<a id="multiple-hosts-all-hosts-and-host-picker"></a>
## Multiple hosts

Once your administrator enables multiple hosts ([Multiple hosts in Operations](OPERATIONS.md#7-multiple-hosts)), one installed **OMP Sessions** app lists and opens sessions across up to 8 hosts (your home gateway plus up to 7 remote hosts, where a remote host is another gateway the app lists or receives alerts from):

- **Host** picker: use the **Host** selector under the directory heading to switch between **All hosts**, your home gateway, and each configured remote host. While the app is visible, each remote host refreshes every 10 seconds with a 5-second timeout.
- Host labels: rows and the **Up next** card show their host label only when **All hosts** is selected; open **View** and **Control** sessions always show the host label in the top bar when multiple hosts are configured. When a single-host filter is empty, tap **All hosts** in the empty state to switch back.
- Incomplete host coverage: **All clear** (`Nothing needs you.`), `Live · N`, and `No live sessions` appear only when every host in the selected view is current. When any host in view cannot be checked or has remote alerts disconnected, the pill reads `Listed · N` and the summary shows **Host coverage incomplete** (`N of M hosts up to date. Other sessions may be missing.`, or `Known work only. Alerts unavailable for <hosts>.`).
- Unreachable remote host: last-seen rows stay visible in a dimmed, non-launchable state for 35 seconds (then clear until the host responds again), and a status row under the directory heading shows `<Host>: Host unavailable. List as of <time>.` (or `<Host>: Host unavailable. No session list received yet.`) with **Retry**.
- Access denied or host-list failure: if access is denied on a remote host, its rows clear at once, any open session from it closes, and its status row shows `<Host>: Access withdrawn.`. If the home gateway cannot load its configured host list on startup, a banner shows **Fleet configuration unavailable** (`The local list is available. Try again to check the configured hosts.` — sessions on your home gateway remain visible) with **Try again**.
- Direct fallback: if your home gateway is asleep or offline while a remote host is awake, open that remote host's own Tailscale Serve HTTPS address directly in your browser.

## Background alerts

Background alerts (Web Push notifications) notify you when **OMP Sessions** is closed and are opt-in per device. On iPhone and iPad (iOS and iPadOS 16.4 or later), Safari in a browser tab shows **Background alerts unavailable**; add **OMP Sessions** to your Home Screen and open the Home Screen app first.

1. Tap **Settings** in the top-right toolbar to open the **Background alerts** tray.
2. Tap **Enable background alerts** and approve your browser's notification prompt (**OMP Sessions** asks for permission only when you tap enable). To turn alerts off later, open **Settings** and tap **Disable background alerts**; if permission was denied, the button shows **Notifications blocked** (`Notifications are blocked. Enable them in this site's browser settings.`).
3. Tap **Alert detail** in the **Background alerts** tray to open the **Alert detail** tray and choose what the gateway includes for this device (payloads are built at the chosen level on the gateway, never redacted on the phone):
   - **Private**: fixed title only (`OMP session needs attention` or `OMP session activity stopped`), with no session details.
   - **Session** (*default*): session title and folder name.
   - **Preview**: session details plus a bounded request preview when available. OMP does not send prompt previews to the gateway, so **Preview** includes the same session and folder names as **Session**; choose **Private** if you want no session names in notification history, screenshots, or wearables.

Tapping `OMP session needs attention` checks that the exact request is waiting and opens **Control**. When an `omp` session that reports `Working` finishes a reply without waiting for input, the gateway sends `OMP session activity stopped`; tapping a stop alert opens read-only **View**, never **Control**.

Alerts expire after 5 minutes if your device is unreachable, and the gateway checks OMP every 10 seconds, so a brief reply that finishes between checks may not send an alert, and Android Doze or browser force-stop can delay or block delivery ([Platform and alert support](COMPATIBILITY.md#current-claim)). By default, alerts and the app icon badge cover your home gateway only (`Alerts cover this host (<label>) only.`).

### Alerts from other hosts

Your home gateway can also send background alerts for remote hosts once your administrator enables remote alerts on both sides ([Alerts from other hosts in Operations](OPERATIONS.md#8-alerts-from-other-hosts)). Your home gateway must stay awake and reachable (`This home gateway sends all enabled hosts' alerts. Fleet alerts need it awake and reachable.`); if you installed the app from a laptop that sleeps, install it from an always-on host's HTTPS address instead.

1. Open **Settings** and enable background alerts on this device if they are off. A **Hosts** section appears in the **Background alerts** tray when your home gateway offers remote alerts.
2. Turn on the switch next to each remote host you want alerts from. While you are signed in to Tailscale, your browser registers a 30-day approval directly with that remote host in the background (renewed automatically when you open the app within 10 days of expiry).
3. Check that the row status changes from `Connecting…` to `Covered` (`All selected hosts covered` when every selected host is connected, or `N of M selected hosts covered`).

Turn a host's switch off under **Hosts** to stop its alerts on this device (`Off`).

| Row status | Meaning and what to do |
|---|---|
| `Covered` | Connected; your home gateway is receiving live alert updates from this host. |
| `Connecting…` | Waiting for the initial alert feed response from this host. |
| `Unreachable · showing last known` | Your home gateway cannot reach this host; last-known waiting requests stay counted until it reconnects. |
| `Needs approval on this host` | Your 30-day approval expired or your login was removed; tap **Reconnect** on that row while signed in to Tailscale. |
| `Host gateway does not support alerts` | Remote alerts are not enabled on that host; ask your administrator to configure it ([Alerts from other hosts](OPERATIONS.md#8-alerts-from-other-hosts)). |
| `Off` | Alerts from this host are turned off on this device. |

At **Private**, remote alerts show only `OMP session needs attention` or `OMP session activity stopped`. At **Session** and **Preview**, a remote host's alert shows only that host's label and a six-character session suffix (for example `Workstation · bb2222`), never a session title, folder, or preview; alerts from your home gateway prefix its own host label before the session and folder names.

Tapping a remote alert rechecks that host directly before opening **Control** (for an input request) or **View** (for an activity stop). If the request was already answered, the session ended, or the host or approval changed, nothing opens and **OMP Sessions** shows `That notification changed or expired. Choose a current session.` (or `That alert changed or expired.` in the bottom triage bar when a session is open).

The app icon badge counts known waiting writable requests across your enabled hosts, including last-known requests from an unreachable host; when the count is zero while any selected host is not `Covered`, the badge shows an unnumbered marker instead of clearing. For notification ordering rules, see [Fleet notifications](ATTENTION_SPEC.md#fleet-notifications).

## Start a new session

When your administrator enables Tern session creation on the host where Tern and OMP run ([Tern session creation in Operations](OPERATIONS.md#9-tern-session-creation)) and Tern is open on that host, **OMP Sessions** can start a new interactive `omp` session in a Tern tab and open it in **Control**:

1. Tap **New session** in the top toolbar (or on the empty `No live sessions` screen). With multiple hosts configured, choose the execution host in the **Host** tray (`Choose the execution host. OMP will start in Tern there.`); with one host, this step is skipped.
2. Select an administrator-approved **Project**, **Working copy** (checkout folder, skipped when the project has only one), and **Profile** (OMP startup command). Tap the top-left back arrow (`Back`) to revise an earlier step; your last choices per host are preselected next time on this device.
3. In the **Create session** tray, optionally type a **First task (optional)** draft (up to 8,000 characters). Closing or reloading the page clears an unsent draft.
4. Tap **Create and open Control**. The **Starting session** tray steps through `Starting in Tern`, `Waiting for OMP`, and `Opening Control`.

Tapping **Close** on **Starting session** (`Close stops watching here. It does not stop the command on the host.`), backgrounding the app, reaching the 2-minute watch limit, or losing the host's reply stops waiting on your phone while the host finishes starting the session; reopen **New session** to see **Stopped watching** and tap **Check creation** without starting a duplicate process.

| Outcome | What to do |
|---|---|
| Opens full-screen **Control** | `Joining session…` tracks transcript load in the top bar; review any **First task** draft in the composer and tap **Send**. |
| **Stopped watching** | Tap **Check creation** to check that same start request, or inspect Tern and the directory before tapping **Start another session**. |
| **Started in Tern** | Tern ran the command without a **Control** session (`Tern started the command, but OMP could not be opened here.`); tap **Refresh directory** or check Tern. |
| **Session did not start** | Validation or startup failed before any command ran; fix the host condition and tap **Start another session**. |
| **Outcome unknown** | The reply was lost after start (`It may have started. Check Tern and the directory before creating another.`); check Tern and **Refresh directory** first. |
| **Creation unavailable** / **Creation not accepted** | Creation is unconfigured, Tern is closed on that host, or another start is running; tap **Retry options** or **Review choices**. |

Any **First task** draft is placed into the empty **Control** composer once when the session opens and is never sent automatically. **Session did not start** (`The operation did not start a command. A new attempt needs another explicit Create action.`) and **Creation unavailable** (`Tern is unavailable on this host. Open Tern there before trying again.`) never spawn or retry a command automatically.

## When something looks wrong

Match the message on screen to see what happened and how to recover:

- `This tailnet identity is not authorized.`, `<Host>: Access withdrawn.`, or `Access withdrawn` (`This identity can no longer access the session.`): your login is not on that gateway's allowlist, or this device uses a shared Tailscale server tag instead of a user login. Check Tailscale or ask your administrator to update the allowlist ([Tailnet access policy](OPERATIONS.md#4-tailnet-access-policy)); in a session, tap **Back to Sessions**.
- `That session changed or expired. Try again.`, `That session changed or expired. The list has been refreshed.`, `That notification changed or expired. Choose a current session.`, or `That alert changed or expired.`: the request was already answered elsewhere, or the `omp` process exited or started a new generation (such as opening or resuming a different session in that terminal). Tap **Sessions** (if inside a session) and pick a current row from the directory.
- `Ended` chip with `Session ended` or `Session ended · exit <N>`: the `omp` process in your terminal exited or switched sessions while open. Tap **Back to Sessions** to return to the directory.
- `You're offline`, `Tailnet unreachable`, `Desktop unreachable`, or `Gateway unavailable` banner in the directory: **OMP Sessions** keeps the last-seen list visible (`Showing the list as of <time>.`) and names what failed — no internet, Tailscale disconnected, host asleep or gateway stopped, or live updates paused (reconnects automatically). Restore connectivity or wake the host and tap **Try again**.
- `Still unreachable?` with **Troubleshooting** in the banner: after 45 seconds of continuous failure while online with the app open (such as Chrome on Android stalling after switching between Wi-Fi and cellular), tap **Troubleshooting**. On Android open **Settings**, then **Apps**, select the browser, and tap **Force stop**; on iPhone or iPad swipe it away in the app switcher; on a computer quit the browser; then reopen **OMP Sessions**.
- `Reconnecting…`, `Gateway unavailable`, or `Relay unavailable` chip inside an open session: brief drops show `Reconnecting…`; after 3 seconds, `Gateway unavailable` means your tailnet connection to the host dropped, while `Relay unavailable` means OMP's encrypted collaboration relay service dropped even though the gateway is reachable (`Retrying in <N>s` or `Reconnecting automatically…` in the bottom triage bar). Wait for automatic reconnection, or tap **Sessions** if the host went to sleep.
- Idle directory reloads on its own: after a gateway update, **OMP Sessions** waits until you are on the idle directory with no session open or starting, then reloads once after 1 second to load the updated app.

For host service checks and diagnostics on the computer running OMP, see [Troubleshooting by symptom](OPERATIONS.md#troubleshooting-by-symptom).
