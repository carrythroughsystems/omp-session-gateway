# Installation and operations

## 1. One-time prerequisites

- Stock mainline OMP `>= 18.1.20` on `PATH`.
- Bun `1.4.0` installed at a persistent path for the gateway service.
- Tailscale installed and signed in to the same tailnet on the gateway host and your phone, with TUN-mode networking on the gateway host (not userspace networking).
- Tailnet HTTPS and MagicDNS enabled for Tailscale Serve.
- A tailnet access policy granting only your intended users HTTPS access to the gateway host (example in [`../examples/tailscale-policy.hujson`](../examples/tailscale-policy.hujson)).

Initial Tailscale login, gateway installation, and `collab.autoStart` configuration happen once; after setup, starting `omp` requires no extra command per session.

Keep your phone or browser device user-owned: tagged source devices carry no `Tailscale-User-Login` identity header and are denied by default authorization.

## 2. CLI and daemon installation

Download the latest release archive from [GitHub Releases](https://github.com/carrythroughsystems/omp-session-gateway/releases/latest) and follow [Verify a published build](RELEASE.md#verify-a-published-build) before extracting or running it. Releases published before the repository moved to `carrythroughsystems` (the closed tag set through v0.7.5) were signed under the original `alphastorm/omp-session-gateway` identity; the verification runbook selects that identity for those tags only. Never substitute the download URL for the certificate or attestation source identity.

**Warnings before you run `install`:**
- If you are upgrading from v0.3.0 or earlier (releases that used `publisher-token`), stop and unregister that service with its own CLI first ([UPGRADE_ROLLBACK.md](UPGRADE_ROLLBACK.md#recover-across-the-v030-boundary)).
- Run as your normal desktop user, never `root`.
- Keep `bun` at the persistent path used during `install`; the user service executes that exact path.

From the directory containing the verified archive on Linux or macOS, replace the example origin and login with your exact Tailscale HTTPS origin and login:

```sh
tar -xf omp-session-gateway-*-bun.tar
cd omp-session-gateway-*-bun
bun apps/gateway/src/cli.js install \
  --origin https://host.example.ts.net \
  --allow you@example.com
bun apps/gateway/src/cli.js serve-guidance
```

On Windows, run the same steps in PowerShell, one command per line:

```powershell
tar -xf (Get-Item omp-session-gateway-*-bun.tar).Name
cd omp-session-gateway-*-bun
bun apps/gateway/src/cli.js install --origin https://host.example.ts.net --allow you@example.com
bun apps/gateway/src/cli.js serve-guidance
```

The installer validates or writes your private configuration, stages the verified runtime under your user state directory, creates or retains the local readiness token, registers and starts the current-user service, and waits for an authenticated loopback readiness check before activating the runtime. It prints the `tailscale serve` command for your origin; it does not configure Tailscale, edit tailnet policy, or change OMP settings.

**Apply the printed Serve command and the [tailnet policy](#6-tailnet-access-policy) before running `doctor`.** Confirm `tailscale serve status` and keep Funnel disabled, then run from the same extraction directory:

```sh
bun apps/gateway/src/cli.js status
bun apps/gateway/src/cli.js doctor
```

The archive ships one bundled JavaScript CLI (`apps/gateway/src/cli.js`) plus static web assets, and does not install a shell alias. Below, `omp-gateway <command>` means `bun apps/gateway/src/cli.js <command>` from the verified extraction root:

- `omp-gateway status` — Print JSON reporting whether the user service is installed, active, ready on loopback, and aligned with `current.json`.
- `omp-gateway doctor` — Run all 18 local, Tailscale Serve, identity, PWA, discovery, and relay checks and exit non-zero if any check fails.
- `omp-gateway doctor --bundle [--output <path>]` — Write a redacted `omp-gateway-diagnostics.tar` containing only boolean check results and version/platform metadata.
- `omp-gateway rotate-readiness-token` — Replace the local readiness token and restart the active user service on the new token.
- `omp-gateway rollback [--to <version-dir>]` — Switch the active service back to the previous installed runtime (or a named retained version directory) and verify readiness.
- `omp-gateway uninstall [--no-stop]` — Stop the user service and remove its autostart registration while keeping `config.json`, `readiness-token`, and staged runtimes.

Each successful install keeps the active runtime plus the two most recent distinct predecessors in activation history and prunes older staged versions. `rollback --to <version-dir>` can only select a retained version, so keep verified release archives separately if you may need to recover to an older release.

| OS | Service name | Starts when | Qualified on |
|---|---|---|---|
| Linux | `omp-session-gateway.service` (`~/.config/systemd/user/omp-session-gateway.service`) | Current-user `systemd` manager starts (`default.target`) | Debian 13 x86-64 |
| macOS | `omp-session-gateway` (`~/Library/LaunchAgents/omp-session-gateway.plist`) | Current user logs in to the desktop (`RunAtLoad`, not unattended boot) | macOS 27 arm64 (`VirtualMac2,1` Virtualization.framework guest, not bare metal) |
| Windows | `omp-session-gateway` scheduled task (`%LOCALAPPDATA%\OMP Session Gateway\omp-session-gateway-task.xml`) | Installing user logs on interactively (`InteractiveToken`, not unattended boot) | Windows x86-64 build 26100 (Server 2025), Administrator or standard account |

## 3. Paths

The gateway keeps its private configuration and state separate from OMP's discovery directory and never writes capabilities to disk:

- **Gateway config directory** (`config.json`, `readiness-token`, and on Windows `omp-session-gateway-task.xml`): `${XDG_CONFIG_HOME:-~/.config}/omp-session-gateway` on Linux and macOS; `%LOCALAPPDATA%\OMP Session Gateway` on Windows.
- **Gateway state directory** (`installation/current.json`, `installation/history.json`, `installation/versions/<version>-<digest>`, `push.json`, and the private `session-creations.json` ledger when creation is used): `${XDG_STATE_HOME:-~/.local/state}/omp-session-gateway` on Linux and macOS; `%LOCALAPPDATA%\OMP Session Gateway\state` on Windows.
- **OMP discovery directory** (owned by OMP, read-only to the gateway): `~/.omp/run/collab-hosts`, or `~/.<PI_CONFIG_DIR>/run/collab-hosts` when `PI_CONFIG_DIR` is set.

The gateway reads each discovery file's `endpoint` field verbatim because OMP can relocate long Unix socket paths. Never delete or edit files inside OMP's discovery directory from the gateway.

## 4. Gateway configuration

`install --origin https://host.example.ts.net --allow you@example.com` creates or updates `config.json`:

| Field | Default | Bounds | Meaning |
|---|---|---|---|
| `http.hostname` | `"127.0.0.1"` | `"127.0.0.1"` or `"::1"` | Loopback bind address; non-loopback addresses are rejected. |
| `http.port` | `4317` | `1`–`65535` | Loopback HTTP port proxied by Tailscale Serve. |
| `http.publicOrigin` | Set by `--origin` | Exact `https://` origin in production | External Tailscale Serve origin (exact `http://` loopback origin in `dev-localhost` mode). |
| `http.trustedDashboardOrigins` | `[]` | `0`–`8` canonical origins (`https://` in `tailscale-serve` mode; loopback `http://127.0.0.1:<port>` or `http://[::1]:<port>` also allowed in `dev-localhost` mode; unique; `!= http.publicOrigin`) | Remote dashboard origins allowed the exact list/launch and creation routes in [Cross-origin access](PROTOCOL.md#cross-origin-access); opting into `tern` trusts these dashboards to create approved processes too. |
| `auth.mode` | `"tailscale-serve"` | `"tailscale-serve"` or `"dev-localhost"` | Production Tailscale Serve identity check or local development mode. |
| `auth.allowedLogins` | Set by `--allow` | 1+ entries (`1`–`320` chars, no `*`) | Lowercased `Tailscale-User-Login` values allowed to access the gateway. |
| `omp.discoveryDir` | `~/.omp/run/collab-hosts` | Absolute path, no NUL bytes | Explicit discovery path override when the service does not inherit a custom `PI_CONFIG_DIR`. |
| `omp.queryTimeoutMs` | `1500` | `250`–`10000` | Per-host deadline in milliseconds for one `snapshot` or `link` query. |
| `registry.heartbeatSeconds` | `10` | `2`–`60` | Seconds between discovery polls of OMP's host directory. |
| `registry.ttlSeconds` | `35` | `5`–`300`, and `> 2 × heartbeatSeconds` | Seconds an existing session card is kept during transient query failures. |
| `registry.maxSessions` | `100` | `1`–`1000` | Maximum concurrent hosts tracked in the in-memory registry. |
| `fleet.label` | First DNS label of `http.publicOrigin` host (loopback dev origins keep the literal host) | `1`–`64` NFC code points (control/bidi stripped) | Display label for this host in `GET /api/v1/client-config` and the **Host** picker. |
| `fleet.targets` | `[]` | `0`–`7` `{ id, label, origin }` entries (`id` matches `^[a-z][a-z0-9-]{0,31}$` and `!= "local"`; `label` `1`–`64` code points; canonical `origin != http.publicOrigin`; unique `id` and `origin`) | Remote gateways polled directly by this host's PWA (at most 8 sources total including `local`). |
| `speech.browserRecognition` | `false` | `true` or `false` | When `true`, sets `Permissions-Policy: microphone=(self)` on document HTML responses and enables the opt-in Web Speech microphone control in writable **Control** sessions. |
| `tern` | Absent (creation unavailable) | Strict optional section, at most 32 KiB within the 64-KiB config | Administrator-approved new OMP creation on this execution host; see [setup below](#opt-in-tern-session-creation). |

Only `ENOENT` or `ECONNREFUSED` proves a queried OMP host has exited; timeouts, permission or resource errors, and wire errors retain the card until `registry.ttlSeconds` expires. A host absent from OMP's discovery directory is removed on the next poll, and an absent discovery directory is valid when no sessions are sharing.

Configuration parsing fails closed on unknown keys, wildcard addresses or logins, non-private file permissions, or invalid poll/TTL combinations.

### Multi-host setup

To list and launch sessions across multiple workstations from one installed **OMP Sessions** PWA, configure reciprocal trust between your home (dashboard) gateway and each remote target gateway ([ADR-036](DECISIONS.md#adr-036--federated-dashboard-origins-through-browser-direct-cors)):

1. **On the home (dashboard) gateway**, add `fleet.label` (optional) and `fleet.targets` (up to 7 targets) to `config.json`:

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

2. **On each remote target gateway**, add the home gateway's exact `http.publicOrigin` to `http.trustedDashboardOrigins` in `config.json`:

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

3. **Verify Tailscale identity and policy on every host:** confirm your user login is in `auth.allowedLogins` on both gateways and that your tailnet policy grants your user-owned browser/phone device HTTPS access to both hosts.
4. **Apply and reload:** re-run `omp-gateway install --origin <origin> --allow <login>` on each edited host (which preserves `http.trustedDashboardOrigins`, `fleet`, `speech`, and `tern` verbatim and restarts the service), then **reload the installed PWA** so it fetches the updated `GET /api/v1/client-config`.

### Opt-in Tern session creation

This is optional and absent by default ([ADR-043](DECISIONS.md#adr-043--opt-in-tern-creation-with-omp-native-adoption)).
Ordinary discovery and View/Control launch do not depend on Tern. Configure only on the
**execution host** running OMP as the same OS user; a remote pane belongs to that host's
gateway, not a local terminal inspector on the viewing device.

**Trust disclosure:** enabling `tern` lets allowed identities, including JavaScript from every
configured `http.trustedDashboardOrigins` dashboard, create processes from these profiles.
This is stronger trust than reading metadata or opening an already-running session. Removing
dashboard trust blocks subsequent API requests, not accepted operations or already-started
processes; stopping those processes remains an operator action in Tern/OMP.

Add a section such as this to the private `config.json`; all paths below are synthetic:

```json
{
  "tern": {
    "executable": "/usr/local/bin/tern",
    "projects": [{
      "id": "example",
      "label": "Example project",
      "workingCopies": [{
        "id": "main",
        "label": "main",
        "path": "/srv/omp-projects/example"
      }]
    }],
    "profiles": [{
      "id": "omp",
      "label": "OMP",
      "argv": ["/usr/local/bin/omp"],
      "env": {
        "HOME": "/home/omp-demo",
        "PATH": "/usr/local/bin:/usr/bin:/bin"
      }
    }]
  }
}
```

- **Absolute, canonical execution values:** use absolute Tern and profile executable paths.
  Working-copy paths must be accessible directories equal to their `realpath`; an authored
  symlink/alias is rejected, not silently followed. Executable symlinks are resolved to their
  canonical executable regular-file target for invocation without rewriting authored config.
  No `~`, shell expansion, shell wrappers, browser-selected paths, or task text in argv.
- **Configuration bounds:** 1–16 projects; 1–8 working copies per project; 1–8 profiles.
  IDs match `^[a-z][a-z0-9-]{0,31}$` (`local` is allowed here), unique per collection and per
  project's copies; labels use fleet normalization (NFC, controls/bidi stripped, trimmed,
  1–64 code points). `tern.executable` is at most 4,096 UTF-8 bytes. Each profile has 1–32
  argv strings, absolute argv[0], at most 1,024 UTF-8 bytes per remaining argument and 8 KiB
  total argv. Unknown keys, null substitutions, and NUL execution values are rejected.
- **Explicit CLI environment:** `env` is the **entire** Tern CLI child's environment, never
  merged with the LaunchAgent/service environment or interactive shell. Author `HOME`
  (absolute) and `PATH` (every entry absolute and nonempty). At most 16 entries, names matching
  `^[A-Z_][A-Z0-9_]{0,63}$`, at most 1,024 UTF-8 bytes/value and 8 KiB aggregate.
  Do not rely on shell startup files to locate either executable.
- **Separate Tern-pane prerequisite:** no claim is made that this CLI environment crosses the
  existing Tern GUI-server RPC boundary. Configure OMP's HOME/settings/discovery environment
  inside Tern first, with `collab.autoStart = control`, and ensure new panes publish into
  `omp.discoveryDir`. View-only publication can appear in the directory but cannot complete
  creation's **Create and open Control** adoption. Read back the setting in that environment:

  ```sh
  /usr/local/bin/omp config set collab.autoStart control
  /usr/local/bin/omp config get collab.autoStart
  ```

- **First window only:** Tern's CLI creates the tab in the first window; the gateway does not
  select, focus, or attach a window/pane. The tab uses `--keep-open`, including when the command
  fails. Inspect that tab yourself rather than expecting gateway terminal content.
- **Apply:** rerun install with your existing origin/allowlist; authored `tern` is preserved
  verbatim, not normalized into a new default. Restart creates a new opaque options revision;
  a stale review must fetch fresh options and require another explicit Create.

In **New session**, choose Host, Project, Working copy when needed, and Profile. **Create and
open Control** starts one operation. Optional **First task** is bounded to 8,000 code points /
32 KiB, stays in page memory, and only fills an empty ordinary Control composer once;
it is never put in argv, requests, storage, or logs, and never auto-sends.
The daemon deadline is 110 seconds; browser watching is at most 120 seconds with serial status
polls. Close, background, or navigation stops watching, not the operation. **Check creation**
performs status lookup or explicitly replays the identical request after a lost acknowledgement;
do not create a replacement merely because a request timed out.

For `started_unavailable`, Tern started the command but the gateway could not adopt a unique
Control host. For `outcome_unknown`, it may have started: check Tern and the directory before
another explicit Create. Neither outcome is automatically retried. No native **Open in Tern**
link is provided: Android 0.9.5 is [upstream-blocked](https://github.com/stencil-hq/tern-sdk/issues/143);
desktop handoff is deferred.

### Creation ledger recovery

`<stateDir>/session-creations.json` is private state, not a support artifact: version 1 only,
at most 64 operations, 24-hour retention from acceptance, 512 KiB maximum, and a single writer
per user deployment. Do not point concurrent daemons at one state directory. Full unexpired
capacity refuses new creation; it never evicts an unexpired record or creates an execution queue.
Owner identity and request/operation IDs are private; no labels, prompts, paths, argv/env,
capabilities, or raw CLI output belong in this ledger.

After restart/shutdown, durable `accepted` becomes `failed/interrupted`, `launching` becomes
`outcome_unknown/interrupted`, and `awaiting_omp` becomes `started_unavailable/interrupted`.
Terminal records stay unchanged; execution/adoption never resumes automatically. A corrupt,
unsupported, unsafe, unreadable, or unsynchronizable ledger disables creation without being
replaced by an empty file. Ordinary directory and launch remain available.

If `ledger_unavailable` appears, stop the gateway before repair, preserve the original ledger
privately, and correct its ownership/permissions/storage fault or restore a known valid private
v1 ledger. Do not paste its contents into an issue or delete it to clear uncertainty. If no valid
ledger can be restored, first reconcile possible started processes in Tern/OMP, then explicitly
archive the unusable file outside active state and restart without it. Removing a ledger loses
its retained idempotency protection; never replay an old Create afterward as a new attempt.
Neither repair nor restart stops Tern tabs or OMP.

Every managed rollback removes authored `tern` after a private full-config backup and leaves
this ledger intact. Re-enable creation only by explicit operator restoration on a compatible
runtime; see [rollback behavior](UPGRADE_ROLLBACK.md#tern-creation-on-every-managed-rollback).

## 5. Tailscale Serve

Print the exact Serve command for your configured `--origin` and `--port`:

```sh
bun apps/gateway/src/cli.js serve-guidance
```

For a default port-443 HTTPS origin and loopback port `4317`, run:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:4317
```

If your `--origin` uses `:8443`, `serve-guidance` prints `--https=8443`. Confirm the mapping and verify that Funnel is off:

```sh
tailscale serve status
tailscale funnel status
```

**Never run `tailscale funnel` or expose the gateway to the public Internet.**

The daemon stays bound to loopback behind Tailscale Serve. Serve strips incoming identity headers and adds `Tailscale-User-Login` for user-owned tailnet devices; because local loopback processes can forge headers directly, the supported host is a single-user workstation with no untrusted local accounts.

## 6. Tailnet access policy

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

Replace `you@example.com` with the exact login passed to `--allow`, and use `tcp:8443` if your Serve origin uses port `8443` (never grant remote access to loopback port `4317`). [Tags](https://tailscale.com/kb/1068/tags) identify service hosts and strip user identity, so assign `tag:omp-session-gateway` only to the gateway host and keep your phone **user-owned** ([deployment matrix](COMPATIBILITY.md#deployment-dependency-matrix)). Prefer [grants over legacy ACLs](https://tailscale.com/docs/reference/grants-vs-acls) ([grant syntax](https://tailscale.com/docs/reference/syntax/grants), [policy syntax](https://tailscale.com/docs/reference/syntax/policy-file)), and remove or narrow broader rules such as the default [allow-all policy](https://tailscale.com/kb/1018/acls) because grants are additive.

### Device admission: approval or Tailnet Lock

Choose one admission control for new tailnet nodes; **[Device approval](https://tailscale.com/kb/1099/device-approval) and [Tailnet Lock](https://tailscale.com/kb/1226/tailnet-lock) are mutually exclusive** ([Tailnet Lock limitations](https://tailscale.com/kb/1226/tailnet-lock#limitations)):

- **Device approval:** Enable in the admin console under Device management and manually approve the gateway host and phone in Machines before they can exchange tailnet traffic; treat pre-approved auth keys as admission decisions.
- **Tailnet Lock:** Maintain at least two separately protected signing nodes, store initialization disablement secrets offline, and sign the user-owned phone and gateway node with `tailscale lock sign` from a desktop signer (Android cannot act as a signer).

### Node key expiry and renewal

[Key expiry](https://tailscale.com/kb/1028/key-expiry) disconnects an expired host or phone until it reauthenticates; never enable Funnel or widen `--allow` to work around an expired key. Check expiry for both machines in the admin console: tagged gateway nodes default to disabled expiry, while user-owned phones should keep expiry enabled and reauthenticate in the Tailscale app. To renew a CLI host, run `tailscale up --force-reauth` when you have local or alternate access (or use **Temporarily extend key** in Machines for a 30-minute recovery window), then recheck `tailscale serve status`.

### Optional source-device posture

You can optionally narrow the grant to specific client attributes with [Device posture](https://tailscale.com/kb/1288/device-posture) (`srcPosture` in [`../examples/tailscale-policy.hujson`](../examples/tailscale-policy.hujson)) by replacing—not adding alongside—the unrestricted grant. Check actual values in Machines before enforcing default attributes (`node:os`, `node:osVersion`, `node:tsVersion`, `node:tsReleaseTrack`, `node:tsAutoUpdate`, `node:tsStateEncrypted`; see [attribute reference](https://tailscale.com/kb/1288/device-posture#default-attributes)), and note that App Store and Google Play builds report `node:tsAutoUpdate` as `false`. Tailscale enforces posture on direct tailnet sources while the gateway enforces its `--allow` login list on [Serve identity](https://tailscale.com/kb/1312/serve#identity-headers); do not share the gateway node externally.

### Validate the combined controls

Preview your merged policy in [Access controls → Preview rules](https://tailscale.com/docs/features/tailnet-policy-file/manage-tailnet-policies#preview-changes), then run this 3-step live check:

1. **Allowed user device:** Open the HTTPS Serve origin on your allowed user-owned phone or browser and confirm the session directory loads.
2. **Denied user device:** Open the HTTPS Serve origin from a device signed in as a different user (or blocked by policy) and confirm the request is blocked by Tailscale or denied (`403` / identity denied) by the gateway.
3. **Tagged source device:** Connect from a tagged device (`tag:...`) and confirm the gateway denies access because no `Tailscale-User-Login` header is present.

## 7. OMP configuration

Enable automatic collaboration sharing once in OMP (`examples/omp-settings.jsonc`):

```sh
omp config set collab.autoStart control
omp config get collab.autoStart
```

Use `view` instead of `control` if you want read-only remote access by default, or `omp config set collab.autoStart off` to restore the upstream default. Running `omp` processes keep the setting loaded at process start, so start a new `omp` session after changing `collab.autoStart`.

Participating sessions publish owner-only discovery files under `~/.omp/run/collab-hosts` (or `~/.<PI_CONFIG_DIR>/run/collab-hosts`). See [OMP_INTEGRATION.md](OMP_INTEGRATION.md#1-operator-settings).

## 8. Android/PWA installation

Open your Tailscale Serve HTTPS origin in a supported browser, confirm your Tailscale login is shown, and install **OMP Sessions**:

- **Android and desktop Chromium (Chrome, Edge):** Open the browser menu and select **Install app** / **Add to Home screen**.
- **iPhone and iPad (Safari):** Tap **Share → Add to Home Screen**; background alerts on iOS and iPadOS 16.4+ require opening the installed Home Screen app.
- **macOS Safari:** Choose **File → Add to Dock**.
- **Desktop Firefox:** Use directly in a browser tab (Firefox has no web-app install).

Reloading always returns to the session directory by design; never bookmark or copy an individual collaboration link. See [Install as an app](USAGE.md#install-as-an-app) and [Background alerts](USAGE.md#background-alerts).

## 9. Updates

To update the gateway to a newer release:

1. Download and verify the new release archive ([Verify a published build](RELEASE.md#verify-a-published-build)).
2. Extract the archive and run the same `install` command with your production `--origin` and `--allow` flags.
3. The installer preserves your existing port (when `--port` is omitted), `http.hostname`, `http.trustedDashboardOrigins`, `registry` settings, authored `omp` overrides, `fleet`, `speech`, `tern`, `readiness-token`, and Web Push subscriptions, and switches the active runtime only after authenticated readiness passes.
4. Run `bun apps/gateway/src/cli.js status` and `bun apps/gateway/src/cli.js doctor` from the new extraction directory.

Running `omp` sessions do not need to be restarted across a gateway update; the next discovery poll repopulates the directory within `registry.heartbeatSeconds` (default 10 s). If you need to revert, `omp-gateway rollback` (or `rollback --to <version-dir>`) restores a retained gateway runtime and preserves `readiness-token`, without downgrading or restarting `omp`. Every managed rollback projects authored `tern` away; targets older than `FLEET_CONFIG_SINCE_VERSION` (`0.8.0`) also project away authored `http.trustedDashboardOrigins`, `fleet`, and `speech`. A projecting rollback first saves the full authored document to private `<configDir>/config.pre-rollback.json`, refuses overwrite, and preserves the creation ledger; restore only explicitly on a runtime compatible with every saved key. See [UPGRADE_ROLLBACK.md](UPGRADE_ROLLBACK.md#roll-back-to-a-retained-predecessor).

## 10. Lost phone and revocation

If a phone or browser device with tailnet access is lost or compromised:

1. **Remove or expire the device in Tailscale** (Machines console) and revoke identity-provider sessions if the account itself may be exposed.
2. **Tighten or disable the user grant** in your tailnet policy if other devices on that login should also be blocked. To stop all directory access on the host immediately, run `omp-gateway uninstall`.
3. **Stop active OMP collaboration rooms** by exiting participating `omp` processes or running `/collab stop` in each session. Blocking tailnet or gateway access prevents **future** directory and launch requests, but an already-open relay session stays connected until the OMP host closes the room.
4. **Keep `readiness-token` unless the workstation itself was exposed.** `omp-gateway rotate-readiness-token` only rotates the local CLI health secret on the host; it does not revoke OMP host tokens or active relay rooms.
5. **Run `omp-gateway doctor`** from the workstation once access is restored to verify the gateway and Serve configuration.

## 11. `doctor` and diagnostics bundle

`omp-gateway doctor` prints a JSON report with **18 base checks plus `ternAvailable` when configured**, all boolean, and exits non-zero if any check is `false`:

- **Local configuration and files:** `config` (valid private `config.json`), `permissions` (private `readiness-token` and usable discovery path), `discoveryReadable` (`omp.discoveryDir` is absent or a private owner-only directory without symlinks), `assets` (built web assets present on disk), `compatibility` (`omp --version` on `PATH` is `>= 18.1.20`).
- **Daemon and service:** `daemon` (loopback HMAC readiness proof succeeds), `serviceInstalled` (user service definition exists), `serviceActive` (user service is running).
- **Loopback and Tailscale boundary:** `listenerLoopbackOnly` (bound to `127.0.0.1` or `::1` with a local TUN tailnet address), `loopbackTrustSound` (kernel TUN device present, not userspace networking), `tailscaleConnected` (`tailscale status` reports `Running`), `serveMapping` (`tailscale serve` proxies the exact `http.publicOrigin` host and port to the exact loopback origin), `funnelDisabled` (Tailscale Funnel is off).
- **End-to-end Serve and relay health:** `identityAllowed` (authenticated `GET /api/v1/sessions` over the public Serve origin returns `200` with `Cache-Control: no-store`), `sessionHealth` (every listed session has a valid `lastSeenAt` timestamp), `pwa` (`/`, `/manifest.webmanifest`, and `/service-worker.js` return `200`), `securityHeaders` (`Content-Security-Policy` includes `default-src 'self'`), `relay` (outbound `HEAD` to `https://my.omp.sh` succeeds without creating a capability).
- **Optional creation:** `ternAvailable` exists only when `config.tern` is authored. Its bounded
  probe checks configured runtime paths, inspect usability, and ledger readability; it never
  starts OMP and does not promise pane-environment correctness, successful adoption, or Control.
  Without `tern`, there is no Tern probe or extra failing check.

Note that `doctor` tests the host and an allowed metadata request from the workstation; it does not prove that unauthorized or tagged devices are denied. Complete the 3-step live check in [Validate the combined controls](#validate-the-combined-controls).

To create a redacted support archive without overwriting an existing file:

```sh
bun apps/gateway/src/cli.js doctor --bundle
```

Pass `--output <path>` to choose a custom filename. The archive (`omp-gateway-diagnostics.tar`) contains only `doctor.json` (product and protocol versions, OS/architecture, and the boolean check results, including `ternAvailable` only when configured) and `manifest.json`. It excludes capabilities, tokens, headers, logins, tailnet names, session titles, paths, transcripts, browser storage, raw logs, creation ledgers and request payloads, argv/env, and raw Tern CLI/inspection output. Never paste a collaboration link, token, or creation ledger into an issue.

### Troubleshooting by symptom

| Symptom | Likely cause | What to do |
|---|---|---|
| No sessions appear in the directory | `collab.autoStart` is `off`, the `omp` session started before `collab.autoStart` was set, `omp` on `PATH` is older than `18.1.20`, or `omp.discoveryDir` does not match `PI_CONFIG_DIR`. | Run `omp config get collab.autoStart` (set `control` or `view` and start a new `omp` process), check `omp --version`, and confirm `compatibility` and `discoveryReadable` are `true` in `omp-gateway doctor`. |
| Access denied (`403`) or missing identity | The phone or browser is a tagged device (`tag:...`), is signed in as a login not listed in `--allow`, or is connecting to port `4317` without Tailscale Serve. | Sign in to Tailscale on the phone with a user account, open the `https://` Serve origin, and rerun `omp-gateway install --origin <https-origin> --allow <login>` if your login changed. |
| `loopbackTrustSound: false` (and `listenerLoopbackOnly: false`) | `tailscaled` on the gateway host runs in `--tun=userspace-networking` mode without a kernel TUN interface, so loopback peer identity cannot be trusted. | Reconfigure Tailscale on the host to use kernel TUN mode, restart Tailscale, and re-run `omp-gateway doctor`. |
| `serveMapping: false` (Serve host or port mismatch) | `tailscale serve` is not configured, proxies to the wrong loopback port, or uses an external HTTPS port that does not match `http.publicOrigin`. | Run `omp-gateway serve-guidance`, execute the printed `tailscale serve --bg ...` command, check `tailscale serve status`, and verify `funnelDisabled: true` in `omp-gateway doctor`. |
| "Request changed" or "Session ended" when tapping a card or notification | The OMP session advanced to a new generation, the ask was already answered at the desktop, or the `omp` process exited before the tap completed. | Return to the session directory and tap the updated card if the session is still running. |
| Directory shows stale cards (`Gateway unavailable` / `Desktop unreachable`) vs session shows `Relay unavailable` | A stale directory means the phone cannot reach `omp-gatewayd` over Tailscale Serve (host asleep, daemon stopped, or tailnet offline); `Relay unavailable` means the directory works but the browser or host cannot reach `https://my.omp.sh`. | For a stale directory, wake the host and check Tailscale and `omp-gateway status`; for `Relay unavailable`, check `relay` in `omp-gateway doctor` and verify outbound HTTPS to `https://my.omp.sh`. |
| Android stays unreachable after sleep or a Wi-Fi / cellular change | Android Chrome can wedge its network stack after a radio transition even after connectivity returns; after 45 seconds of visible failure, **OMP Sessions** shows recovery help. | Tap **Try again**; if it remains unreachable after 45 seconds, force-stop or swipe closed Chrome / **OMP Sessions** and reopen **OMP Sessions**. |
| Background alerts are blocked or unavailable | Browser notification permission is denied, **OMP Sessions** is open in a regular Safari tab on iPhone/iPad instead of installed to the Home Screen, or push registration failed. | On iPhone or iPad, use Safari **Share → Add to Home Screen** and open the Home Screen app; open **Settings** in **OMP Sessions**, enable **Background alerts**, and allow notifications in browser/OS settings. |
| Page returned to the directory after an update or reload | Capabilities live only in page memory and are never persisted; a service-worker update reloads an idle directory (or applies after you leave an active session). | Tap **View** or **Open request** in the directory to request a fresh capability. |
| Remote host row shows `403` / `Access withdrawn.` (`forbidden`) vs `Cannot reach this host from this app.` | Remote hosts are polled every 10 seconds while visible (5-second request timeout, 35-second stale grace). A readable `403` means CORS admission succeeded (`http.trustedDashboardOrigins` on the target includes the dashboard origin) but the target gateway denied authorization (your login is missing from the target's `auth.allowedLogins`, the device is tagged, or the target has `loopbackTrustSound: false`); its rows are cleared, any open shell from that host shows `Access withdrawn` / closes, and polling pauses until **Retry** or returning to the foreground. `Cannot reach this host from this app.` means the browser blocked or failed the cross-origin fetch before a response could be read: the target host is offline, tailnet/MagicDNS/local-network access is blocked, or the target's `http.trustedDashboardOrigins` does not include the dashboard's exact `http.publicOrigin` (browsers make CORS blocks, DNS failures, and network timeouts indistinguishable to JavaScript). | For `403`, check `auth.allowedLogins` and `omp-gateway doctor` on the target host, then tap **Retry**. For `Cannot reach this host from this app.`, open the target's `https://` Serve origin directly in a browser tab to separate a host/tailnet outage from a missing `http.trustedDashboardOrigins` entry, update `config.json` on the target if needed, and tap **Retry**. |
| Banner shows `Fleet configuration unavailable — reload this app` | `GET /api/v1/client-config` returned `200` with a malformed body, an unsupported `version`, or `local.origin` different from the browser's `location.origin` (for example, opening the gateway through a hostname that does not match `http.publicOrigin`). | Open the exact `http.publicOrigin` URL configured on the home gateway and tap **Reload**. |

## 12. Self-hosted relay mode

Self-hosted and proxied collaboration relays are unsupported. Qualifying a custom relay requires a dedicated threat model, private DNS/TLS with explicit allowlisting across OMP and the embedded client, and multi-hour WebSocket, sleep/resume, and network-transition soak testing through the exact proxy path. A custom relay deployment must never silently fall back to the public relay.
