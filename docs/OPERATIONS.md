# Installation and operations

This guide is for administrators setting up, running, and troubleshooting OMP Session Gateway across one to eight hosts:
- First-day setup (sections 1–6): install the user service, expose it over Tailscale Serve, set tailnet policy and Oh My Pi (OMP), verify health, and open **OMP Sessions**.
- Optional features (sections 7–9): add multiple hosts, alerts from other hosts, and Tern session creation in dependency order.
- Operations and reference (sections 10–15): update or roll back, revoke a lost device, run `doctor` and troubleshoot symptoms (10–12), or look up paths, `config.json` keys, and unsupported deployments (13–15).

## 1. One-time prerequisites

- Stock mainline OMP `>= 18.1.20` on `PATH` (`omp --version`).
- Bun `1.4.4` installed at a persistent path for the gateway user service (`bun --version`).
- Tailscale installed and signed in to the same private Tailscale network (tailnet) on the gateway host and your phone, with kernel TUN-mode networking on the gateway host (not userspace networking).
- Tailnet HTTPS certificates and MagicDNS (Tailscale's automatic DNS for tailnet hosts) enabled so [Tailscale Serve](https://tailscale.com/kb/1312/serve) can proxy tailnet HTTPS to loopback.
- A tailnet access policy granting only your intended users HTTPS access to the gateway host (template in [`../examples/tailscale-policy.hujson`](../examples/tailscale-policy.hujson)).

Keep your phone or browser device user-owned: tagged source devices carry no `Tailscale-User-Login` identity header and are denied by authorization.

Initial Tailscale login, gateway installation, and `collab.autoStart` setup happen once; starting `omp` afterward requires no per-session link copying.

## 2. CLI and daemon installation

Download the latest release archive from [GitHub Releases](https://github.com/carrythroughsystems/omp-session-gateway/releases/latest) and follow [Verify a published build](RELEASE.md#verify-a-published-build) before extracting or running it.

Releases published before the repository moved to `carrythroughsystems` (the closed tag set through v0.7.5) were signed under the original `alphastorm/omp-session-gateway` identity; the verification runbook selects that identity for those tags only. Never substitute the download URL for the certificate or attestation source identity.

Check these rules before running `install`:

- If you are upgrading from `v0.3.0` or earlier (releases that used `publisher-token`), stop and unregister that service with its own CLI first ([Recover across the v0.3.0 boundary](UPGRADE_ROLLBACK.md#recover-across-the-v030-boundary)).
- Run as your normal desktop user, never `root`.
- Keep Bun `1.4.4` at the persistent path used during `install`; the user service executes that exact path.

1. Extract the verified release archive and enter its directory.
2. Run `install` with your exact Tailscale HTTPS origin and login, then run `serve-guidance` to print your Tailscale Serve command.

On Linux and macOS:

```sh
tar -xf omp-session-gateway-*-bun.tar
cd omp-session-gateway-*-bun
bun apps/gateway/src/cli.js install \
  --origin https://host.example.ts.net \
  --allow you@example.com
bun apps/gateway/src/cli.js serve-guidance
```

On Windows in PowerShell (one command per line):

```powershell
tar -xf (Get-Item omp-session-gateway-*-bun.tar).Name
cd omp-session-gateway-*-bun
bun apps/gateway/src/cli.js install --origin https://host.example.ts.net --allow you@example.com
bun apps/gateway/src/cli.js serve-guidance
```

The installer writes or updates your private `config.json` ([13. Paths](#13-paths)), stages the verified runtime under `<stateDir>`, creates or retains `readiness-token` (a private loopback secret that proves service readiness to the CLI, separate from OMP's discovery tokens), registers and starts the user service, and activates the runtime once loopback readiness passes.

It prints the `tailscale serve` command for your origin and does not change Tailscale, tailnet policy, or OMP settings. Complete sections 3 to 5 before running `status` and `doctor` in [6. Check the installation and open the app](#6-check-the-installation-and-open-the-app).

The archive ships one bundled JavaScript CLI (`apps/gateway/src/cli.js`) plus static web assets and installs no shell alias. Throughout this guide, `omp-gateway <command>` is shorthand for `bun apps/gateway/src/cli.js <command>` run from the extracted release directory (or `bun "<stateDir>/installation/versions/<versionDirectory>/apps/gateway/src/cli.js" <command>` using `"versionDirectory"` from `<stateDir>/installation/current.json`):

- `omp-gateway install --origin <https-origin> --allow <login> [--port <port>] [--no-start]` — Write or update `config.json` (`--origin` and `--allow` replace `http.publicOrigin` and `auth.allowedLogins`; repeat `--allow` for each login), stage the runtime, and register and start the user service unless `--no-start` is passed on an inactive service.
- `omp-gateway serve-guidance` — Print the `tailscale serve` command and policy reminder for the configured origin and loopback port.
- `omp-gateway status` — Print JSON reporting whether the user service is installed, active, ready on loopback, and aligned with `installation/current.json`.
- `omp-gateway doctor [--bundle] [--output <path>]` — Run the 18 base checks plus up to three conditional feature checks and exit non-zero if any check fails, or write a redacted `omp-gateway-diagnostics.tar` archive with `--bundle`.
- `omp-gateway rollback [--to <version-dir>]` — Switch the active service back to the previous activated runtime (or a named retained directory) and verify readiness.
- `omp-gateway rotate-readiness-token` — Replace `readiness-token` and restart the active user service on the new secret.
- `omp-gateway uninstall [--no-stop]` — Stop the user service (unless `--no-stop` is passed while already inactive) and remove its autostart registration while keeping `config.json`, `readiness-token`, and `<stateDir>`.
- `omp-gateway serve [--dev-localhost] [--port <port>] [--origin <origin>]` — Run the daemon in the foreground (`cli.js` also runs `serve` when invoked under an `argv[1]` basename of `omp-gatewayd` with no arguments); `--dev-localhost` runs local loopback development mode without Tailscale.
- `omp-gateway help` (or `--help`) — Print command usage.

Each readiness-proven `install` keeps the active runtime plus the two most recent distinct predecessors in `installation/history.json` and prunes older staged directories. Keep verified release archives separately if you need to reinstall an older version.

| OS | User service | Starts when |
|---|---|---|
| Linux | `omp-session-gateway.service` (`~/.config/systemd/user/omp-session-gateway.service`) | Current-user `systemd` manager starts (`default.target`) |
| macOS | `omp-session-gateway` (`~/Library/LaunchAgents/omp-session-gateway.plist`) | Current user logs in to the desktop (`RunAtLoad`, not unattended boot) |
| Windows | `OMP Session Gateway` scheduled task (`%LOCALAPPDATA%\OMP Session Gateway\omp-session-gateway-task.xml`) | Installing user logs on interactively (`InteractiveToken`, not unattended boot) |

For supported and qualified host platforms and browsers, see [Platforms and browsers](COMPATIBILITY.md#platforms-and-browsers).

<a id="5-tailscale-serve"></a>
## 3. Tailscale Serve

Never run `tailscale funnel` or expose the gateway to the public Internet.

1. Print the exact Serve command for your configured `--origin` and `--port`:

   ```sh
   bun apps/gateway/src/cli.js serve-guidance
   ```

2. Run the printed `tailscale serve` command (for a default port-443 HTTPS origin and loopback port `4317`):

   ```sh
   tailscale serve --bg --https=443 http://127.0.0.1:4317
   ```

   If your `--origin` uses `:8443`, `serve-guidance` prints `--https=8443`.

3. Confirm the Serve mapping is active and verify that Funnel is disabled:

   ```sh
   tailscale serve status
   tailscale funnel status
   ```

The daemon stays bound to loopback behind Tailscale Serve. Serve strips incoming identity headers and adds `Tailscale-User-Login` for user-owned tailnet devices; because local loopback processes can forge headers directly, the supported host is a single-user workstation with no untrusted local accounts.

### Co-hosting on a dedicated HTTPS port

Path mounts (`tailscale serve --set-path`) are unsupported. A **View** or **Control** link is a bearer secret, called a capability in the contracts.

The gateway admits state-changing and capability requests by checking the exact `Origin` header (`http.publicOrigin`) and fetch metadata (`Sec-Fetch-Site`), so another application on the same browser origin could read session metadata and open **View** or **Control** links as the signed-in user. The **OMP Sessions** web app manifest scope, service worker, and history paths also require the origin root (`/`).

To share a Tailscale node with other web services, give the gateway its own HTTPS port (for example `8443`), install with the matching `--origin` (and `--port <port>` if `127.0.0.1:4317` is in use), and run the command printed by `serve-guidance`:

```sh
bun apps/gateway/src/cli.js install --origin https://host.example.ts.net:8443 --allow you@example.com
tailscale serve --bg --https=8443 http://127.0.0.1:4317
```

Grant `tcp:8443` in your [Tailnet access policy](#4-tailnet-access-policy); `doctor` checks `serveMapping` to confirm Tailscale Serve proxies `http.publicOrigin` to `http.hostname` and `http.port`.

<a id="6-tailnet-access-policy"></a>
## 4. Tailnet access policy

### Access policy and identities

Use [Tailscale Serve](https://tailscale.com/kb/1312/serve) over tailnet HTTPS as the only remote path and merge [`../examples/tailscale-policy.hujson`](../examples/tailscale-policy.hujson) into your tailnet policy file:

```jsonc
{
  "tagOwners": {
    "tag:omp-session-gateway": ["you@example.com"]
  },
  "grants": [
    {
      "src": ["you@example.com"],
      "dst": ["tag:omp-session-gateway"],
      "ip": ["tcp:443"]
    }
  ]
}
```

Replace `you@example.com` with the exact login passed to `--allow`, and use `tcp:8443` if your Serve origin uses port `8443` (never grant remote access to loopback port `4317`). [Tags](https://tailscale.com/kb/1068/tags) identify service hosts and strip user identity: save `tagOwners` first, assign `tag:omp-session-gateway` to each gateway host in Machines, and keep your phone user-owned ([Deployment dependency matrix](COMPATIBILITY.md#deployment-dependency-matrix)).

Prefer [grants over legacy ACLs](https://tailscale.com/docs/reference/grants-vs-acls) ([grant syntax](https://tailscale.com/docs/reference/syntax/grants), [policy syntax](https://tailscale.com/docs/reference/syntax/policy-file)). After tagging the gateway host, remove or narrow broader rules such as the default [allow-all policy](https://tailscale.com/kb/1018/acls) because grants are additive.

### Device admission: approval or Tailnet Lock

Choose one admission control for new tailnet nodes; [Device approval](https://tailscale.com/kb/1099/device-approval) and [Tailnet Lock](https://tailscale.com/kb/1226/tailnet-lock) are mutually exclusive ([Tailnet Lock limitations](https://tailscale.com/kb/1226/tailnet-lock#limitations)):

- Device approval: enable in the admin console under Device management and manually approve the gateway host and phone in Machines before they can exchange tailnet traffic; treat pre-approved auth keys as admission decisions.
- Tailnet Lock: maintain at least two separately protected signing nodes, store initialization disablement secrets offline, and sign the user-owned phone and gateway node with `tailscale lock sign` from a desktop signer (Android cannot act as a signer).

### Node key expiry and renewal

[Key expiry](https://tailscale.com/kb/1028/key-expiry) disconnects an expired host or phone until it reauthenticates; never enable Funnel or widen `--allow` to work around an expired key. Check expiry for both machines in the admin console: tagged gateway nodes default to disabled expiry, while user-owned phones should keep expiry enabled and reauthenticate in the Tailscale app.

To renew a CLI host, run `tailscale up --force-reauth` when you have local or alternate access (or use **Temporarily extend key** in Machines for a 30-minute recovery window), then recheck `tailscale serve status`.

### Optional source-device posture

You can narrow the grant to specific client attributes with [Device posture](https://tailscale.com/kb/1288/device-posture) (`srcPosture` in [`../examples/tailscale-policy.hujson`](../examples/tailscale-policy.hujson)) by replacing — not adding alongside — the unrestricted grant.

Check reported values in Machines before enforcing default attributes (`node:os`, `node:osVersion`, `node:tsVersion`, `node:tsReleaseTrack`, `node:tsAutoUpdate`, `node:tsStateEncrypted`; see [attribute reference](https://tailscale.com/kb/1288/device-posture#default-attributes)); App Store and Google Play builds report `node:tsAutoUpdate` as `false`.

Tailscale enforces posture on direct tailnet sources while the gateway enforces its `--allow` login list on [Serve identity](https://tailscale.com/kb/1312/serve#identity-headers); do not share the gateway node externally.

### Validate the combined controls

Preview your merged policy in [Access controls → Preview rules](https://tailscale.com/docs/features/tailnet-policy-file/manage-tailnet-policies#preview-changes), then run this three-step live check:

1. Allowed user device: open the HTTPS Serve origin on your allowed user-owned phone or browser and confirm the session directory loads.
2. Denied user device: open the HTTPS Serve origin from a device signed in as a different user (or blocked by policy) and confirm the request is blocked by Tailscale or denied (`403`) by the gateway.
3. Tagged source device: connect from a tagged device (`tag:...`) and confirm Tailscale blocks the connection or, if a policy rule permits the packet, the gateway returns `403` because no `Tailscale-User-Login` header is present.

<a id="7-omp-configuration"></a>
## 5. OMP configuration

Enable automatic collaboration sharing once in OMP (`examples/omp-settings.jsonc`):

1. Set `collab.autoStart` to `control` (or `view` for read-only remote access by default) and verify the saved value:

   ```sh
   omp config set collab.autoStart control
   omp config get collab.autoStart
   ```

   Run `omp config set collab.autoStart off` to restore the upstream default.

2. Start a new `omp` session after changing `collab.autoStart`; running `omp` processes keep the setting loaded at process start.

Participating sessions publish owner-only discovery files under `~/.omp/run/collab-hosts`, or `~/<PI_CONFIG_DIR>/run/collab-hosts` when `PI_CONFIG_DIR` is set (`%USERPROFILE%\.omp\run\collab-hosts` on Windows). If you use a custom `PI_CONFIG_DIR`, also set `omp.discoveryDir` in `config.json` because OS user services do not inherit shell exports; see [Operator settings](OMP_INTEGRATION.md#1-operator-settings).

<a id="8-androidpwa-installation"></a>
## 6. Check the installation and open the app

Run these checks from the extracted release directory after completing sections 1 to 5:

1. Check service alignment and loopback readiness:

   ```sh
   bun apps/gateway/src/cli.js status
   ```

   Confirm `"installed": true`, `"active": true`, `"ready": true`, and `"diverged": false`.

2. Run the host, Tailscale Serve, allowlist, PWA, discovery, and relay checks:

   ```sh
   bun apps/gateway/src/cli.js doctor
   ```

   Confirm every boolean check in the JSON report is `true` and the command exits `0` (see [12. `doctor` and diagnostics bundle](#12-doctor-and-diagnostics-bundle) if any check is `false`).

3. Complete the three-step live check in [Validate the combined controls](#validate-the-combined-controls) to verify that allowed user devices load the directory and denied or tagged devices are rejected.
4. Open your HTTPS Serve origin on your phone, confirm the session directory loads, and follow [Install as an app](USAGE.md#install-as-an-app) to add **OMP Sessions** to your Home Screen or Dock (and [Background alerts](USAGE.md#background-alerts) to enable Web Push). Reloading returns to the session directory by design; never bookmark or copy an individual collaboration link.

## 7. Multiple hosts

Configuring multiple hosts lets one installed **OMP Sessions** app on a home gateway (the gateway that serves the installed app) list and open **View** or **Control** sessions across up to seven remote hosts (another gateway the app lists or receives alerts from, up to eight hosts total including `local`).

You edit `config.json` on both sides: `fleet.targets` on the home gateway and `http.trustedDashboardOrigins` on each remote host ([ADR-036](DECISIONS.md#adr-036--federated-dashboard-origins-through-browser-direct-cors); route list in [Cross-origin access](PROTOCOL.md#cross-origin-access)).

Adding an origin to `http.trustedDashboardOrigins` lets JavaScript served by that home gateway list and launch sessions on the remote host as your signed-in Tailscale user, and start approved processes if `tern` is enabled there. Browser requests go directly to each remote host with no gateway proxy, shared login, or remote SSE stream; background alerts cover only the home gateway unless you also configure [8. Alerts from other hosts](#8-alerts-from-other-hosts).

### Multi-host setup

Prerequisites: Both gateways pass [6. Check the installation and open the app](#6-check-the-installation-and-open-the-app), your login is in `auth.allowedLogins` on every host, and your tailnet policy grants your user-owned phone HTTPS access to every host. Keep `config.json` valid strict JSON (without `//` comments) and preserve its owner-only permissions (`0600` on Linux/macOS; protected user DACL on Windows).

1. On the home gateway, merge `fleet.label` (optional) and `fleet.targets` into `<configDir>/config.json` ([13. Paths](#13-paths)):

   ```json
   {
     "fleet": {
       "label": "Studio",
       "targets": [
         {
           "id": "workstation",
           "label": "Workstation",
           "origin": "https://workstation.example.ts.net"
         }
       ]
     }
   }
   ```

2. On each remote host, merge the home gateway's exact `http.publicOrigin` into `http.trustedDashboardOrigins` in `<configDir>/config.json` alongside its existing `http`, `auth`, and `registry` settings:

   ```json
   {
     "http": {
       "hostname": "127.0.0.1",
       "port": 4317,
       "publicOrigin": "https://workstation.example.ts.net",
       "trustedDashboardOrigins": [
         "https://studio.example.ts.net"
       ]
     }
   }
   ```

3. On each edited host, re-run `install` with that host's `--origin` and every allowed `--allow` login to validate `config.json` and restart the service:

   ```sh
   bun apps/gateway/src/cli.js install --origin https://studio.example.ts.net --allow you@example.com
   ```

4. Run `bun apps/gateway/src/cli.js doctor` on each host, reload **OMP Sessions** on your phone so it fetches the updated `GET /api/v1/client-config`, and choose **All hosts** or **Workstation** in the **Host** picker to confirm remote sessions load without an error row ([Multiple hosts](USAGE.md#multiple-hosts)).

## 8. Alerts from other hosts

Alerts from other hosts — called fleet notifications in configuration and contracts ([ADR-048](DECISIONS.md#adr-048--fleet-notifications-through-the-home-gateway-as-coordinator)) — let the home gateway deliver background Web Push alerts for selected remote hosts, called sources. Because the home gateway pulls each source's identifier-only feed and sends every push, install the app on an always-on home gateway that stays awake and connected to your tailnet.

Configuration alone sends no alerts: after both administrators merge the settings below, each user enables **Background alerts** and approves each source from **OMP Sessions**. For coordinator and source mechanics, see [Architecture](ARCHITECTURE.md#13-omp-gatewayd) and [Fleet notifications](PROTOCOL.md#fleet-notifications).

### Fleet notification home setup

Prerequisites: The home gateway stays awake on the tailnet, the remote host is listed in `fleet.targets` ([Multi-host setup](#multi-host-setup)), and your tailnet policy lets the home gateway host itself reach each source host's HTTPS Serve port, because the home gateway daemon pulls each feed. When gateway hosts are tagged as in the example policy, that takes a grant from `tag:omp-session-gateway` to `tag:omp-session-gateway` on `tcp:443` or your Serve port.

1. On the home gateway, merge `notifications.sources` into `<configDir>/config.json`, naming one to seven existing `fleet.targets` IDs (omit `sources` rather than writing `[]`):

   ```json
   {
     "notifications": {
       "sources": ["workstation"]
     }
   }
   ```

   Removing or re-pointing a source clears alerts from its previous binding on restart.

2. Apply the configuration and verify that `doctor` reports `"fleetNotificationsHealthy": true`:

   ```sh
   bun apps/gateway/src/cli.js install --origin https://studio.example.ts.net --allow you@example.com
   bun apps/gateway/src/cli.js doctor
   ```

3. Complete [Fleet notification source setup](#fleet-notification-source-setup) on each remote host before enrolling from your phone.

### Fleet notification source setup

Prerequisites: The source host already lists the home gateway's exact origin in `http.trustedDashboardOrigins` and allows your login in `auth.allowedLogins` ([Multi-host setup](#multi-host-setup)).

1. On the source host, merge `notifications.coordinators` into `<configDir>/config.json` alongside `http.trustedDashboardOrigins`, keeping existing `http.hostname`, `http.port`, and `http.publicOrigin` (omit `coordinators` rather than writing `[]`):

   ```json
   {
     "http": {
       "hostname": "127.0.0.1",
       "port": 4317,
       "publicOrigin": "https://workstation.example.ts.net",
       "trustedDashboardOrigins": ["https://studio.example.ts.net"]
     },
     "notifications": {
       "coordinators": [{ "id": "studio", "origin": "https://studio.example.ts.net" }]
     }
   }
   ```

   Removing a coordinator, its trusted origin, or an owner's `auth.allowedLogins` entry and re-running `install` stops further feed events while leaving local Web Push and ordinary **View** and **Control** launches unchanged.

2. Apply the configuration and verify that `doctor` reports `"notificationGrantsHealthy": true`:

   ```sh
   bun apps/gateway/src/cli.js install --origin https://workstation.example.ts.net --allow you@example.com
   bun apps/gateway/src/cli.js doctor
   ```

3. Reload **OMP Sessions** on your phone, open **Settings** (`Background alerts`), enable local **Background alerts** if not already on, toggle on **Workstation** under **Hosts**, and confirm it reaches **Covered** ([Alerts from other hosts](USAGE.md#alerts-from-other-hosts)).

### Fleet notification state and recovery

Fleet notifications write two private version-1 files under `<stateDir>` ([13. Paths](#13-paths)):

- `<stateDir>/fleet-notifications.json` on the home gateway stores grant secrets, epoch, per-device source selections, and outstanding request identities (never titles, paths, previews, or push endpoints).
- `<stateDir>/notification-grants.json` on each source gateway stores grant IDs, coordinator origins, normalized owners, 30-day expiry timestamps, and SHA-256 verifiers (never grant secrets or session metadata).

Never copy either file between hosts, print its contents, or attach it to an issue or support report. `omp-gateway doctor --bundle` excludes both files, and `doctor` exposes only the booleans `fleetNotificationsHealthy` (on a configured home) and `notificationGrantsHealthy` (on a configured source).

If either file is corrupt, has unsafe permissions, or fails an atomic write, the gateway disables its fleet notification routes (`503`) without deleting the file, while ordinary session listing and **View** and **Control** launches keep working. On the home gateway, local background alerts fall back to Push v2 so local session notifications continue to arrive.

To recover when `fleetNotificationsHealthy` or `notificationGrantsHealthy` is `false`:

1. On Linux or macOS, restore owner-only permissions if file modes were widened (`fleet-notifications.json` on the home gateway or `notification-grants.json` on a source):

   ```sh
   chmod 600 "${XDG_STATE_HOME:-$HOME/.local/state}/omp-session-gateway/fleet-notifications.json"
   ```

2. If the file is corrupt (or has invalid ACLs on Windows under `$env:LOCALAPPDATA\OMP Session Gateway\state\`), restore a trusted private backup for that host or move the damaged file to a private recovery path outside `<stateDir>` — do not delete it blindly to hide corruption:

   On Linux and macOS:

   ```sh
   mv "${XDG_STATE_HOME:-$HOME/.local/state}/omp-session-gateway/fleet-notifications.json" \
     <private-backup-path>
   ```

   On Windows in PowerShell:

   ```powershell
   Move-Item -LiteralPath "$env:LOCALAPPDATA\OMP Session Gateway\state\fleet-notifications.json" -Destination <private-backup-path>
   ```

3. Re-run `omp-gateway install --origin <origin> --allow <login>` to restart the service, confirm `omp-gateway doctor` exits `0`, and if grants were replaced, tap **Reconnect** under **Hosts** in **OMP Sessions** ([Alerts from other hosts](USAGE.md#alerts-from-other-hosts)).

## 9. Tern session creation

Opt-in Tern creation (`tern` in `config.json`, [ADR-043](DECISIONS.md#adr-043--opt-in-tern-creation-with-omp-native-adoption)) lets **OMP Sessions** start a new interactive `omp` process in a Tern tab on the execution host from administrator-approved project, working-copy, and profile IDs, then open it in **Control**. It is absent by default (`not_configured`); ordinary session discovery and **View** and **Control** launches do not require Tern.

### Opt-in Tern session creation

Warning — trust boundary: Enabling `tern` lets allowed Tailscale logins — including JavaScript served by every origin in `http.trustedDashboardOrigins` — start processes on this host from your configured profiles. Removing a dashboard origin blocks new cross-origin API requests immediately, but does not stop an accepted creation or terminate a running `omp` process.

#### Prerequisites

- Execution host and open Tern window: configure `tern` on the host where Tern (`0.9.12` or later when `tern.window` is set) and `omp` run under the same OS user as `omp-gatewayd`, and keep Tern open with at least one window before running `doctor`.
- Platform test scope: end-to-end Tern creation has been exercised on Apple silicon macOS, while Linux and Windows coverage is unit-tested only (see [What the words mean](COMPATIBILITY.md#what-the-words-mean)).
- `collab.autoStart` set to `control` inside Tern: `profile.env` supplies only the `tern` CLI child's environment and does not cross Tern's server boundary into the new pane. Inside a Tern shell on that host, confirm `omp` publishes to `omp.discoveryDir` and has `control` enabled (`view`-only sessions cannot complete **Create and open Control** adoption):

  ```sh
  omp config set collab.autoStart control
  omp config get collab.autoStart
  ```

- Optional window slot (`tern.window`): omit `tern.window` to keep Tern's default window, set `""` for the first window, or set `"2"` through `"999"` (`new tab --window KEY --json --keep-open --cwd <path> -- <argv…>` and `inspect --json --window KEY`).
- Reassignable slot behavior: window keys are reassignable slots rather than persistent identities, so keep the target window open (`tern inspect --json --window 2` checks a slot read-only); a missing slot fails preflight without falling back to another window.
- Canonical working copies and complete CLI environment: every `workingCopies[].path` must equal its canonical `realpath` without symlinks, `executable` and `profile.argv[0]` must be absolute executable paths, and `profile.env` must supply the complete `tern` CLI environment (`2`–`16` entries, including absolute `HOME` and `PATH` entries). See [14. Gateway configuration reference](#14-gateway-configuration-reference) for full bounds.

#### Setup steps

1. Verify canonical working-copy and executable paths on the execution host (`workingCopies[].path` must match the printed canonical path):

   On Linux and macOS:

   ```sh
   realpath /home/user/Development/website
   which tern omp
   ```

   On Windows in PowerShell:

   ```powershell
   bun -e "import { realpath } from 'node:fs/promises'; console.log(await realpath(process.argv[1]))" <working-copy-path>
   (Get-Command tern, omp).Source
   ```

2. Merge the `tern` section into `<configDir>/config.json` ([13. Paths](#13-paths)) alongside your existing `http`, `auth`, `registry`, `fleet`, and `speech` settings (remove `"window": "2"` if you want Tern's default window):

   ```json
   {
     "tern": {
       "executable": "/usr/local/bin/tern",
       "window": "2",
       "projects": [
         {
           "id": "website",
           "label": "Website",
           "workingCopies": [
             {
               "id": "main",
               "label": "main",
               "path": "/home/user/Development/website"
             }
           ]
         }
       ],
       "profiles": [
         {
           "id": "omp",
           "label": "OMP",
           "argv": ["/opt/homebrew/bin/omp"],
           "env": {
             "HOME": "/home/user",
             "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
           }
         }
       ]
     }
   }
   ```

3. Apply the configuration and restart the user service (each restart generates a fresh options `revision` UUID):

   On Linux and macOS:

   ```sh
   bun apps/gateway/src/cli.js install \
     --origin https://host.example.ts.net \
     --allow you@example.com
   ```

   On Windows in PowerShell:

   ```powershell
   bun apps/gateway/src/cli.js install --origin https://host.example.ts.net --allow you@example.com
   ```

4. Run `doctor` and confirm the JSON report includes `"ternAvailable": true` and exits `0`:

   ```sh
   bun apps/gateway/src/cli.js doctor
   ```

   `ternAvailable` checks configured runtime paths, read-only `tern inspect --json` usability (with `--window` when configured), and `<stateDir>/session-creations.json` readability without starting OMP.

5. Reload **OMP Sessions** on your phone and follow [Start a new session](USAGE.md#start-a-new-session) to pick a project, working copy, and profile and open the new session in **Control**.

### Creation outcomes

All creations pass `--keep-open` to Tern so failed commands remain visible in their tab, and wait up to the 110-second daemon adoption deadline (`SessionCreationStatus.state` in [Session creation state machine](PROTOCOL.md#session-creation-state-machine)):

| Outcome | What it means on the host | What the administrator does |
|---|---|---|
| `ready` | Tern opened the tab, OMP published to `omp.discoveryDir` with Control, and the gateway adopted `{ instanceId, generation }`. | None; **OMP Sessions** opens the session in **Control**. |
| `started_unavailable` | Tern started the tab, so the command ran, but no unique Control session was adopted within 110 seconds (or the daemon restarted). | Inspect the kept-open tab in Tern, confirm `omp config get collab.autoStart` is `control` inside Tern, and refresh the directory. |
| `failed` | Preflight validation (such as an unreadable discovery directory or missing `tern.window` slot), OS spawn, or pre-launch restart stopped before spawning. | Run `omp-gateway doctor`, check `tern` paths, `profile.env`, and `tern inspect --json --window <slot>`, then retry. |
| `outcome_unknown` | The `tern` CLI child started, so a tab may exist, but its output timed out, failed, or was interrupted; the gateway never auto-retries. | Check Tern tabs and **OMP Sessions** before starting another session so you do not start a duplicate `omp` process. |
| Browser stopped watching | Closing the tray, backgrounding, or hitting the 120-second browser watch limit stopped browser polling while the host operation continues. | Reopen **New session** in **OMP Sessions** to check the existing operation ([Start a new session](USAGE.md#start-a-new-session)). |

Native **Open in Tern** handoff from the browser is not provided ([tern-sdk #143](https://github.com/stencil-hq/tern-sdk/issues/143)).

### Creation ledger recovery

`<stateDir>/session-creations.json` is a private version-1 ledger (`0600` on POSIX / protected user ACL on Windows, at most 64 records, 24-hour retention from acceptance, 512 KiB maximum). It stores owner, operation, and request IDs, timestamps, state, optional decimal Tern block ID, ready `{ instanceId, generation }`, and closed error codes — never capabilities, labels, first-task drafts, paths, `argv`, `env`, or raw CLI output.

On startup or shutdown, the daemon marks unfinished records `interrupted` (`accepted` → `failed`, `launching` → `outcome_unknown`, `awaiting_omp` → `started_unavailable`) without resuming adoption or re-spawning.

If `session-creations.json` is corrupt, exceeds 512 KiB, uses an unknown version, or has unsafe permissions, creation fails closed (`ledger_unavailable` and `"ternAvailable": false` in `doctor`) while existing session discovery and launches keep working. Because the daemon never overwrites an invalid ledger automatically, recover with these steps:

1. Check Tern and **OMP Sessions** first to see whether an earlier creation started an `omp` process.
2. Restore private permissions if modes were widened on Linux or macOS, or move a corrupt file (or one with invalid ACLs on Windows) to a private path outside `<stateDir>` — never paste it into an issue (`doctor --bundle` excludes it):

   On Linux and macOS:

   ```sh
   chmod 600 "${XDG_STATE_HOME:-$HOME/.local/state}/omp-session-gateway/session-creations.json"
   # Or, if the file is corrupt:
   mv "${XDG_STATE_HOME:-$HOME/.local/state}/omp-session-gateway/session-creations.json" \
     <private-backup-path>
   ```

   On Windows in PowerShell (when corrupt or ACLs are invalid):

   ```powershell
   Move-Item -LiteralPath "$env:LOCALAPPDATA\OMP Session Gateway\state\session-creations.json" -Destination <private-backup-path>
   ```

3. Re-run `omp-gateway install --origin <origin> --allow <login>` to restart the service, then run `omp-gateway doctor` to confirm `"ternAvailable": true`. Moving `session-creations.json` clears the 24-hour idempotency history, so do not replay an older creation request afterward.

Managed `rollback` removes `tern` from `config.json` after saving `<configDir>/config.pre-rollback.json` and leaves `session-creations.json` and running Tern tabs untouched; see [Tern creation on every managed rollback](UPGRADE_ROLLBACK.md#tern-creation-on-every-managed-rollback).

<a id="9-updates"></a>
## 10. Updates and rollback

To update the gateway to a newer release:

1. Download and verify the latest release archive ([Verify a published build](RELEASE.md#verify-a-published-build)).
2. Extract the archive and run the `install` command from [2. CLI and daemon installation](#2-cli-and-daemon-installation) with your production `--origin` and `--allow` flags.
3. Run `bun apps/gateway/src/cli.js status` and `bun apps/gateway/src/cli.js doctor` from the new extraction directory and confirm all checks are `true`.

`install` preserves your existing port unless `--port` is given, `http.hostname`, `http.trustedDashboardOrigins`, `registry` settings, authored `omp` overrides, `fleet`, `speech`, `tern`, `notifications`, and `auth.trustIdentityWithoutTailnetDevice` when `true`, along with `readiness-token` and state files under `<stateDir>`, switching the active runtime only after authenticated loopback readiness passes.

Running `omp` sessions do not need to be restarted; the next discovery poll repopulates the directory within `registry.heartbeatSeconds` (default `10` seconds).

To revert to a retained runtime and review which configuration keys rollback removes across version boundaries, follow [Roll back to a retained predecessor](UPGRADE_ROLLBACK.md#roll-back-to-a-retained-predecessor).

<a id="10-lost-phone-and-revocation"></a>
## 11. Lost phone and revocation

If a phone or browser device with tailnet access is lost or compromised:

1. Remove or expire the device in Tailscale (Machines console) and revoke identity-provider sessions if the account itself may be exposed.
2. Tighten or disable the user grant in your tailnet policy if other devices on that login should also be blocked, or run `omp-gateway uninstall` on the host to stop all directory access immediately.
3. Stop active OMP collaboration rooms by exiting participating `omp` processes or running `/collab stop` in each session; blocking tailnet or gateway access stops future directory and launch requests, while an open relay connection stays active until the `omp` process closes the room.
4. If background alerts were enabled on the lost device, remove `<stateDir>/push-state.json` (and `<stateDir>/fleet-notifications.json` if fleet notifications were enabled), restart the gateway with `omp-gateway install`, and re-enable **Background alerts** on your remaining devices; keep `readiness-token` unless the host itself was exposed (`omp-gateway rotate-readiness-token` rotates only the local CLI health secret).
5. Re-run `omp-gateway install` if you ran `uninstall` in step 2, then run `omp-gateway doctor` from the host to verify the gateway and Tailscale Serve configuration.

<a id="11-doctor-and-diagnostics-bundle"></a>
## 12. `doctor` and diagnostics bundle

`omp-gateway doctor` prints a JSON report with 18 base boolean checks plus up to three conditional feature checks and exits non-zero if any check is `false`:

- Local configuration and files (5): `config` (valid private `config.json`), `permissions` (private `readiness-token` and usable discovery path), `discoveryReadable` (`omp.discoveryDir` is absent or a private owner-only directory without symlinks), `assets` (built web assets present on disk), `compatibility` (`omp --version` on `PATH` is `>= 18.1.20`).
- Daemon and service (3): `daemon` (loopback HMAC readiness proof succeeds), `serviceInstalled` (user service definition exists), `serviceActive` (user service is running).
- Loopback and Tailscale boundary (5): `listenerLoopbackOnly` (listener bound to `127.0.0.1` or `::1` while the host owns a locally bound tailnet address), `loopbackTrustSound` (kernel TUN device present, not userspace networking), `tailscaleConnected` (`tailscale status` reports `Running`), `serveMapping` (`tailscale serve` proxies the exact `http.publicOrigin` host and port to the exact loopback listener), `funnelDisabled` (Tailscale Funnel is off).
- End-to-end Serve and relay health (5): `identityAllowed` (authenticated `GET /api/v1/sessions` over the public Serve origin returns `200` with `Cache-Control: no-store`), `sessionHealth` (every listed session has a valid `lastSeenAt` timestamp), `pwa` (`/`, `/manifest.webmanifest`, and `/service-worker.js` return `200`), `securityHeaders` (`Content-Security-Policy` includes `default-src 'self'`), `relay` (outbound `HEAD` to `https://my.omp.sh` succeeds without creating a capability).
- Conditional feature checks (0 to 3):
  - `ternAvailable` (included when `tern` is present in `config.json`): checks configured runtime paths, read-only `tern inspect --json` usability (with `--window` when set), and `<stateDir>/session-creations.json` validity without starting OMP.
  - `notificationGrantsHealthy` (included when `notifications.coordinators` is non-empty): checks that `<stateDir>/notification-grants.json` is absent or valid private version-1 state within 32 KiB.
  - `fleetNotificationsHealthy` (included when `notifications.sources` is non-empty): checks that `<stateDir>/fleet-notifications.json` is absent or valid private version-1 state within 1 MiB.

`doctor` tests the host and an allowed metadata request from the workstation; run the three-step live check in [Validate the combined controls](#validate-the-combined-controls) to confirm unauthorized and tagged devices are denied.

To create a redacted support archive without overwriting an existing file:

```sh
bun apps/gateway/src/cli.js doctor --bundle
```

Pass `--output <path>` to choose a custom filename. The archive (`omp-gateway-diagnostics.tar`) contains only `doctor.json` (product and protocol versions, OS/architecture, and the boolean check results, including any active conditional checks) and `manifest.json`.

It excludes capabilities, tokens, headers, logins, tailnet names, session titles, paths, transcripts, browser storage, raw logs, fleet notification state files, creation ledgers, `argv`/`env`, and raw Tern CLI output. Never paste a capability, token, fleet state file, or creation ledger into an issue.

### Troubleshooting by symptom

| Symptom | Cause | What to do |
|---|---|---|
| No sessions appear in **Sessions** | `collab.autoStart` is `off`, `omp` started before the change, `omp` `< 18.1.20`, or `omp.discoveryDir` mismatches `PI_CONFIG_DIR`. | Set `omp config set collab.autoStart control`, start a new `omp` process, and check `compatibility` and `discoveryReadable` in `doctor`. |
| `403`, **Access withdrawn**, or `This identity can no longer access the session.` | Tagged device (`tag:...`), login missing from `auth.allowedLogins`, or direct port `4317` access without Serve. | Sign in on a user-owned device, open the `https://` Serve origin, and re-run `omp-gateway install` if your login changed. |
| `loopbackTrustSound: false` (and `listenerLoopbackOnly: false`) | `tailscaled` runs in `--tun=userspace-networking` mode without a kernel TUN interface. | Reconfigure Tailscale on the host for kernel TUN mode, restart Tailscale, and re-run `omp-gateway doctor`. |
| `serveMapping: false` | `tailscale serve` is unset or proxies the wrong external HTTPS or loopback port. | Run `omp-gateway serve-guidance`, execute the printed `tailscale serve --bg ...` command, and check `funnelDisabled: true`. |
| `That session changed or expired. Try again.`, `That notification changed or expired. Choose a current session.`, or `Session ended` | The session advanced its generation (OMP's counter incremented when a session is replaced), the request cleared at the desktop, or `omp` exited. | Tap **Sessions** or **Back to Sessions** and open a current row if the session is running. |
| Banner shows `Desktop unreachable` / `Gateway unavailable` vs session shows **Relay unavailable** | `Desktop unreachable` / `Gateway unavailable` means `omp-gatewayd` is unreachable over Serve; **Relay unavailable** means `https://my.omp.sh` is unreachable. | Wake the host and check Tailscale and `omp-gateway status`, or check `relay` in `doctor` and outbound HTTPS to `https://my.omp.sh`. |
| Banner adds `Still unreachable?` and **Troubleshooting** after 45 seconds | Android Chrome wedged its network stack after sleep or a Wi-Fi/cellular switch. | Tap **Try again**; if unreachable after 45 seconds, fully close the browser hosting **OMP Sessions** and reopen **OMP Sessions**. |
| **Background alerts unavailable** in **Background alerts** | Browser notification permission is denied, or iPhone/iPad Safari opened a regular tab instead of a Home Screen app. | Add to Home Screen on iPhone/iPad ([Install as an app](USAGE.md#install-as-an-app)), open **Settings**, tap **Enable background alerts**, and allow notifications. |
| App returned to **Sessions** after an update or reload | Capabilities exist only in page memory; a service-worker update reloads an idle directory. | Tap the session row or **Open request** in **Sessions** to fetch a fresh capability. |
| Host row shows `<Host>: Access withdrawn.` vs `<Host>: Host unavailable.` | `Access withdrawn.` means CORS succeeded but `403` denied authorization; `Host unavailable.` means the cross-origin fetch failed or CORS blocked it. | See the multi-host isolation steps below, then tap **Retry**. |
| Banner shows **Fleet configuration unavailable** (`The local list is available. Try again to check the configured hosts.`) | `GET /api/v1/client-config` failed, returned invalid JSON, or `local.origin` differed from `location.origin`. | Open the exact `http.publicOrigin` URL configured on the home gateway and tap **Try again**. |

For remote host rows, the app polls configured remote hosts every 10 seconds while visible (5-second timeout, 35-second stale grace):

- `<Host>: Access withdrawn.` means `http.trustedDashboardOrigins` admitted the browser request, then the remote host returned `403` (missing login in `auth.allowedLogins`, tagged device, or `loopbackTrustSound: false` on that host); check `auth.allowedLogins` and `omp-gateway doctor` on that host.
- `<Host>: Host unavailable.` (followed by `No session list received yet.` or `List as of <time>.`) means the browser could not read a response because the host is offline, tailnet/MagicDNS access failed, or `http.trustedDashboardOrigins` omits the home gateway's exact `http.publicOrigin`; open the remote `https://` origin directly in a browser tab to separate a host outage from a missing `http.trustedDashboardOrigins` entry.

<a id="3-paths"></a>
## 13. Paths

The gateway keeps its private configuration and state separate from OMP's discovery directory and never writes capabilities to disk:

- Gateway config directory (`<configDir>`): `${XDG_CONFIG_HOME:-~/.config}/omp-session-gateway` on Linux and macOS; `%LOCALAPPDATA%\OMP Session Gateway` (`$env:LOCALAPPDATA\OMP Session Gateway` in PowerShell) on Windows.
- Gateway state directory (`<stateDir>`): `${XDG_STATE_HOME:-~/.local/state}/omp-session-gateway` on Linux and macOS; `%LOCALAPPDATA%\OMP Session Gateway\state` on Windows.
- User service definition: `~/.config/systemd/user/omp-session-gateway.service` on Linux; `~/Library/LaunchAgents/omp-session-gateway.plist` on macOS; `%LOCALAPPDATA%\OMP Session Gateway\omp-session-gateway-task.xml` on Windows (registered as scheduled task `OMP Session Gateway`).
- OMP discovery directory (owned by OMP, read-only to the gateway): `~/.omp/run/collab-hosts`, or `~/<PI_CONFIG_DIR>/run/collab-hosts` when `PI_CONFIG_DIR` is set (`%USERPROFILE%\.omp\run\collab-hosts` on Windows).

Files stored under `<configDir>` and `<stateDir>`:

| File or directory | Location | Purpose |
|---|---|---|
| `config.json` | `<configDir>` | Private gateway configuration ([14. Gateway configuration reference](#14-gateway-configuration-reference)). |
| `config.pre-rollback.json` | `<configDir>` | Private backup saved by `rollback` before removing unsupported sections. |
| `readiness-token` | `<configDir>` | Private 43-character loopback readiness secret shared between CLI and daemon. |
| `installation/current.json` | `<stateDir>` | Pointer to the active staged runtime directory. |
| `installation/history.json` | `<stateDir>` | Activation order of up to 64 `<version>-<digest>` runtime directories. |
| `installation/versions/<version>-<digest>/` | `<stateDir>` | Staged release payloads (`apps/gateway/src/cli.js`, `apps/web/dist/`, `licenses/`). |
| `push-state.json` | `<stateDir>` | VAPID key pair and up to eight owner-bound Web Push subscriptions. |
| `notification-grants.json` | `<stateDir>` | Source-side fleet notification grant verifiers (when `notifications.coordinators` is used). |
| `fleet-notifications.json` | `<stateDir>` | Home-side fleet notification grant secrets, epoch, selections, and outstanding request IDs. |
| `session-creations.json` | `<stateDir>` | Capability-free Tern session creation ledger (when `tern` creation is used). |

The gateway reads each discovery file's `endpoint` field verbatim because OMP can relocate long Unix socket paths. Never edit or delete files inside OMP's discovery directory from the gateway.

<a id="4-gateway-configuration"></a>
## 14. Gateway configuration reference

`install --origin https://host.example.ts.net --allow you@example.com` creates or updates `<configDir>/config.json` (commented template in [`../examples/gateway-config.jsonc`](../examples/gateway-config.jsonc)):

| Key | Default | Bounds | Purpose |
|---|---|---|---|
| `http.hostname` | `"127.0.0.1"` | `"127.0.0.1"` or `"::1"` | Loopback bind address. |
| `http.port` | `4317` | Integer `1`–`65535` | Loopback HTTP port behind Tailscale Serve. |
| `http.publicOrigin` | Set by `--origin` | Canonical `https://` origin (`http://` loopback in `dev-localhost`) | External Tailscale Serve origin. |
| `http.trustedDashboardOrigins` | `[]` | `0`–`8` unique origins, `!= http.publicOrigin` | Home origins allowed cross-origin access. |
| `auth.mode` | `"tailscale-serve"` | `"tailscale-serve"` or `"dev-localhost"` | Serve identity check or local loopback dev mode. |
| `auth.allowedLogins` | Set by `--allow` | `1+` strings (`1`–`320` chars, no `*`) | Lowercased `Tailscale-User-Login` allowlist. |
| `auth.trustIdentityWithoutTailnetDevice` | `false` (absent) | `boolean` | Test-harness override; never set on production hosts. |
| `omp.discoveryDir` | `~/.omp/run/collab-hosts` | Non-empty absolute path, no NUL | Discovery path override when `PI_CONFIG_DIR` is not inherited. |
| `omp.queryTimeoutMs` | `1500` | Integer `250`–`10000` | Per-session `snapshot` or `link` timeout in milliseconds. |
| `registry.heartbeatSeconds` | `10` | Integer `2`–`60` | Seconds between discovery directory polls. |
| `registry.ttlSeconds` | `35` | Integer `5`–`300`, `> 2 × heartbeatSeconds` | Seconds an unreadable session card stays retained. |
| `registry.maxSessions` | `100` | Integer `1`–`1000` | Maximum concurrent sessions tracked in memory. |
| `fleet.label` | First DNS label of `http.publicOrigin` | `1`–`64` NFC code points | Display label for this host in **OMP Sessions**. |
| `fleet.targets` | `[]` | `0`–`7` `{ id, label, origin }` objects | Remote hosts polled by this home gateway (`8` max with `local`). |
| `speech.browserRecognition` | `false` | `boolean` | Enables `microphone=(self)` and in-page speech in **Control**. |
| `tern` | Absent | Optional object, `<= 32` KiB | Opt-in Tern session creation recipe ([9. Tern session creation](#9-tern-session-creation)). |
| `tern.executable` | Required in non-empty `tern` | Absolute file path, `<= 4,096` UTF-8 bytes | Path to the `tern` CLI executable. |
| `tern.window` | Absent | `""` or `"2"`–`"999"` | Optional Tern window slot for creation and `inspect`. |
| `tern.projects` | Required in non-empty `tern` | `1`–`16` `{ id, label, workingCopies }` | Approved projects (`1`–`8` `{ id, label, path }` copies each). |
| `tern.profiles` | Required in non-empty `tern` | `1`–`8` `{ id, label, argv, env }` | Approved command profiles (`argv` `1`–`32`, `env` `2`–`16`). |
| `notifications.sources` | Absent | `1`–`7` unique `fleet.targets` IDs | Remote hosts eligible for home fleet notifications. |
| `notifications.coordinators` | Absent | `1`–`7` unique `{ id, origin }` objects | Home coordinators allowed to pull this source's feed. |

Section validation rules:

- File rules: `config.json` must be a private regular file of at most 64 KiB (`0600` on Linux/macOS; protected owner plus `SYSTEM` DACL on Windows). Parsing fails closed on unknown keys, `null` values, wildcard addresses or logins, non-private permissions, or `ttlSeconds <= 2 × heartbeatSeconds`.
- `http` and `fleet`: origins must be canonical `https://` URLs in `tailscale-serve` mode; `dev-localhost` also permits canonical `http://127.0.0.1:<port>` or `http://[::1]:<port>` (`fleet.label` keeps the literal loopback host there).
- `fleet.targets` entries: `fleet.targets[].id` matches `^[a-z][a-z0-9-]{0,31}$` and cannot equal `"local"`; labels are NFC-normalized with control and bidirectional characters stripped (`1`–`64` code points); `id` and `origin` must be unique and differ from `http.publicOrigin`. For the cross-origin routes unlocked by `http.trustedDashboardOrigins`, see [Cross-origin access](PROTOCOL.md#cross-origin-access).
- `auth`: `auth.trustIdentityWithoutTailnetDevice` exists only for automated loopback harnesses on machines without Tailscale installed. Production hosts must never set it: on a host running `tailscaled --tun=userspace-networking`, setting it trusts spoofed `Tailscale-User-Login` headers from remote tailnet peers, and `doctor` reports `loopbackTrustSound: false` from the OS interface table (see [Network exposure](SECURITY.md#4-network-exposure)).
- `omp` and `registry`: only `ENOENT` or `ECONNREFUSED` proves a queried OMP session has exited; timeouts, permission or resource errors, and wire errors retain the card until `registry.ttlSeconds` expires, while sessions removed from `omp.discoveryDir` disappear on the next poll (an absent `omp.discoveryDir` is valid when no sessions are sharing).
- Retired `registry.maxPublishers`: the retired `registry.maxPublishers` key from `v0.3.0` and earlier is accepted and ignored when reading older files, then omitted the next time `install` writes `config.json`.
- `tern` objects and IDs: an empty `"tern": {}` is preserved and reports `configuration_unavailable`; partial objects missing `executable`, `projects`, or `profiles` fail startup. IDs match `^[a-z][a-z0-9-]{0,31}$` (`"local"` is allowed here) and must be unique in their collection; labels use `1`–`64` normalized code points.
- `tern` paths: each `workingCopies[].path` (`<= 4,096` UTF-8 bytes) must be an accessible directory equal to its `realpath` (symlinks rejected); `executable` and `profile.argv[0]` (`<= 4,096` UTF-8 bytes) must be absolute executable files (symlinks resolved at invocation).
- `tern` command and window: `profile.argv` holds `1`–`32` literal strings (`<= 1,024` UTF-8 bytes after `argv[0]`, `8` KiB total, no shell), and `tern.window` accepts `""` or decimal `"2"`–`"999"` without leading zeros.
- `tern` environment: `profile.env` is the complete `tern` CLI child environment (never merged with `process.env`) and holds `2`–`16` entries (`^[A-Z_][A-Z0-9_]{0,63}$`, `<= 1,024` UTF-8 bytes per value, `8` KiB total), including an absolute `HOME` and a `PATH` of non-empty absolute paths (`:`-separated on Linux/macOS, `;`-separated on Windows).
- `notifications`: omit an unused `sources` or `coordinators` key rather than writing `[]` (an empty `"notifications": {}` enables neither role). Every ID in `notifications.sources` must match an entry in `fleet.targets` (never `"local"`). Every `{ id, origin }` in `notifications.coordinators` (`id` matching `^[a-z][a-z0-9-]{0,31}$`) must have a unique `id` and `origin`, differ from `http.publicOrigin`, and appear in `http.trustedDashboardOrigins`.

<a id="12-self-hosted-relay-mode"></a>
## 15. Unsupported deployments

- Self-hosted or proxied collaboration relays: only the stock OMP relay (`https://my.omp.sh`) is supported; custom or proxied relays are unsupported and must never silently fall back to the public relay.
- Tailscale Funnel and public exposure: Funnel (`tailscale funnel`) and public reverse tunnels are unsupported; `doctor` fails `funnelDisabled` if Funnel is active.
- Other forwarders onto the loopback port: never point an HTTP reverse proxy, SSH `-L` port forward, container port publish, plain LAN listener, or `tailscaled --tun=userspace-networking` at `127.0.0.1:<port>`. Only Tailscale Serve strips caller-supplied `Tailscale-User-*` headers before adding authenticated ones; any other forwarder onto loopback lets remote callers forge `Tailscale-User-Login` ([Network exposure](SECURITY.md#4-network-exposure)).

For the complete matrix of supported and unsupported deployment topologies, see [Deployment dependency matrix](COMPATIBILITY.md#deployment-dependency-matrix).
