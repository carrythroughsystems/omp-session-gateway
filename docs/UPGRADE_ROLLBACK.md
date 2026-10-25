# Upgrade and rollback

Use these procedures to update a running gateway, switch back to a retained predecessor runtime, or cross the `v0.3.0` → `v0.4.0+` architecture boundary. For exact qualified host and client combinations and release evidence, see [COMPATIBILITY.md](COMPATIBILITY.md) and [RELEASE_STATUS.md](RELEASE_STATUS.md).

## Upgrade the gateway

Mainline-to-mainline (`v0.4.0` and later) upgrades run in place over the active user service. Download and verify the new release archive ([Verify a published build](RELEASE.md#verify-a-published-build)), then run `install` with your production `--origin` and `--allow` values:

```sh
tar -xf omp-session-gateway-*-bun.tar
cd omp-session-gateway-*-bun
bun apps/gateway/src/cli.js install \
  --origin https://host.tailnet.ts.net \
  --allow you@example.com
bun apps/gateway/src/cli.js status
bun apps/gateway/src/cli.js doctor
```

On Windows, run the same steps in PowerShell, one command per line:

```powershell
tar -xf (Get-Item omp-session-gateway-*-bun.tar).Name
cd omp-session-gateway-*-bun
bun apps/gateway/src/cli.js install --origin https://host.tailnet.ts.net --allow you@example.com
bun apps/gateway/src/cli.js status
bun apps/gateway/src/cli.js doctor
```

The installer validates your existing `config.json`, preserves an omitted `--port`, `http.hostname`, `http.trustedDashboardOrigins`, `registry` settings, authored `omp` overrides, `fleet`, `speech`, `tern`, `readiness-token`, and Web Push state verbatim, and switches `installation/current.json` only after the new service passes its authenticated loopback readiness check. Reinstalling or upgrading never strips `http.trustedDashboardOrigins`, `fleet`, `speech`, or `tern`. If startup or readiness fails, the installer restores the prior configuration, service definition, and verified runtime automatically.

## Roll back to a retained predecessor

To switch the active user service back to the previous activated runtime without re-extracting an archive, run `rollback` from any verified extraction root (or the currently installed CLI):

```sh
bun apps/gateway/src/cli.js rollback
```

To select a specific retained version directory under `<stateDir>/installation/versions/`, pass `--to`:

```sh
bun apps/gateway/src/cli.js rollback --to <version>-<digest12>
```

Each readiness-proven `install` keeps the active runtime plus the two most recent distinct predecessors in `installation/history.json` (plus any divergent version named by the on-disk service definition) and prunes older or never-activated staged directories. `rollback` itself never prunes, so you can switch back and forth between the active release and its predecessor; if you need a version that was already pruned, verify and `install` its release archive again.

### Tern creation on every managed rollback

Every managed `rollback` or `rollback --to` **conservatively disables creation** when `tern` is authored in `config.json`, regardless of the target version ([ADR-043](DECISIONS.md#adr-043--opt-in-tern-creation-with-omp-native-adoption)), because older runtimes reject unknown root keys:

1. `rollback` atomically writes the **full authored document** to `<configDir>/config.pre-rollback.json` with owner-only (`0600`) permissions. If `<configDir>/config.pre-rollback.json` already exists, `rollback` refuses to overwrite it and aborts before modifying `config.json` or the service (restore or move that backup file first).
2. `rollback` removes `tern` from `<configDir>/config.json` (`projectPreTernConfig`, composed with `projectPreFleetConfig` when the target runtime is also older than `0.8.0`), using the same transactional failure recovery as `install`.
3. `rollback` starts and readiness-checks the target runtime while preserving `<stateDir>/session-creations.json` (which older runtimes ignore) and leaving running Tern tabs and OMP processes untouched.

To re-enable creation after installing a creation-capable runtime, copy `<configDir>/config.pre-rollback.json` back to `<configDir>/config.json`, remove `<configDir>/config.pre-rollback.json`, and run `bun apps/gateway/src/cli.js install --origin <origin> --allow <login>` and `bun apps/gateway/src/cli.js doctor` from the verified extraction directory ([Operations](OPERATIONS.md#opt-in-tern-session-creation)). Do not copy a backup containing `tern` onto a runtime that does not support creation.

### Rolling back across the `v0.8.0` fleet and speech configuration boundary

Gateway runtimes older than `0.8.0` (`FLEET_CONFIG_SINCE_VERSION = "0.8.0"`) reject unknown `config.json` keys and refuse to start if `http.trustedDashboardOrigins`, `fleet`, or `speech` is present. When `omp-gateway rollback` (or `rollback --to`) targets a retained runtime older than `0.8.0` while any of those three keys is authored in `config.json` ([ADR-036](DECISIONS.md#adr-036--federated-dashboard-origins-through-browser-direct-cors)):

1. `rollback` atomically writes your full authored configuration to `<configDir>/config.pre-rollback.json` with owner-only (`0600`) permissions. If `<configDir>/config.pre-rollback.json` already exists, `rollback` refuses to overwrite it and aborts before modifying `config.json` or the service.
2. `rollback` rewrites `<configDir>/config.json` without `http.trustedDashboardOrigins`, `fleet`, and `speech` (and without `tern` whenever authored, as above), then starts and readiness-checks the older runtime.
3. `rollback` prints the path to `config.pre-rollback.json` and the restore steps.

To restore your fleet and speech settings after upgrading back to `v0.8.0` or later, first
confirm the selected runtime understands **every** saved key; if the backup contains `tern`,
use a creation-capable runtime or omit that section until you deliberately re-enable it:

```sh
cp "${XDG_CONFIG_HOME:-$HOME/.config}/omp-session-gateway/config.pre-rollback.json" \
  "${XDG_CONFIG_HOME:-$HOME/.config}/omp-session-gateway/config.json"
rm "${XDG_CONFIG_HOME:-$HOME/.config}/omp-session-gateway/config.pre-rollback.json"
bun apps/gateway/src/cli.js install \
  --origin https://host.tailnet.ts.net \
  --allow you@example.com
```

(On Windows, replace the path with `%LOCALAPPDATA%\OMP Session Gateway\config.pre-rollback.json` and `%LOCALAPPDATA%\OMP Session Gateway\config.json`.)

## Recover across the v0.3.0 boundary

Releases `v0.3.0` and earlier used a separate `publisher-token` and cannot answer the mainline readiness proof, so an in-place upgrade over a running `v0.3.0` service is refused. Before installing `v0.4.0` or later over `v0.3.0`, stop and unregister the old service using its own CLI:

```sh
bun omp-session-gateway-0.3.0-bun/apps/gateway/src/cli.js uninstall
```

Keep your existing configuration and staged runtimes in place, then run the new release's [standard `install` command](OPERATIONS.md#2-cli-and-daemon-installation) with your `--origin` and `--allow` values. The installer mints `readiness-token`, retires `publisher-token`, and starts the new service; restart any running `omp` processes under stock mainline OMP `>= 18.1.20` with `collab.autoStart` enabled.

Returning from `v0.4.0+` to `v0.3.0` also requires a stopped transition rather than `omp-gateway rollback`: run `uninstall` with the current CLI, restore a `v0.3.0`-compatible `config.json` if you added mainline-only `omp` fields, and run `install` from the verified `v0.3.0` archive (which mints a fresh `publisher-token`).

## What rollback never does

- **Never downgrades, restarts, or reconfigures `omp`:** running OMP processes keep the code and `collab.autoStart` setting they started with.
- **Never rotates `readiness-token` or silently discards authored configuration:** `readiness-token` is never rotated. Configuration is untouched unless authored `tern` must be projected away on any rollback, or fleet/speech keys must be projected away for a target older than `0.8.0`; save the full authored document to private `config.pre-rollback.json` first and refuse to overwrite an existing backup.
- **Never stops Tern or clears creation evidence:** preserve the private ledger; tabs and OMP
  processes already started remain running, and uncertain outcomes are never automatically retried.
- **Never edits Tailscale Serve mappings or tailnet policy:** your external HTTPS origin and allowlist remain in effect.
- **Never restores `publisher-token` or `v0.3.0` compatibility:** pointer rollback only switches between retained mainline gateway runtimes (`v0.4.0+`).

<!-- release-generate:predecessor:start -->
## v0.8.0 predecessor compatibility

The selected predecessor is published v0.7.7. Gateway rollback does not change the separately running OMP process. This release uses stock OMP v18.12.5; retained-runtime selection does not restore the predecessor's OMP baseline. After a v0.8.0 install, `rollback --to` selects only runtimes pruning retained. VirtualMac2,1, macOS 27.0 arm64; doctor 18/18, rollback 23/23; native addon a9dda5e6640b173279d738c0d13374fcc5daa409d7167ce9ff54ea56bf5afb30. Windows history-selected restoration passed. Preserve configuration and readiness state. Earlier predecessors retain the compatibility limits below; their receipts do not qualify this candidate.
<!-- release-generate:predecessor:end -->

## v0.7.7 predecessor compatibility

The selected predecessor is published v0.7.6. Gateway rollback does not change the separately running OMP process. This release uses stock OMP v18.10.2; retained-runtime selection does not restore the predecessor's OMP baseline. After a v0.7.7 install, `rollback --to` selects only runtimes pruning retained. VirtualMac2,1, macOS 27.0 arm64; doctor 18/18, rollback 23/23; native addon b137c1ff0cb7eeb6b4f97ea10e7869779f8db33d9e9edb16d04c1250597b900d. Windows history-selected restoration passed. Preserve configuration and readiness state. Earlier predecessors retain the compatibility limits below; their receipts do not qualify this candidate.

## v0.7.6 predecessor compatibility

The selected predecessor is published v0.7.5. Gateway rollback does not change the separately running OMP process. This release uses stock OMP v18.8.9; retained-runtime selection does not restore the predecessor's OMP baseline. After a v0.7.6 install, `rollback --to` selects only runtimes pruning retained. VirtualMac2,1, macOS 27.0 arm64; doctor 18/18, rollback 23/23; native addon 76a98a98c7adbe5481e1ac3ede2b7c6c889443dc5edd10929854e1ebde10c1b7. Windows history-selected restoration passed. Preserve configuration and readiness state. Earlier predecessors retain the compatibility limits below; their receipts do not qualify this candidate.

## v0.7.5 predecessor compatibility

The selected predecessor is published v0.7.4. Gateway rollback does not change the separately running OMP process. This release uses stock OMP v18.8.3; retained-runtime selection does not restore the predecessor's OMP baseline. After a v0.7.5 install, `rollback --to` selects only runtimes pruning retained. VirtualMac2,1, macOS 27.0 arm64; doctor 18/18, rollback 23/23; native addon efce5da3bd67933b98288068fc9768acc02c5cdd0af0a897418f6d99a31fded9. Windows history-selected restoration passed. Preserve configuration and readiness state. Earlier predecessors retain the compatibility limits below; their receipts do not qualify this candidate.

## v0.7.4 predecessor compatibility

The selected predecessor is published v0.7.3. Gateway rollback does not change the separately running OMP process. This release uses stock OMP v18.5.1; retained-runtime selection does not restore the predecessor's OMP baseline. After a v0.7.4 install, `rollback --to` selects only runtimes pruning retained. VirtualMac2,1, macOS 27.0 arm64; doctor 18/18, rollback 23/23; native addon 4e707d5c7a44bf15a2e61afb6856e0a5ec3a86e11364e68714e99bde1745e6d1. Windows history-selected restoration passed. Preserve configuration and readiness state. Earlier predecessors retain the compatibility limits below; their receipts do not qualify this candidate.

## v0.7.3 predecessor compatibility

The selected predecessor is published v0.7.2. Gateway rollback does not change the separately
running OMP process. Both versions embed the same OMP 18.4.2 collaboration client and wire pin;
v0.7.3 moves the engineering baseline to stock OMP v18.4.12 without gateway runtime fixes.
Rolling back to v0.7.2 therefore does not undo a gateway runtime fix or replace OMP with the
predecessor's engineering baseline. After a v0.7.3 install, `rollback --to` can select only the
runtimes pruning retained. The candidate passed 23/23 rollback invariants in the
Virtualization.framework guest (VirtualMac2,1) and Windows history-selected predecessor restoration.
Earlier predecessors retain the compatibility limits recorded below; none of their historical
receipts qualifies this candidate.

## v0.7.2 predecessor compatibility

The selected predecessor is published v0.7.1. Gateway rollback does not change the separately
running OMP process. Both versions embed the same OMP 18.4.2 collaboration client and wire pin;
v0.7.2 moves the engineering baseline to stock OMP v18.4.8 without gateway runtime fixes.
Rolling back to v0.7.1 therefore does not undo a gateway runtime fix or replace OMP with the
predecessor's engineering baseline. After a v0.7.2 install, `rollback --to` can select only the
runtimes pruning retained. The candidate passed 23/23 Mac rollback invariants and Windows
history-selected predecessor restoration. Earlier predecessors retain the compatibility limits
recorded below; none of their historical receipts qualifies this candidate.

## v0.7.1 predecessor compatibility

The selected predecessor is published v0.7.0. Gateway rollback does not change the separately
running OMP process. Both versions embed the same OMP 18.4.2 collaboration client. Rolling back
restores v0.7.0's notification taps, which navigate an open page to the tapped route: in the
installed Android app that reloads a live collaboration, drops its unsent composer text, and lets
an activity-stop tap reopen a Control session as View (#327). It also restores a session list that
keeps its live-update stream open while frozen in the background (#328), and a gateway that can
hold an event stream whose client stopped reading (#321). After a v0.7.1 install, `rollback --to`
can select only the runtimes pruning retained. v0.6.3, further back, embeds OMP 18.3.0's
collaboration client and on Windows reads a failed scheduled-task query as a stopped gateway
(#301); v0.6.2 cannot be installed or run from a standard Windows account (#293, #294), and v0.6.0
cannot enable background alerts on iPhone or iPad (#274).

## v0.7.0 predecessor compatibility

The selected predecessor is published v0.6.3. Gateway rollback does not change the separately
running OMP process. Rolling back restores v0.6.3's embedded collaboration client, built from OMP
18.3.0's `collab-web` with React's development build, and its zoom into the composer when iOS
Safari focuses it on an iPad or a landscape phone (#305). On Windows, v0.6.3 reads any
scheduled-task query failure other than a missing task as a stopped gateway, so its `status`,
`stop`, readiness-token rotation, `install --no-start`, and `uninstall` can act on a running
gateway as if it had stopped (#301). Both versions install and run from a standard (non-elevated)
Windows account. After a v0.7.0 install, `rollback --to` can select only the runtimes pruning
retained. v0.6.2, further back, cannot be installed or run from a standard Windows account (#293,
#294), and v0.6.0 cannot enable background alerts on iPhone or iPad (#274).

## v0.6.3 predecessor compatibility

The selected predecessor is published v0.6.2. Gateway rollback does not change the separately
running OMP process. v0.6.2 cannot be installed or run from a standard (non-elevated) Windows
account: its install fails on `SeSecurityPrivilege` (#293) and then on registering the logon task
(#294). Rolling back to it on Windows therefore needs an elevated install. There, its `status` and
`doctor` read a standard user's running gateway as stopped over SSH, and its stop can return before
the gateway's process exits. Linux and macOS behavior does not differ between the two. After a
v0.6.3 install, `rollback --to` can select only the runtimes pruning retained. v0.6.0, further back,
cannot enable background alerts on iPhone or iPad: it rejects WebKit's push subscription, which
leaves out a null `expirationTime` (#274).

## v0.6.2 predecessor compatibility

The selected predecessor is published v0.6.1. Gateway rollback does not change the separately
running OMP process. The two signed archives hold the same 50 files and differ only in version
strings and release metadata, so rollback changes no gateway, PWA, or collaboration-client
behavior. After a v0.6.2 install, `rollback --to` can select only the runtimes pruning retained.
v0.6.0, one step further back, cannot enable background alerts on iPhone or iPad: it rejects
WebKit's push subscription, which leaves out a null `expirationTime` (#274).

## v0.6.1 predecessor compatibility

The selected predecessor is published v0.6.0. Gateway rollback does not change the separately
running OMP process. v0.6.0 cannot enable background alerts on iPhone or iPad: it rejects WebKit's
push subscription, which leaves out a null `expirationTime`, so the alerts control reads unavailable
(#274). Chrome includes the field and is unaffected. After a v0.6.1 install, `rollback --to` can
select only the runtimes pruning retained. v0.5.3, one step further back, also sends every push
with a per-session Web Push `Topic`, which FCM limits to a burst of about 20 messages per device,
and on Windows it can exit at logon without listening when its private-ACL helper starts slowly.

## v0.6.0 predecessor compatibility

The selected predecessor is published v0.5.3. Gateway rollback does not change the separately
running OMP process. v0.5.3 sends every push with a per-session Web Push `Topic`, which FCM limits
to a burst of about 20 messages per device, so background alerts can lag for minutes after busy
activity; an Android alert cleared moments after it appeared can also stay on screen. On Windows,
v0.5.3 can exit at logon without listening when its private-ACL helper starts slowly, as right
after install, and it then stays down until the next logon. After a v0.6.0 install,
`rollback --to` can select only the runtimes pruning retained. v0.5.2, one step further back, also
renders OMP 18.3.0's `wait` tool calls as generic tool cards.

## Fork-era lane and evidence archive

**All procedures, defaults, path tables, token-preservation claims, and results below are fork-era
records** for their named source/artifacts. Their patch settings and activation routes are not
current prerequisites. Historical dates, measurements, and failures are retained without
reclassifying them as mainline evidence.


One throwaway root on the operator's own macOS workstation, driven by
[`scripts/qualify-rollback.sh`](../scripts/qualify-rollback.sh). The selected signed predecessor is
installed, upgraded to the selected signed candidate, and restored while the production daemon
continues running on the same machine. Defaults are `v0.2.1` → `v0.3.0-prealpha.3`.

This document is the operating manual for that lane. It does not promote any ledger row. Every
command below prints numbers; the lead decides what those numbers mean.

The v0.3.0 campaign passed the explicit `v0.2.1` → `v0.3.0-prealpha.3` pair on Debian 13
x86-64 and macOS 26.6.1 arm64, including all 20 Mac rollback invariants. See
[`RELEASE_STATUS.md`](RELEASE_STATUS.md) for the signed archive and run binding; passing this
lane alone does not authorize stable promotion.
Current candidate upgrades preserve existing configuration unless an install option explicitly
overrides it, including custom registry limits and identity-trust settings. Historical predecessor
installers retain their original behavior; keep their matching configuration available for recovery.

## 1. Why rollback needs its own lane

The first-class `omp-gateway rollback` path has live systemd and focused unit coverage. This macOS
lane answers a different recovery question: can an operator with the predecessor archive restore
the installer's complete on-disk state without relying on the newer command? That remains relevant
when the candidate itself is the reason for rollback.

`rollback` is now a first-class CLI command in this codebase (`omp-gateway rollback [--to <version>]`).
That command resolves an installed predecessor by default, or a requested version directory, and
rejects malformed targets, unmanaged active services, missing rollback history, and uninstalled
rollback destinations. This lane instead installs the predecessor archive again so the measured
on-disk transition is anchored to recovery from an independently retained signed predecessor.

The installer keeps every runtime
side by side:

```
<stateDir>/installation/versions/<version>-<payload-digest-12>/…
<stateDir>/installation/current.json      {"versionDirectory":"0.1.0-8773d783ca96"}
```

so this reinstall path still requires three explicit checks:

1. does the predecessor's version directory actually survive the upgrade, which is the only reason
   rollback is possible at all;
2. does re-installing the predecessor move `current.json`, the LaunchAgent, `config.json`, and the
   publisher token consistently, or does one of them lag behind;
3. on macOS the LaunchAgent's `ProgramArguments` holds an **absolute path into a specific version
   directory**, so flipping `current.json` alone would leave launchd executing the wrong runtime.

## 2. The isolation model, and why it is trustworthy

### 2.1 What scoping actually scopes

`HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `TMPDIR` cover every path the gateway writes:

| Scoped by | Covers |
|---|---|
| `XDG_CONFIG_HOME` | `config.json`, `publisher-token` |
| `XDG_STATE_HOME` | `installation/versions/*`, `installation/current.json` |
| `TMPDIR` | the registry socket directory on macOS |
| `HOME` | `~/Library/LaunchAgents/omp-session-gateway.plist` |

`HOME` is the one that is easy to miss and the most dangerous to miss. The macOS service definition
path is built from `homedir()`, not from any `XDG_*` variable, so a root that scopes only the XDG
variables writes its LaunchAgent **over the production one** and deletes it again on uninstall.
`scripts/qualify-rollback.sh` asserts all five paths land inside the scratch root before anything
else happens, and prints the host plist's digest so a change is visible rather than inferred.

### 2.2 What scoping cannot scope, and the incident that proves it

launchd keys a LaunchAgent on `gui/<uid>/<label>` alone. No environment variable narrows that
namespace, so an isolated install still *sees* the production daemon under its own label. On
2026-08-19 that cost a live daemon four minutes: an "isolated" archive smoke read `active: true` off
the production service and booted it out.

`v0.1.0-prealpha.14` compares the loaded service's **program path** against `stateDir + sep`, so
`active` means "a service this install root owns is running". **`v0.1.0-prealpha.13` does not** —
see [section 5](#5-findings). The lane therefore drives one
artifact that will try to bootout the production daemon and one that will not, and has to survive
both.

### 2.3 The gate

Every isolated command runs through `env -i` with a `launchctl` shim first on `PATH`. `env -i` is
deliberate: an inherited `XDG_*` or `TMPDIR` is exactly how a "scoped" run leaks back onto the real
root. The shim does two things and logs both:

- **Refuses every mutating verb, unconditionally.** `bootout`, `bootstrap`, `kickstart`, `enable`,
  `load`, anything that is not a read — exit 90, logged, never forwarded. Nothing this lane runs can
  reach launchd's mutable state, whether or not the caller believed it owned the label.
- **Scopes `print` of our exact label** to the scratch root: if the loaded program lives elsewhere,
  the shim reports "not loaded". This is the launchd analogue of `XDG_STATE_HOME` — it shows an
  isolated root the view a dedicated host would show it — and it is what lets `.13`'s installer
  proceed at all.

Trust in that gate does not rest on reading it. Step 2 fires a **real** `launchctl bootout` of the
production label through the shim and aborts the run unless it comes back refused and logged, then
confirms the production daemon is still alive. A gate that has never refused anything cannot be
trusted to refuse anything, so the positive control is a gate, not an option.

The scoping is measured, never hidden:

- step 4b runs **both** artifacts' `status` with scoping **off**, against real launchd state, which
  is how the `.13` ownership defect is observed rather than assumed;
- step 8 replays the 2026-08-19 incident into the gate with scoping **off** and records what the
  CLI tried to do;
- every scoped read and every refusal is counted and printed.

### 2.4 Belt and braces

- Nothing is ever activated. `--no-start` throughout, so no isolated service is ever loaded, so no
  bootout is ever legitimate.
- The isolated root uses port **47317**, not 4317. The installer probes its own configured loopback
  port for a live listener; reusing the production port would aim that probe at the live daemon.
  Preflight aborts if anything is already listening on 47317.
- The `EXIT` trap removes the scratch root on every path, and boots out a service only if the
  loaded program path is *inside* the scratch root — using the real `/bin/launchctl`, never the
  shim, because the gate must not be able to answer a safety question about itself.
- The trap re-reads the host plist digest and the host daemon PID and fails the run if either
  changed.

## 3. Running it

Prerequisites: macOS, `bun`, `gh` (authenticated), `cosign`. Not root.

```sh
OMP_ROLLBACK_OLD_TAG=v0.1.0-alpha.1 \
OMP_ROLLBACK_NEW_TAG=v0.1.0-prealpha.20 \
  ./scripts/qualify-rollback.sh run      # full lane including both downloads
./scripts/qualify-rollback.sh clean      # remove leftover scratch roots from earlier runs
```

`run` is self-contained: it creates `/tmp/omp-rollback-qual/run-<stamp>-<pid>`, downloads and
verifies both tags into it, installs, upgrades, rolls back, prints the invariant table, uninstalls,
and removes the root on the way out. It exits non-zero if any invariant fails. `clean` is safe when
nothing exists.

The verification the script performs per tag, if you want to reproduce it by hand. This exact
legacy tag was signed by the old owner using `release.yml`; preserve that certificate identity.
For another tag, follow [Verify a published build](RELEASE.md#verify-a-published-build), which
selects the historical signing owner only for the closed pre-transfer tag set and requires
`carrythroughsystems/omp-session-gateway` for later releases:

```sh
TAG=v0.1.0-alpha.1
gh release download "$TAG" -R carrythroughsystems/omp-session-gateway -D . --clobber \
  -p omp-session-gateway-0.1.0-bun.tar \
  -p omp-session-gateway-0.1.0-bun.tar.sigstore.json \
  -p SHA256SUMS -p SHA256SUMS.sigstore.json

shasum -a 256 -c SHA256SUMS --ignore-missing

for asset in omp-session-gateway-0.1.0-bun.tar SHA256SUMS; do
  cosign verify-blob --bundle "$asset.sigstore.json" \
    --certificate-identity "https://github.com/alphastorm/omp-session-gateway/.github/workflows/release.yml@refs/tags/$TAG" \
    --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
    "$asset"
done
```

Note for anyone extending this with GitHub attestations: `gh attestation download` has **no**
`--output-file` flag. It writes `sha256:<digest>.jsonl` into the working directory, so run it inside
the scratch directory or it litters the repository.

## Current beta predecessor result

On 2026-08-21, macOS 26.6.1 arm64 with Bun 1.3.14 installed signed
`v0.1.0-alpha.1`, upgraded to signed `v0.1.0-prealpha.20`, and restored alpha.1.
Both archives passed checksum and Cosign verification. All **20/20** invariants passed:
`current.json` and the LaunchAgent followed each active version, both runtimes remained available,
configuration and publisher-token content/mode stayed unchanged without printing a token
fingerprint, uninstall preserved the documented data, and the unrelated live LaunchAgent plist and
daemon remained unchanged. The scratch root was removed.

This is gateway rollback-by-reinstall with `--no-start`. It does not claim a coordinated OMP
downgrade: before restarting sessions, the operator must separately repoint
`omp-gateway-patched` to the exact alpha v17.3.8 build and repeat its source/tree/version/config
assertions. Paired OMP update/rollback remains deliberately unimplemented.

Separately, the exact alpha.1 v17.3.8 patch and beta v17.4.1 patch were built with their matching
official macOS arm64 native addons. In an isolated home, `omp-gateway-patched` moved
alpha→beta→alpha; every step asserted the symlink target and `--version`, and both collaboration
settings survived. No OMP process or live gateway participated, so this proves the manual
version/config primitive rather than a coupled service rollback.

## 4. Historical pre-alpha record

The 2026-08-20 macOS 26.6.1 arm64/Bun 1.3.14 run used `.13` and `.14` to expose
the historical launchd ownership defect. An unrelated live production daemon remained running
throughout; its PID, program path, and token/config fingerprints are intentionally omitted here.

| Artifact | Archive sha256 | Bundled `cli.js` | Stages version directory |
|---|---|---|---|
| `v0.1.0-prealpha.13` | `af79e1c563c386243e52dae1e6571b67adb5d5b8e9ccd080149d329e274397ad` | 194,026 bytes | `0.1.0-1b654b660ec4` |
| `v0.1.0-prealpha.14` | `a2e1db2ad90e9ca092e84372ac503e41981c3782d62ddbb4f87db83c4ca57172` | 195,466 bytes | `0.1.0-8773d783ca96` |

Both tags passed `shasum -c` and `cosign verify-blob` for the archive and for `SHA256SUMS`. `.14`
stages the same payload digest the live daemon is running, which is the expected identity check on
the candidate.

**20 of 20 invariants passed.** The three-step sequence:

| Step | `current.json` | Version directories present | LaunchAgent `ProgramArguments` | `config.json` sha256 | Token |
|---|---|---|---|---|---|
| install `.13` | `0.1.0-1b654b660ec4` | `.13` | `0.1.0-1b654b660ec4` | `60d9c36e…c17cd86c` | mode 600 |
| upgrade `.14` | `0.1.0-8773d783ca96` | `.13` `.14` | `0.1.0-8773d783ca96` | `60d9c36e…c17cd86c` | unchanged, mode 600 |
| rollback `.13` | `0.1.0-1b654b660ec4` | `.13` `.14` | `0.1.0-1b654b660ec4` | `60d9c36e…c17cd86c` | unchanged, mode 600 |

The specific answers to [section 1](#1-why-rollback-needs-its-own-lane):

- **The predecessor survives.** `0.1.0-1b654b660ec4` was still on disk after the upgrade; the
  directory count went 1 → 2 and stayed at 2. Rollback re-used it rather than re-staging from
  scratch: the installer's rename hits `EEXIST`, discards its staging copy, and re-validates the
  existing directory against its recorded payload hash.
- **The suspected LaunchAgent bug did not reproduce.** The plist's `ProgramArguments` named the
  active version at all three steps, rollback included. `install` rewrites the service definition
  with the newly staged CLI path before it writes `current.json`, so the plist cannot be left
  pointing at the superseded directory by a *successful* install. By inspection of that ordering the
  two writes are not atomic, so a crash between them would leave the plist ahead of the pointer;
  that window was not exercised here and remains untested.
- **Configuration and token are untouched.** `config.json` was byte-identical across all three
  steps, and the publisher token's digest and mode `600` were identical across all three. The
  uninstall preserved both, as it advertises, and the token digest still matched afterwards.

Uninstall removed the isolated LaunchAgent and left 101 files under `config/` and `state/` — the two
runtime payloads plus `config.json` and `publisher-token`. That is the documented behaviour
("Configuration and publisher token were preserved"), not residue to clean up; the scratch root is
then removed wholesale by the trap.

Production was untouched: PID 51469 alive at every checkpoint, host plist digest
`e01151c90aae50089f45792d8cee478e024a768a33a5e1e3d1e831fe0d79cb18` unchanged from preflight to
teardown.

Gate activity across a run: 4 scoped launchd reads, 2 refused mutating calls — the step 2 positive
control and the one described below.

## 5. Findings

Both concern the **published `v0.1.0-prealpha.13` artifact**, and both are about service ownership
rather than about rollback state.

### 5.1 `.13` claims the production daemon as its own

With launchd scoping **off**, both artifacts were asked the same question about the same real
launchd state from the same isolated root:

```
.13  {"service":"omp-session-gateway","installed":true,"active":true, "ready":false,"authMode":"tailscale-serve"}
.14  {"service":"omp-session-gateway","installed":true,"active":false,"ready":false,"authMode":"tailscale-serve"}
```

The only loaded service was
`~/.local/state/omp-session-gateway/installation/versions/0.1.0-8773d783ca96/apps/gateway/src/cli.js`,
which belongs to the production root. `.13`'s ownership test is `launchctl print <label>` exiting
zero, with no check of which install root owns the loaded program; `.14` added the program-path
comparison and answers correctly.

### 5.2 `.13`'s uninstall targets the production daemon from an isolated root

Running `.13`'s `uninstall` from the isolated root with scoping off produced exactly one mutating
call: `launchctl bootout gui/<uid>/omp-session-gateway`. The gate refused it (exit 90), the CLI
aborted with exit code 1, and PID 51469 was confirmed alive immediately afterwards. Without the
gate that call would have stopped the production daemon — the 2026-08-19 incident, reproduced on
demand and contained.

The practical consequence, and the reason this is worth a ledger note rather than a shrug: **rolling
back to `.13` restores a runtime whose own lifecycle commands cannot tell a foreign service from
their own.** On a single-install host that is harmless, because the label really is theirs. It
becomes a hazard the moment a second root exists on the same account, which is precisely what any
qualification or recovery procedure creates.

A secondary effect, visible only because of the defect: `.13` refuses `install --no-start` with
"refusing --no-start while the gateway service is active" whenever any service holds the label. On a
real host that refusal is correct. From an isolated root it fires for the wrong reason, and it is
why the lane needs launchd read-scoping to exercise the rollback step at all.

## 6. Which ledger rows these observables bear on

They **bear on**, without promoting:

- **Configuration migration and rollback** — the direct target. The row's forward-upgrade half is
  already recorded; this adds an executed rollback with measured pointer, version-directory,
  LaunchAgent, `config.json` and token observables from two independently verified signed archives.
  It does not close the row: see [section 8](#8-what-this-lane-does-not-prove).
- **macOS host lifecycle** — adds a signed-candidate install/upgrade/rollback/uninstall sequence and
  the `.13` ownership findings. It adds nothing about reboot/login persistence, Serve, or a running
  service.
- **Platform install/doctor/uninstall** — adds signed-artifact install and uninstall on macOS. No
  `doctor` run is part of this lane.

They explicitly **do not bear on**:

- **Linux host lifecycle** and **Windows host lifecycle**. Both name rollback in their "Required to
  close" column and neither is exercised here; this script refuses to run anywhere but macOS.
- Any row about Tailscale, relay, Android, browsers, or capability leakage.

Per the ledger's own updating rule, the row text is the lead's to change; this document is the
named record the change would cite.

## 7. Secret handling

- The publisher token is compared by digest and mode. Its bytes are never read into a variable,
  printed, or written anywhere by this lane.
- The recorded digest is `sha256:` plus the first 12 hex characters of the token file's SHA-256,
  matching how the ledger records it. A fresh isolated root mints a fresh token, so the digest
  differs between runs by design; the invariant is that it does not change *within* a run.
- `rollback-qual@example.invalid` and `https://rollback-qual.example.ts.net` are placeholders. The
  login is in a reserved TLD precisely so nobody can ever authenticate as it.
- No capability, real login, tailnet name, or host path outside the scratch root is written by the
  lane.

## 8. What this lane does not prove

- **Nothing was ever started.** `--no-start` throughout. This is the installer's state machine —
  version directories, `current.json`, the service definition, config and token — not a running
  service transition. No bootout/bootstrap, no readiness handshake, no PID replacement, no
  post-rollback `status`/`doctor`/health probe. A rollback that leaves correct files behind but
  fails to bring the predecessor back up would pass every invariant here.
- **An isolated root is not a login-session service manager.** launchd's label namespace is
  per-uid and cannot be scoped, so the lane substitutes a shim for the part of launchd it cannot
  isolate. Everything downstream of "the service definition on disk is correct" — RunAtLoad,
  KeepAlive, reboot and login persistence, `bootstrap` failure modes — is untested by construction.
- **The rollback step depends on that shim.** `.13` cannot complete an isolated install while a
  foreign service holds the label (see [section 5](#5-findings)). On a dedicated host the scoping
  would be a no-op, but on this host the rollback result was obtained with launchd reads scoped, and
  that is a difference from a bare rollback on a clean machine.
- **Only one rollback shape was exercised.** `.13` was staged fresh in step 4 and re-installed over
  its own existing directory in step 6. A rollback after the predecessor directory has been pruned,
  a rollback across a `config.json` schema change, and a rollback across a readiness-protocol change
  (`instance-v1` → `legacy`) are all untested.
- **One host, one architecture, one Bun.** macOS 26.6.1 arm64 with Bun 1.3.14. Nothing here speaks
  to Intel macOS, to another macOS release, or to another Bun.
- **No OMP publisher, browser, or device.** No session discovery, View/Control, relay, or
  capability-leak evidence comes out of this lane.
- **Signature verification proves origin, not fitness.** Checksum and Cosign results establish that
  the bytes are the ones the release workflow produced at that tag. They say nothing about whether
  that build passes any behavioural gate.
- **The two findings are observations about `.13`, not a rollback verdict.** The rollback state
  transition itself was clean on every invariant measured.

## 9. Related documents

- [`RELEASE_STATUS.md`](RELEASE_STATUS.md) — the ledger; the only place a row's status changes.
- [`SECURITY.md`](SECURITY.md) — §9 local IPC, §12 supply chain and updates.
- [`RELEASE.md`](RELEASE.md) — the canonical artifact verification commands this lane runs.
- [`OPERATIONS.md`](OPERATIONS.md) — install, paths, and `doctor` semantics.
- [`LINUX_QUALIFICATION.md`](LINUX_QUALIFICATION.md) — the sibling lane; upgrade and rollback are
  explicitly out of scope there.
