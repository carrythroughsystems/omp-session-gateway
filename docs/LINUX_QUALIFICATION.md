# Linux qualification lane

This runbook is for maintainers running the Debian Linux release qualification lane. For normal
Linux installation, follow the [operations guide](OPERATIONS.md#2-cli-and-daemon-installation).
Debian 13 (trixie) x86-64 is qualified in the current stable release (`v0.7.4`); see
[Compatibility](COMPATIBILITY.md) and [Release status](RELEASE_STATUS.md).

## Mainline qualification — Debian core lane passed

The current workflow (`droplet-qualification.yml`) is on-demand and requires an exact signed
candidate tag; it does not run a weekly schedule or fall back to a historical fork-era candidate.
Current source requires stock OMP `>= 18.1.20` with `collab.autoStart` alone: the gateway reads
discovery and queries hosts without a publisher socket or stored capabilities.

Each stable campaign runs this disposable Debian 13 (trixie) x86-64 lane against its exact signed
candidate and published predecessor (`v0.7.4-prealpha.1` against `v0.7.3` with stock OMP `18.5.1`
and Bun `1.4.0` for `v0.7.4`). At the first mainline cutover, signed candidate `v0.4.0-prealpha.1`
passed on Linux `6.12.94+deb13-amd64` with stock OMP `18.1.20` and Bun `1.4.0` against predecessor
`v0.3.0` in [run 34830668687](https://github.com/alphastorm/omp-session-gateway/actions/runs/34830668687),
covering 69/69 migration/recovery invariants, generation-1 View/Control publication and revocation,
reboot/lingering persistence, tagged-identity denial/exposure, uninstall, and droplet/SSH-key
teardown. Every campaign's run receipt is recorded in the [release ledger](RELEASE_STATUS.md).

This is not a Debian `doctor` 18/18 claim: the tagged droplet's self-probe through Serve has no user
identity, while positive allowlisted HTTPS is measured from the user-owned Mac and Pixel. Other
Linux distributions and init systems are not qualified by this Debian result.

## Fork-era procedure and evidence archive

**Every procedure, requirement, result, and platform claim below is fork-era evidence**, retained
for its named source/candidate and date. It is not the current installation manual. References to
patches, publication tokens, named activation routes, old settings, script output fields, and
“current” candidates mean the matching historical checkout. Use [OPERATIONS.md](OPERATIONS.md)
for mainline setup and [RELEASE.md](RELEASE.md) for new candidate gates. Current qualification
uses `UPSTREAM.lock.json` source pins rather than a patched tree; script retargeting is not a
successful Linux rerun.


One throwaway DigitalOcean droplet, driven by
[`scripts/provision-linux-qual.sh`](../scripts/provision-linux-qual.sh), that produces measured
evidence for five gaps in [`RELEASE_STATUS.md`](RELEASE_STATUS.md) at once.

This document is the operating manual for that lane. It does not promote any ledger row. Every
command below prints numbers; the lead decides what those numbers mean.

## 1. Why a droplet and not the existing container

The Linux evidence in the ledger came from a Debian 13 aarch64 container with a real `systemd --user`
manager. That run was worth having: it proved the install/readiness/permissions/reinstall/rotation/
uninstall sequence and file modes. It could not prove five things, for structural reasons rather
than for want of effort.

| The container could not show | Because |
|---|---|
| A real machine lifecycle | It shares the host kernel, has no firmware or boot sequence of its own, and no public address of its own. |
| Reboot and login persistence | It never boots. Its user manager exists because something outside it kept the container alive, so "the service came back" was never a question it could be asked. |
| A denied Tailscale identity | It was not a tailnet node. Every tailnet device on a single account is user-owned, and Serve stamps user-owned sources with a login that is on the allowlist, so denial has never been observable. |
| Public-Internet unreachability | It had no public IP, so "the listener is not reachable from the Internet" was true by absence rather than by policy. |
| Exact patched-OMP operation on Linux | It contained only the gateway and synthetic publishers; the mandatory versioned OMP binary was never built or run there. |

A droplet answers all five. It boots, it can be rebooted freely unlike the operator's workstation,
it has a routable public IP, it can join the tailnet as a **tagged** node, and it can build and run
the exact patched OMP prerequisite against the signed gateway on the advertised architecture.

The default image is `debian-13-x64` deliberately. The ledger already carries Debian 13 evidence, so
keeping the distribution fixed makes the container-versus-machine comparison clean instead of
introducing a second variable. The architecture does change, from aarch64 to x86_64; see
[section 8](#8-what-this-lane-does-not-prove).

The image is a *parameter*, not a constant: `OMP_QUAL_IMAGE` also accepts a numeric DigitalOcean
custom image id, which is how [section 10](#10-the-non-systemd-path-alpine-and-openrc) points this lane at
an imported Alpine image to observe what the installer does on a host with no systemd. Leaving the
knob unset reproduces the Debian run exactly.

## 2. The five gaps, and how each is closed

### Gap 1 — bare-metal/VM Linux host lifecycle

Lane `host` records the machine's own facts: distribution, kernel, `systemd-detect-virt`, systemd
version, CPU/memory, boot id, uptime, and the public IPv4 the droplet reports from its own metadata
service. Lanes `lifecycle` and `uninstall` then run the full install/status/doctor/rotate/uninstall
sequence on that machine from the signed archive.

### Gap 2 — reboot and login persistence

A `systemd --user` service only survives logout and reboot without an active session if lingering is
enabled for that user. The gateway's unit is `WantedBy=default.target` with `Restart=on-failure`, and
`omp-gateway install` does **not** call `loginctl enable-linger`. So "it came back after reboot" is
ambiguous by default: it can mean lingering started the user manager at boot, or it can mean the SSH
login used to check created a session that pulled in `default.target`.

Lane `persistence` removes the ambiguity by rebooting twice and measuring from **root only**, so the
qualified user has no *login* session at the instant of measurement:

- **Pass A, negative control.** `loginctl disable-linger ompqual`, reboot, then measure as root. The
  daemon must be absent and the user must own **no session of any class**; `user@<uid>.service` is
  `inactive` and the loopback probe fails. A follow-up SSH login as `ompqual` then shows the unit
  starting, with a process age far smaller than system uptime — which is what "a login session
  started it" looks like.
- **Pass B, the persistence claim.** `loginctl enable-linger ompqual`, reboot, measure as root again.
  The daemon must be running, the user must own **no session of class `user`**, and it must own **at
  least one session of class `manager`**. Its process age must track system uptime rather than the
  age of our connection.

**The measurement is session class, never session count.** When lingering works the count can never
be zero: the lingering user manager is itself a session, of class `manager`, type `unspecified`,
`Remote=no`. Its presence is exactly what lingering succeeding looks like, and #69's original
evidence recorded class `manager` for the same reason. Only a session of class `user` means somebody
is logged in. An earlier revision of this lane printed the count and a narrative line claiming the
count was zero; against candidate `v0.1.0-prealpha.17` the count printed `1` while the narrative
asserted `0`, which read as the lane contradicting itself. The count was the wrong measurement, not
the product's behaviour.

Both passes print every session the user owns as `id(class=…,type=…,remote=…)`, the class-`user` and
class-`manager` counts, and the `process Ns old, system up Ms` pair, and then assert the properties
above and fail the lane if they do not hold. Sessions are enumerated by session id — the one column
`loginctl list-sessions` has had in every systemd version — and classified with `loginctl
show-session`, because that table's column layout has changed across releases and a positional field
is not a fact. Pass B is evidence only in combination with pass A; on its own it cannot distinguish
the two causes.

Reboots are detected by boot id, not by a sleep: the script records
`/proc/sys/kernel/random/boot_id`, issues the reboot, and returns only when SSH answers with a
*different* boot id. A pre-reboot host can therefore never be mistaken for the rebooted one.

### Gap 3 — denied Tailscale identity

This is the reason the box is worth provisioning. Tailscale Serve populates `Tailscale-User-Login`
only for **user-owned** source devices. A tagged node carries no user identity, so a request proxied
through Serve from a tagged source arrives with no user identity at all, and the gateway's
`tailscale-serve` auth mode must fail closed. `docs/SECURITY.md` §4 states this property and §13
requires proving that "tagged-without-supported-auth" identities are denied; this lane is where that
is actually observed.

Lane `identity` measures a matrix:

| Source | Allowlist at the time | Expected |
|---|---|---|
| The tagged droplet, to its own Serve origin | a synthetic address | `403`, and zero `Tailscale-User-*` headers reaching the backend |
| The operator's workstation, a user-owned node, through Serve | a synthetic address | `403` with a well-formed identity that Serve supplied |
| The operator's workstation, through Serve | the workstation's real login | `200`, `no-store`, body keys metadata-only |
| The workstation with a forged `Tailscale-User-Login` header | a synthetic address | `403` — the forged value is discarded |
| The workstation with the same forged header | the real login | `200` — the forged value is ignored, the real identity decides |
| The droplet's tailnet IP, straight to the backend port | any | connection refused |
| The droplet's **public** IP, straight to the backend port, from the workstation | any | connection refused |

The first row is "identity absent". The second is "identity present, well-formed, not equal to the
allowlist". Together they are the two denial shapes the ledger asks for. The forged-header pair is
what shows the header is Serve-controlled rather than caller-controlled: the same supplied value is
refused when the caller's real identity is not allowlisted and ignored when it is.

`tailscale whois` is printed alongside, so the discriminator between "absent" and "present" is a
measurement rather than an assumption: on the tagged pass it reports no user profile and a tag list.

**Be clear about the limit.** A tagged node can never present a user identity, so this box cannot
produce a *second, distinct user* identity. The allowed half therefore comes from the operator's
workstation, which is a genuinely separate user-owned tailnet node — that is real distinct-device
evidence, but it is the operator's own identity, not a third party's. If the ledger needs a denial by
a *different real person's* login, this lane does not provide it and no single-account tailnet can.

A second consequence: `doctor` cannot pass every check on a tagged node, because `doctor` probes its
public origin and that probe has no user identity. Expect these checks to be `false` and read them as
the denial result rather than as a gateway fault:

| Check | Why it is false on a tagged node |
|---|---|
| `identityAllowed` | The self-probe through Serve is refused, which is the denial being measured. |
| `publisherHealth` | Derived from the same refused session list. |
| `pwa` | `/`, `/manifest.webmanifest`, and `/service-worker.js` are refused for the same reason. |
| `securityHeaders` | Read from that refused response; whether a `403` carries the CSP header is printed rather than predicted. |

`publisherHealth` remains intentionally empty during `identity`: lane `omp` runs and revokes its
real publisher before the identity matrix changes the allowlist.

### Gap 4 — install/doctor/uninstall from the signed candidate artifact

Lane `artifact` downloads the release assets, verifies them, and only then extracts them. Three
independent verifications run **on the droplet**, not on the workstation:

1. `sha256sum --check SHA256SUMS`, with the measured archive digest printed;
2. `cosign verify-blob` against each published `.sigstore.json` bundle, pinned to the exact
   certificate identity https://github.com/<repo>/.github/workflows/signed-release.yml@refs/tags/<tag>
   and the GitHub Actions OIDC issuer. The signer repository is selected from the new owner and,
   only for the closed pre-transfer tag set captured on 2026-10-09, the original owner;
3. `gh attestation verify` for the archive, SBOM, and `SHA256SUMS`, pinned to `--signer-workflow` and
   `--source-ref refs/tags/<tag>`.

Qualification inputs, including GitHub tokens and macOS sudo credentials, travel inside an
NUL-framed SSH stdin bootstrap. They must never appear in workstation SSH argv, remote process
argv, or exported remote environment.

`gh attestation verify` needs GitHub API access. If `GH_TOKEN` is exported the droplet verifies
online; otherwise the script uses the already-authenticated workstation `gh` to
`gh attestation download` the bundles, uploads them, and the droplet verifies offline with
`--bundle`. The mode used is printed either way.

`cosign` and `gh` are fetched onto the droplet from their upstream releases and their sha256 digests
are printed, so the run records which tool binaries produced the result.

The lane then extracts the archive and prints its bundled `UPSTREAM.lock.json` pin and
`release-info.json` source commit. That is how a Linux run proves it exercised the exact current
development pin rather than a stale baseline. It installs the Bun version recorded by the lock and
runs the archive's `apps/gateway/src/cli.js` for every subsequent step, never a development
checkout.

### Gap 5 — the exact patched-OMP prerequisite on Linux

Lane `omp` consumes the patch from the already verified candidate archive, clones exact OMP
`v17.4.1`, asserts its source commit and post-patch tree, stages OMP's official Linux x86-64 native
addon, runs the complete upstream source check, and builds a versioned `omp-gateway-patched`
executable. The lane then:

1. verifies the binary version, SHA-256, symlink target, and persisted `collab.autoStart=control` /
   `collab.registryEndpoint=auto` settings;
2. starts the real binary in an SSH-backed pseudo-terminal with output discarded;
3. observes exactly one generation-1 registry record with View and Control;
4. validates generation-bound View and Control launch responses and `no-store` without writing or
   printing either bearer capability;
5. closes the OMP process, observes immediate registry revocation, and removes the source, binary,
   symlink, config, and process before later lanes.

The source check has its own 25-minute deadline so a stalled upstream build cannot consume the
workflow's teardown window. The unattended workflow uses `s-2vcpu-4gb`; direct gateway-only runs
retain the script's cheaper `s-1vcpu-2gb` default.

## 3. Prerequisites

### DigitalOcean

- `doctl` installed and authenticated. Either `doctl auth init` or
  `export DIGITALOCEAN_ACCESS_TOKEN=…`. Create the token at **DigitalOcean → API → Tokens →
  Generate New Token** with read and write scope for droplets. The script calls `doctl account get`
  first and refuses to continue if authentication fails.
- An SSH key registered in the account. The lane defaults to key id **11924832** (name `Alpha`) and
  accepts `OMP_QUAL_SSH_KEY_ID` to override it. Preflight fetches that key's fingerprint and requires
  a matching local private key — from `OMP_QUAL_SSH_IDENTITY`, from `~/.ssh/*.pub`, or from
  `ssh-agent`. If nothing matches it fails and says so **without creating a droplet**, because a
  droplet you cannot log into is pure cost.

### Tailscale

- An auth key that applies the tag, created at **Tailscale admin console → Settings → Keys →
  Generate auth key**:
  - **Tags:** `tag:omp-session-gateway`. This is what makes the node tagged and therefore
    identity-less, which is the entire point of gap 3. Provision fails if the joined node reports no
    tags.
  - **Pre-approved:** required if your tailnet has device approval enabled.
  - **Ephemeral: no.** An ephemeral node is removed shortly after it goes offline, and this lane
    reboots the machine twice. Losing the node mid-run would take the Serve mapping and the node
    identity with it. Cleanup is handled by `destroy` instead.
- `tagOwners` for `tag:omp-session-gateway` in the tailnet policy, and a grant permitting your user
  to reach that tag on `tcp:443`. [`examples/tailscale-policy.hujson`](../examples/tailscale-policy.hujson)
  is the template; it is not drop-in and must be merged into existing policy.
- HTTPS certificates enabled for the tailnet (MagicDNS plus HTTPS), which `tailscale serve` requires.
- Optional: `TS_API_KEY`, an API access token from the same Keys page. Without it `destroy` logs the
  node out but cannot delete the machine record, and you must remove `omp-gateway-qual` in the admin
  console by hand.

### Workstation

`jq`, `curl`, `ssh`, `scp`, `ssh-keygen`, and an authenticated `gh` (used to download release assets
and, when `GH_TOKEN` is absent, attestation bundles). The script checks for each and names the
missing one.

### The candidate

`OMP_QUAL_RELEASE_TAG` must name a published signed candidate, for example `v0.1.0-prealpha.14`. The
archive and SBOM filenames are derived from `package.json`'s version; override with
`OMP_QUAL_VERSION` if they ever diverge.

## 4. Running the lane

```sh
# Credentials. Nothing below is ever echoed, written to a file, or passed in argv.
export DIGITALOCEAN_ACCESS_TOKEN=...      # or: doctl auth init
export TS_AUTHKEY=tskey-auth-...          # tagged, pre-approved, NOT ephemeral
export TS_API_KEY=tskey-api-...           # optional, lets destroy delete the tailnet node

# What to qualify.
export OMP_QUAL_RELEASE_TAG=v0.1.0-prealpha.20
export OMP_QUAL_PREVIOUS_TAG=v0.1.0-alpha.1
export OMP_QUAL_ALLOWED_LOGIN=you@example.com   # optional; read from local `tailscale status` if unset

cd /path/to/omp-session-gateway
./scripts/provision-linux-qual.sh provision
./scripts/provision-linux-qual.sh qualify
./scripts/provision-linux-qual.sh status
./scripts/provision-linux-qual.sh destroy
```

`provision` is idempotent: it reuses an existing droplet named `omp-gateway-qual` rather than creating
a second one, and it skips `tailscale login` if the node is already online. Re-running it after a failed
attempt is safe and cheap.

`qualify` accepts a lane list, so a single observation can be repeated without paying for the whole
sequence again:

```sh
./scripts/provision-linux-qual.sh qualify host
./scripts/provision-linux-qual.sh qualify artifact lifecycle
./scripts/provision-linux-qual.sh qualify artifact lifecycle omp
./scripts/provision-linux-qual.sh qualify migration
./scripts/provision-linux-qual.sh qualify rollback
./scripts/provision-linux-qual.sh qualify identity
./scripts/provision-linux-qual.sh qualify persistence
./scripts/provision-linux-qual.sh qualify uninstall
```

Default order is
`host artifact lifecycle omp migration rollback identity persistence uninstall`. The OMP lane
proves and then removes a real publisher before the identity matrix changes the allowlist.
`omp`, `migration`, `identity`, and `persistence` assume `artifact lifecycle` has already verified
and installed the service, and `rollback` additionally assumes `migration` has run — see
[section 11](#11-the-two-rollback-mechanisms). Run them after those lanes, or after a previous full
run, not standalone on a fresh droplet. With `OMP_QUAL_INIT=openrc` the default becomes
`host artifact init`; every lane that needs an installed service is refused by name before a
droplet is touched.

Lane `migration` proves explicit forward upgrade and rollback on a real systemd user manager, which
the macOS harness in [`UPGRADE_ROLLBACK.md`](UPGRADE_ROLLBACK.md) cannot do: it has no user unit, no
`enable` state, and no service manager that owns the runtime directory, and
[#69](https://github.com/alphastorm/omp-session-gateway/issues/69) showed those are exactly where
Linux differs. It installs `OMP_QUAL_PREVIOUS_TAG`, upgrades to `OMP_QUAL_RELEASE_TAG`, then
installs the predecessor again, and checks at each step that `current.json` names the expected
version, the predecessor's version directory survives the upgrade, `config.json` stays
byte-identical, the publisher-token digest and mode are unchanged, the unit's `ExecStart` tracks the
active version instead of going stale, the unit is still `enabled`, the main pid actually changes
across the upgrade so the daemon is genuinely replaced, and the listener stays loopback-only. It
skips with a message rather than failing when the two tags are equal.

Every step `migration` takes is an `install`, so what it proves is **rollback-by-reinstall**. It
never runs the `omp-gateway rollback` command. Lane `rollback` does, and the two are different code
paths; do not read either as covering the other. See
[section 11](#11-the-two-rollback-mechanisms).

**Predecessor tags and the `RuntimeDirectory=` fix.** A predecessor at `v0.1.0-prealpha.14` or
earlier renders a *pre-#69* unit: it names the runtime directory in `ReadWritePaths=` instead of
letting systemd own it with `RuntimeDirectory=`, and such a unit fails after a reboot. That is only a
hazard if a pre-fix unit is still installed when something reboots the box, so the ordering matters:
lane `rollback` deliberately ends by putting the candidate back, which rewrites the unit into the
post-fix shape and asserts it, so `persistence` never reboots onto a pre-fix unit. Running
`migration` and then `persistence` **without** `rollback` in between does reboot onto one, and the
failure you would get is #69 rather than anything about upgrade or rollback.

The current workflow defaults are the independently published
`v0.1.0-alpha.1` predecessor and signed `v0.1.0-prealpha.20` candidate. Override both explicitly
when qualifying a successor; the script never follows “latest” because that would silently change
the subject of the evidence.

Lane `uninstall` leaves the droplet clean — no service, no Serve mapping — so the next `qualify` starts
from the same state as the first.

### Environment knobs

| Variable | Default | Purpose |
|---|---|---|
| `OMP_QUAL_NAME` | `omp-gateway-qual` | Fixed droplet name; the basis of idempotency. |
| `OMP_QUAL_REGION` | `sfo3` | Any region carrying the size. |
| `OMP_QUAL_SIZE` | `s-1vcpu-2gb` | Smallest size with enough memory for Bun plus the build tools. |
| `OMP_QUAL_IMAGE` | `debian-13-x64` | Distribution slug, or a numeric custom image id. A purely numeric value is treated as an imported image and validated against `doctl compute image get` for existence, `available` status, and this region; anything else is validated against the distribution list exactly as before. |
| `OMP_QUAL_SSH_KEY_ID` | `11924832` | DigitalOcean SSH key id. |
| `OMP_QUAL_SSH_IDENTITY` | unset | Explicit private key path for `ssh`/`scp`. |
| `OMP_QUAL_USER` | `ompqual` | The non-root user the gateway is installed as. |
| `OMP_QUAL_ALLOWED_LOGIN` | local `tailscale status` | Login used for the allowed half of the identity matrix. |
| `OMP_QUAL_PORT` | `4317` | Gateway loopback port. |
| `OMP_QUAL_BUN_VERSION` | `1.4.0` | Matches current `UPSTREAM.lock.json`; use the tagged pin for historical releases. |
| `OMP_QUAL_GH_VERSION` | `2.97.0` | `gh` release fetched onto the droplet. |
| `OMP_QUAL_COSIGN_VERSION` | `3.1.3` | `cosign` release fetched onto the droplet. |
| `OMP_QUAL_TAG` | `tag:omp-session-gateway` | Tag the auth key is expected to carry; used in messages only. |
| `OMP_QUAL_PREVIOUS_TAG` | `v0.1.0-alpha.1` | Exact predecessor for the `migration` lane and the first of the two archives lane `rollback` reads. |
| `OMP_QUAL_INIT` | `systemd` | `systemd` is the historical path and changes nothing. `openrc` provisions a non-systemd box — no Tailscale, an Alpine-shaped cloud-config, the `init` lane instead of the install lanes — to measure the installer's refusal. Any other value is rejected in preflight before anything is created. |
| `GH_TOKEN` | unset | If set, the droplet verifies attestations online instead of offline. |

### Why the gateway runs as a non-root user

`ompqual` exists so that persistence can be measured from outside the user whose service is being
observed. Root SSH stays available for measurement, which is what makes "zero login sessions for the
service's user" a checkable statement. It is also the realistic deployment shape: the gateway
installs a per-user service, not a system one.

Two provisioning steps support this and are worth knowing because neither is done by
`omp-gateway install`:

- `tailscale set --operator=ompqual`, so the non-root user can drive `tailscale serve` and so
  `doctor` can query the local API. Without it, `tailscaleConnected` and `funnelDisabled` fail for a
  permission reason that looks like a gateway fault.
- `loginctl enable-linger ompqual`, so the install and identity lanes are not perturbed by our own
  short SSH sessions starting and stopping the unit. Lane `persistence` turns it off again on purpose
  as its negative control, and leaves it on at the end.

The lifecycle lane also asserts `XDG_RUNTIME_DIR` is set in the SSH session before installing.
`install` derives the runtime directory from it and so does the daemon systemd starts; if the two
disagree, the registry socket lands somewhere the service cannot use. The check fails loudly rather
than producing a subtly broken install.

## 5. Evidence this lane produces, by ledger row

Rows are named exactly as they appear in [`RELEASE_STATUS.md`](RELEASE_STATUS.md). This table says
what is measured and where; it does not assert that any row should change.

| Ledger row | Command | Observable |
|---|---|---|
| Linux host lifecycle | `qualify host lifecycle uninstall` | `systemd-detect-virt` on a booting machine; `status` returning `{installed:true,active:true,ready:true,authMode:"tailscale-serve"}` from the archive CLI; `config.json` `600` in a `700` directory; `publisher-token` `600`; `registry.sock` under `$XDG_RUNTIME_DIR`; main PID before/after `rotate-publisher-token`; `uninstall --no-stop` refused while active; unit file, process, and listener all gone after `uninstall`. |
| Linux host lifecycle (reboot/login half) | `qualify persistence` | Pass A: lingering off, no session of any class for the user, `user@<uid>.service` `inactive`, no daemon PID, loopback probe fails. Pass B: lingering on, no session of class `user` and at least one of class `manager`, `user@<uid>.service` `active`, daemon PID present, process age ≈ system uptime, loopback probe `403`. Every session the user owns is printed with its class, type, and remote flag. |
| Configuration migration and rollback (command path) | `qualify rollback` | `omp-gateway rollback` refusing to guess when the activation history names no predecessor, with its message compared against the one `installation.ts` documents; `rollback --to <version-directory>` and the bare form each moving `current.json`, rewriting the unit's `ExecStart` to an absolute versioned path, reloading the unit, restarting the daemon, rebinding the loopback listener, and leaving `config.json` and the publisher token byte-identical; `history.json` gaining one activation equal to the new pointer and written after it; and an induced definition-newer-than-pointer divergence reported by `status` and repaired back to the older proven version. See [section 11](#11-the-two-rollback-mechanisms). |
| Tailscale Serve identity and application allowlist | `qualify identity` | `403` for the tagged self-probe with zero `Tailscale-User-*` headers reaching the backend, and `tailscale whois` reporting no user profile; `403` for the workstation's real identity while the allowlist holds a synthetic address; `200` once its login is allowlisted; the forged-header pair denied-then-ignored. |
| Loopback-only exposure | `qualify identity` | `ss` showing only `127.0.0.1:4317`; connection refused to the droplet's tailnet IP on `4317`; connection refused to the droplet's **public** IP on `4317` from the workstation; `tailscale funnel status` showing no funnel. |
| Platform install/doctor/uninstall | `qualify artifact lifecycle uninstall` | `sha256sum --check` result and measured archive digest; `cosign verify-blob` against all three `.sigstore.json` bundles at the exact certificate identity; `gh attestation verify` for all three artifacts at `--source-ref refs/tags/<tag>`; then install/doctor/uninstall executed from that verified archive's CLI. |
| Release signing, SBOM, and provenance (Linux re-verification) | `qualify artifact` | The same three verifications performed on a clean Debian host with freshly downloaded `cosign` and `gh` binaries whose digests are recorded. |
| Linux host lifecycle (init-system scope) | `OMP_QUAL_INIT=openrc qualify host artifact init` | On a host where `/run/systemd/system` is absent and `systemctl` is not on `PATH`: the `install` exit status, its verbatim message, whether a systemd unit / `config.json` / `publisher-token` / staged version directory survives the failure, whether `status`, `doctor`, and `uninstall` then behave intelligibly, and the three asserted safety properties — install refused, no gateway process, nothing answering on `4317`. See [section 10](#10-the-non-systemd-path-alpine-and-openrc). |

Supporting measurements that are not themselves a row: the bundled `UPSTREAM.lock.json` tag and
commit, the `doctor` true/false split with the false checks named, and a literal search of
`doctor --bundle` output for the publisher token and the home path. Compare the printed pin to the
candidate source; never infer currency from a hard-coded version in this guide.

**The sibling lane.** `Configuration migration and rollback` is also measured on macOS by
[`UPGRADE_ROLLBACK.md`](UPGRADE_ROLLBACK.md) and `scripts/qualify-rollback.sh`. That harness has no
user unit, no `enable` state, and no service manager owning the runtime directory, which is why lane
`migration` above exists: the Linux half of the same claim. It also predates the `omp-gateway
rollback` command and installs with `--no-start` throughout, so it never activates anything and never
runs the command — which is why lane `rollback` exists as well. The three are independent, so this
`qualify` can run before or after that one.

## 6. Teardown and cost

One `s-1vcpu-2gb` droplet at **$0.01786 per hour**, about **$0.43 per day**. A full `qualify` run was
roughly twenty minutes including two reboots before lane `rollback` existed; that lane adds up to
seven service restarts and one reinstall, each bounded by its own 30-second listener wait, so budget
a few minutes more. Either way the qualification itself costs well under a cent, and the whole
sequence still fits inside one billed hour. The only way this lane becomes expensive is by being
forgotten, which is why:

- `provision` prints the hourly rate;
- `status` prints hours elapsed and dollars accrued;
- every invocation prints a boxed reminder on exit while the droplet still exists;
- `destroy` prints the final accrued figure before deleting.

```sh
./scripts/provision-linux-qual.sh destroy
```

`destroy` is safe to run at any time, including when nothing exists and when the droplet is
unreachable. It logs the node out of the tailnet, resets the Serve mapping, deletes the tailnet
device record when `TS_API_KEY` is available, deletes the **retained create-response id**, requires
HTTP 204/404 for that DELETE and HTTP 404 for absence, then removes the local state and known-hosts
entries. Parse, transport and other HTTP failures leave state intact and fail teardown; a
`STILL RUNNING AND STILL BILLING` reminder during `destroy` also makes its exit nonzero.
DigitalOcean bills whole hours and does not
refund a partial one, so destroying at minute five still costs one hour.

Provision checkpoints the id in
`${XDG_STATE_HOME:-$HOME/.local/state}/omp-session-gateway-qual/<name>.json` before any readiness
read. It polls that id for active status and a public IPv4 for at most 150 seconds; null or missing
networks are **not absence**. A retained id returning 404 on a later provision invocation is not
permission to create another VM. A matching tag without a retained create id is never adopted or
deleted automatically: inspect the retained create response and account inventory, then use an
explicit owner-authorized id-based cleanup.

Create/list/get/delete response bodies and HTTP statuses survive EXIT in the private
`provider-evidence/` directory beside that state (override with `OMP_QUAL_EVIDENCE_DIR`). The workflow
uploads only this credential-free directory as `droplet-provider-<run>-<attempt>`, including after
failed provisioning or teardown, for 90 days. Authentication uses the existing environment token or
`doctl auth` credential via curl stdin, not argv or evidence; an echoed credential is redacted before
persistence. No request headers, token, cloud-init request body or SSH private key is uploaded.
The API contract is [DigitalOcean's droplet API](https://docs.digitalocean.com/reference/api/reference/droplets/):
202 accepts creation, 200 reads the resource, and 204/404 acknowledges deletion/absence.

If `TS_API_KEY` is not set, `destroy` says so and names the device to remove by hand. Skipping that is
how tailnets accumulate dead nodes across runs.

### Imported images: the second resource class

An imported custom image is billed separately from the droplet, and it is the one that actually leaks.
DigitalOcean charges **$0.06 per GB per month** to store one, free to upload, with no extra charge for
additional regions. The Alpine generic image is about 0.18 GB, so roughly **one cent a month** — but
unlike the droplet it never stops, because nothing in this repository ever deletes it.

**Can this change leak an image? Yes, and deliberately so.** `destroy` does *not* delete a custom
image. Importing takes several minutes, the image is reusable across runs, and deleting it would tax
every subsequent OpenRC run for a fraction of a cent a month. Silence about it, however, is exactly
how one survives for a year, so `destroy` now ends by listing **every** user image in the account —
not only the one `OMP_QUAL_IMAGE` names — with its id, status, size, and monthly cost, and prints the
delete command:

```sh
doctl compute image list-user                 # what is accruing storage right now
doctl compute image delete <image-id> --force # the only thing that stops it
```

Listing all of them rather than the configured one is the point: a leak is visible even when `destroy`
is run months later by someone who never set the knob that created it.

The droplet side of teardown is unchanged. A droplet provisioned with `OMP_QUAL_INIT=openrc` never
joined a tailnet and has no `tailscale` binary, so `destroy` reports the logout as skipped and
tolerates the failed node-id lookup instead of aborting — an unguarded lookup there would have exited
before `droplet delete`, which is the one failure mode teardown must never have.

## 7. Secret handling

- The DigitalOcean token and Tailscale keys are read from the environment. None is printed, written to
  a file in this repository, or placed in argv.
- The Tailscale auth key is **not** in cloud-init user data. User data is readable from the droplet's
  own metadata service and from the DigitalOcean API, so it carries only package installation, the
  qualified user, and the Tailscale installer. The key is streamed over SSH stdin under a fixed argv
  into a mode-0600 file, consumed by bounded `tailscale login --auth-key=file:…`, and removed on
  both paths. `login` is deliberate: a fresh daemon can already hold a machine key while still in
  `NeedsLogin`, and `up` does not force that state through reauthentication.
- The publisher token is never printed. The lifecycle lane reads it only to search the diagnostics
  bundle for it, and reports the byte count and mode rather than the value.
- The service's one-time readiness nonce is redacted where `ExecStart` is printed.
- Every login in this document is a placeholder. `denied-identity@qual.invalid` is in a reserved TLD
  precisely so that nobody can ever authenticate as it, which is what makes it a safe stand-in for a
  well-formed login that is not on the allowlist.

## 8. What this lane does not prove

- **This is a virtual machine, not bare metal.** A DigitalOcean droplet is a KVM guest;
  `systemd-detect-virt` prints `kvm` and the script highlights that line. The accurate term for the
  ledger is "VM", not "bare-metal". Firmware, real disks, real NICs, and physical power loss are all
  still untested.
- **The architecture changed.** The container evidence was aarch64; this is x86_64. The distribution
  is held constant, the architecture is not, so this is not an apples-to-apples container-versus-machine
  comparison. Anything architecture-sensitive is newly covered rather than re-confirmed.
- **No OMP publisher runs here.** No real session discovery, View/Control, generation replacement,
  relay connectivity, or capability-leak evidence comes out of this lane, and `doctor`'s
  `publisherHealth` reflects an empty registry rather than a healthy one.
- **No browser and no Android device.** Nothing here speaks to the PWA, service worker, storage
  sinks, or push.
- **No second user identity.** The tagged node proves "identity absent"; the workstation proves
  "identity present and not on the allowlist" using the operator's own login. A denial by a different
  real person's identity is not produced, and cannot be from a single-account tailnet.
- **`doctor` does not pass every check on the tagged node,** by construction. See the table in
  [section 2](#gap-3--denied-tailscale-identity). A full-pass `doctor` on Linux would require a
  user-owned node, which would in turn make the denial case unavailable.
- **Neither rollback lane proves the crash window is small.** Lane `rollback` induces the one
  reachable divergence between the service definition and `current.json` and measures how the next
  command treats it. It says nothing about how likely that window is, and it does not reach
  `rollback`'s own repair path — the branch that rebuilds the definition from `current.json` when an
  activation fails — because reaching it means breaking a staged runtime, and a deliberately
  corrupted runtime is not evidence about this candidate. See
  [section 11](#11-the-two-rollback-mechanisms).
- **The conservative divergence repair was not performed by the rollback command.** With two
  installed versions no invocation can do it, so the reinstall that `status`'s `DIVERGED` message
  also prescribes is what the lane measures. No third version is manufactured to make the command
  reach it.
- **Persistence is proven for systemd user lingering on this distribution only.** It says nothing
  about the macOS LaunchAgent or the Windows scheduled task, both of which have their own untested
  reboot/login story.
- **The droplet is not a hardened host.** Its SSH port is on the public Internet. The gateway
  listener is measured loopback-only and the public-IP probe is measured refused, but the machine
  itself is a throwaway, not a model deployment.
- **Signature verification proves origin, not fitness.** Checksum, attestation, and Cosign results
  establish that the bytes are the ones the release workflow produced at that tag. They say nothing
  about whether that build passes any behavioural gate.
- **The OpenRC path proves a refusal, not portability.** Lane `init` shows what `install` does on a
  host with no systemd. A clean refusal says the installer fails safe; it says nothing about whether
  the gateway would *work* under OpenRC, and no OpenRC service backend exists. The lane deliberately
  does not start a foreground `serve` to find out, because leaving a daemon on a throwaway box is
  worse than not knowing. What it does establish for free is that Bun's musl build loads and executes
  the archive's CLI, since `install`, `status`, `doctor`, and `uninstall` all run far enough to
  produce messages.
- **The OpenRC droplet contributes nothing to the other rows.** It has no tailnet, so no Serve, no
  identity matrix, and no `doctor` origin probe. It is not rebooted, so it says nothing about
  persistence. Lane `host`'s three systemd fields — `systemd-detect-virt`, `systemctl --version`, and
  the systemd version string — come out blank there, which is expected rather than a fault; lane
  `init` prints the init-system facts instead.
- **Alpine is one non-systemd distribution, chosen because it imports cleanly.** A refusal observed
  there does not enumerate every init system, and the refusal's *wording* is a property of the
  current implementation rather than a contract.

## 9. Unattended runs in CI

[`.github/workflows/droplet-qualification.yml`](../.github/workflows/droplet-qualification.yml) runs
this same script on a hosted runner: `workflow_dispatch` at any time, plus a weekly `schedule` at
11:17 UTC on Mondays. It runs nowhere else. In particular it never runs on `pull_request`, because the
job spends money and a fork's pull request has no access to the secrets below — and because an
arbitrary edit of this script must never execute against these credentials.

Stable qualification supplies an opaque `qualification_id` and the workflow uses it in the run name. The orchestrator persists that identifier before dispatch, then locates exactly one run by run name and orchestrator commit through the Actions API; it does not parse `gh workflow run` stdout. If GitHub accepted the request but the run is not yet discoverable, resume fails closed instead of issuing a second paid workflow. The workflow-wide `droplet-linux-qualification` concurrency group remains serialized with `cancel-in-progress: false`.

Nothing about the workflow changes what the lanes measure. It exists so the Linux evidence stops
depending on somebody remembering to run it, and so a regression like
[#69](https://github.com/alphastorm/omp-session-gateway/issues/69) has a standing chance of being
caught by the `persistence` lane rather than by a release attempt.

The workflow has completed multiple real signed-candidate runs. The exact OMP lane passed against
candidate `.20` in [run `32537603211`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32537603211):
source/tree and full checks, Linux binary build, generation-1 View/Control publication, no-store
launches, immediate revocation, OMP cleanup, gateway uninstall, and droplet/tailnet/key deletion.

### 9.1 Secrets to configure first

All three are repository secrets, set under **Settings → Secrets and variables → Actions**. Each is
passed as `env` on only the steps that need it, never as a command-line argument, and none is ever
echoed. A missing one fails the first preflight step by name instead of failing a lane twenty minutes
into a paid droplet.

| Secret | Created at | Used by | Notes |
|---|---|---|---|
| `DIGITALOCEAN_ACCESS_TOKEN` | DigitalOcean → API → Tokens → Generate New Token, read **and** write scope for droplets | every step that talks to DigitalOcean, including teardown | The preflight calls `doctl account get` so an expired token is named as such rather than surfacing as a droplet fault. |
| `TS_AUTHKEY` | Tailscale admin console → Settings → Keys → Generate auth key | the `provision` step only | Must carry `tag:omp-session-gateway`, be pre-approved if your tailnet requires device approval, and **not** be ephemeral. See [section 3](#3-prerequisites); the reasoning there is unchanged. |
| `TS_API_KEY` | the same Keys page, as an API access token | the teardown step only | Without it `destroy` logs the node out but cannot delete the tailnet machine record, and logged-out records accumulate until Tailscale starts appending `-1`, `-2`, `-3` to the node name. The auth-key preflight also uses it to read the key's expiry. |

`GITHUB_TOKEN` is the automatic per-job token; there is nothing to configure. It is deliberately
exported as `GITHUB_TOKEN` and not as `GH_TOKEN`: `gh` accepts either, but this script forwards
`GH_TOKEN` to the droplet so it can verify attestations online. Leaving `GH_TOKEN` unset selects the
offline `--bundle` path instead, so the bundles are downloaded on the runner and verified on the
droplet and no token ever reaches a throwaway public-Internet box. The workflow fails the lane step if
`GH_TOKEN` is ever set, so that property cannot be lost by a rename.

### 9.2 Rotation

Tailscale caps auth-key lifetime at ninety days, so a weekly schedule outlives every key it is given.
`TS_AUTHKEY` therefore needs rotating at least quarterly, and that rotation has exactly one reminder:
the auth-key preflight prints the expiry date and the days remaining on every run, and emits a
workflow warning at fourteen days or fewer. Treat that warning as the task, not as noise. An expired
key fails the run before a droplet is created.

`TS_API_KEY` expires on the same schedule and is checked implicitly: a `401` or `403` from the key
lookup is reported as an API-token failure, distinct from the auth key being dead.
`DIGITALOCEAN_ACCESS_TOKEN` expires only if it was created with an expiry.

### 9.3 How SSH works there, and why the preflight is untouched

The script refuses to create a droplet it could not then log into: preflight fetches the DigitalOcean
key's fingerprint and requires a matching local private key, because a droplet you cannot reach is
pure cost. A hosted runner starts with neither half, so the workflow mints an RSA keypair in
`$RUNNER_TEMP`, registers the public half with DigitalOcean, and hands the script the two variables it
already reads: `OMP_QUAL_SSH_KEY_ID` and `OMP_QUAL_SSH_IDENTITY`. **The script is unchanged**, and the
preflight still fails closed — a runner that cannot log into the droplet it created still stops before
creating one.

The keypair is RSA rather than ed25519 because the fingerprint DigitalOcean returns for an RSA key is
the legacy MD5 form the preflight compares against, which is the shape this account is observed to
return. The workflow makes that comparison itself, immediately after registering the key and before
any droplet exists, so a change in DigitalOcean's fingerprint format fails with that reason rather
than as "no local private key matches". The DigitalOcean key record is deleted in teardown; it is
named `omp-qual-ci-<run id>-<attempt>` and deleting the record does not touch the droplet's
`authorized_keys`.

### 9.4 Teardown is the point

Teardown is a separate `if: always()` step, so a failed lane, a cancelled run, and an expired
`timeout-minutes` all still run `destroy`. It fails the job when it cannot finish, even if every lane
passed, because the two outcomes are not comparable: a lane failure is information the lead can
re-measure for a cent, while a droplet that outlives its job bills every hour until a human notices.

Three related choices exist for the same reason:

- `concurrency` uses one constant group with `cancel-in-progress: false`. This is load-bearing, not
  hygiene: the droplet name is fixed and two runs have already collided over it in practice, and a
  second run would adopt the first run's droplet, install over its lanes and reboot it underneath
  them. Cancelling is worse than queueing, because a cancelled run may not reach teardown.
- `timeout-minutes: 50`. A full sequence is about twenty-five minutes and the script's own bounded
  waits keep a slow-but-legitimate run under forty. Fifty keeps the whole job inside a single billed
  DigitalOcean hour, so a hung step costs one hour rather than accruing indefinitely.
- The workflow **refuses to adopt** an existing `omp-gateway-qual` droplet, and teardown destroys a
  droplet only when this job's `provision` step ran. A successful run always destroys its own droplet,
  so a pre-existing one is either a leak from an earlier run or a run the lead is driving by hand, and
  neither may be stomped by CI.

Ways a droplet can still be leaked, none of which the workflow can eliminate:

- the runner or GitHub itself dying mid-job, which skips every remaining step including teardown;
- a cancellation whose grace period ends before `destroy` finishes;
- `destroy` failing against a DigitalOcean API that is down, which fails the job loudly but leaves the
  droplet;
- the schedule silently stopping. GitHub disables scheduled workflows in repositories with sixty days
  of no activity, so an unattended lane can stop running without any failure to notice.

In every case the next run refuses to start and says why, and the recovery is the same:
`./scripts/provision-linux-qual.sh destroy` from an authenticated workstation. A leaked droplet is
also findable as `doctl compute droplet list --tag-name omp-gateway-qual`.

One more property worth stating, because a scheduled job is exactly the shape that breaks it: this
workflow only ever touches things it created. It installs the gateway on its own droplet and probes
that droplet, and it never reads a session, relay room, or gateway from any published list. That
matters because a run that picks up a live session label on a timer will eventually fire probes into
something a human is using — which is how the relay soak was lost once already, to an acceptance run
that reused a session it did not own. Nothing here has a path to the production daemon on
`127.0.0.1:4317`, to the soak, or to any OMP process.

### 9.5 Which lanes run, and what CI cannot measure

A scheduled run uses the script's full default order. The droplet-hour is the entire cost and the whole
sequence fits inside it, so running a subset saves nothing; and the lanes that justify provisioning a
machine at all only exist in the full set — `persistence`, which reboots twice and is what caught #69,
and `identity`, the only place a denied Tailscale identity is observable. The `lanes` dispatch input
exists for re-observing one lane after a fix. Because every CI run starts on a fresh droplet, a subset
must be self-sufficient: anything after `lifecycle` needs `artifact lifecycle` in front of it, and the
preflight refuses a subset that does not, before a droplet is created.

Two lanes are weaker on a runner than on a workstation, by construction:

- **`identity` loses its allowed half.** Lane 4a is unaffected: the tagged droplet's self-probe still
  measures the denial, with `tailscale whois` printed beside it. Lane 4b needs a *user-owned* tailnet
  node, which a hosted runner is not, so `OMP_QUAL_ALLOWED_LOGIN` is left unset and the script prints
  that the allowed half was not exercised. The `200`, the `no-store` check, and the forged-header pair
  come only from a workstation run.
- **The public-IP probe is better from CI, not worse.** A GitHub runner is a genuine public-Internet
  host, so "connection refused to the droplet's public IP on `4317`" is measured from one.

`migration` needs `OMP_QUAL_PREVIOUS_TAG` to name a published release, and `rollback` needs
`migration` to have run in front of it; see [section 4](#4-running-the-lane) for the ordering rule a
pre-#69 predecessor unit imposes. Both tags are inputs with explicit defaults rather than a lookup of
the newest release: a scheduled run must qualify a decided candidate, and silently following the
newest tag would change what the evidence is about without anybody choosing that. The preflight
checks that both tags exist and carry all six expected assets before provisioning.

### 9.6 Reading a failure

Failures are ordered so that the cheap ones happen first. Everything up to and including the SSH-key
step runs before any droplet exists, and every message from those steps says so.

| What you see | What it means |
|---|---|
| `::error title=Missing secret: …` | That repository secret is not configured. Nothing was created. |
| `::error title=DigitalOcean token rejected` | `DIGITALOCEAN_ACCESS_TOKEN` is revoked, expired, or lacks write scope. |
| `::error title=Tailscale auth key is expired or revoked` or `… expired on <date>` | The first of the two likely scheduled failures. Generate a replacement carrying `tag:omp-session-gateway`, pre-approved and not ephemeral, and update `TS_AUTHKEY`. |
| `::error title=Tailscale API token rejected` | `TS_API_KEY`, not the auth key. Teardown would also be unable to delete the machine record. |
| `::error title=Candidate tag <tag> not found` or `… is missing <asset>` | The second likely scheduled failure. The tag was deleted or its assets were renamed; `OMP_QUAL_VERSION` overrides the name derivation if `package.json` has moved on. |
| `::warning title=Auth key does not carry tag:…` | The droplet will join untagged and the `identity` lane will skip. Every other lane is unaffected. |
| `::error title=Droplet omp-gateway-qual already exists` | A leak from an earlier run or a live workstation run. CI will not touch it; destroy it by hand or wait. |
| `::error title=SSH key fingerprint mismatch` | DigitalOcean returned a fingerprint the script's preflight would not match. No droplet was created. |
| A lane failure with the droplet destroyed afterwards | Normal. Read the measurements in the log; the lanes print numbers, not verdicts. |
| `::error title=Teardown failed` | The serious one. Treat it as an unclosed billing risk, not a test failure. |

A lane failure and a teardown failure look identical in the run list, so check the job summary: it
records one line saying whether the droplet was destroyed, skipped, or possibly still billing.

## 10. The non-systemd path: Alpine and OpenRC

### 10.1 Why this exists and what a pass means

`apps/gateway/src/service.ts` builds a systemd **user unit** for every `linux` platform and then drives
`systemctl --user daemon-reload`, `enable`, and `start`. Nothing on that path inspects the init system.
So the Linux implementation is systemd-only, and whether that is acceptable for alpha is a decision
nobody has evidence for. The cheapest input to that decision is to run the existing lane against a
non-systemd distribution and read the failure.

**The expected result of this lane is a refused install.** That is not a caveat, it is the deliverable.
"Cannot succeed" has three very different shapes and only one of them is safe:

| Shape | What it means for the ledger |
|---|---|
| Non-zero exit, no process, no listener, an intelligible message | The installer fails closed on an unsupported init system. The Linux row's scope is bounded by observation, not by assumption. |
| Non-zero exit but a daemon, a listener, or a half-written install left behind | A real defect: an operator on such a host is left with state they did not ask for and cannot manage. |
| Zero exit | The worst answer. A systemd unit was written on a machine that will never read it, and `status` would be reporting on something that cannot run. |

Lane `init` therefore asserts exactly three things, each a safety property rather than a message:
**install refused**, **no gateway process survives**, **nothing answers on the gateway port**. The
curl exit status is what decides the third, not its `%{http_code}` output, because `-w` still prints
`000` on a refused connection.

Everything else is measured and printed rather than asserted, because those measurements *are* the
findings and predicting them would hide a surprise: the verbatim install output; whether the systemd
unit file, `config.json`, `publisher-token`, a staged version directory, or `installation/current.json`
outlive the failure; and what `status`, `doctor`, and `uninstall` then print.

**No OpenRC backend is implemented and none is implied.** This lane passing means the refusal is
clean. It does not mean OpenRC is supported, and nothing here papers over the refusal or retries past
it.

### 10.2 Importing the Alpine image

**This is a procedure, not something the script runs.** `provision-linux-qual.sh` never creates,
deletes, or mutates an image; it only reads one. Run these three steps by hand once, then pass the
id.

Alpine publishes generic cloud images with cloud-init pre-installed, which is DigitalOcean's hard
requirement for a custom image. Take the **`bios`** variant, not `uefi`: DigitalOcean does not support
UEFI boot for custom images. Take the **`generic_`** prefix, not `aws_`, and the `.qcow2` rather than
the `.vhd`.

```sh
# 1. Import. --region is required and is where the image will live.
#    The hosting server must answer HEAD requests; dl-cdn.alpinelinux.org does.
doctl compute image create omp-qual-alpine \
  --region sfo3 \
  --image-distribution Alpine \
  --image-description "omp-session-gateway non-systemd qualification" \
  --image-url "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/cloud/generic_alpine-3.24.1-x86_64-bios-cloudinit-r0.qcow2" \
  --output json

# 2. Wait for it. An import is asynchronous and takes several minutes; `status` moves
#    NEW -> available. Poll until it reads available, and record the id.
doctl compute image list-user --output json |
  jq -r '.[] | select(.name == "omp-qual-alpine") | "\(.id) \(.status) \(.regions | join(","))"'

# 3. Pass it. A numeric OMP_QUAL_IMAGE is treated as a custom image id.
export OMP_QUAL_IMAGE=<image-id>
export OMP_QUAL_INIT=openrc
export OMP_QUAL_RELEASE_TAG=<a published signed candidate tag>
./scripts/provision-linux-qual.sh provision
./scripts/provision-linux-qual.sh qualify        # defaults to: host artifact init
./scripts/provision-linux-qual.sh destroy
```

Check the current filename before copying the URL above: Alpine's `latest-stable` branch moves, and
the `r0` suffix is a rebuild counter.

```sh
curl -sS https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/cloud/ |
  grep -o 'generic_alpine-[0-9.]*-x86_64-bios-cloudinit-r[0-9]*\.qcow2' | sort -u
```

Pick the newest by eye rather than with `sort | tail`: a two-digit patch release sorts before a
one-digit one lexicographically, and `sort -V` is not portable to the BSD `sort` on macOS.

Constraints worth knowing before spending the minutes:

- **Custom images are region-scoped.** The image exists in the region you imported it into. Passing an
  id whose regions do not include `OMP_QUAL_REGION` fails in preflight, by name, before a droplet is
  created. Adding regions afterwards is free and is done in the control panel.
- **Unix-like only. DigitalOcean does not support Windows images at all**, custom or otherwise, so
  this path can never extend to Windows coverage. Windows qualification stays on hosted runners.
- **Requirements the image must meet:** cloud-init (or an equivalent), an `ext3`/`ext4` root, BIOS
  boot, one of raw/qcow2/vhdx/vdi/vmdk, and 100 GB or less uncompressed. Alpine's
  `generic_…-bios-cloudinit-…qcow2` satisfies all of them, which is why it is the image named here.
- **Cost and teardown:** see [section 6](#imported-images-the-second-resource-class). The image bills
  at $0.06 per GB per month until *you* delete it; `destroy` never does, and lists every user image so
  the omission is visible.

### 10.3 What `OMP_QUAL_INIT=openrc` changes

Nothing when it is unset. When it is set to `openrc`:

| Behaviour | systemd (default) | openrc |
|---|---|---|
| Image validated against | `doctl compute image list-distribution` by slug | `doctl compute image get` by id, for existence, `available`, and this region |
| cloud-config packages | `ca-certificates curl jq unzip iproute2 procps` | adds `bash`, `coreutils`, `grep`, `libstdc++`; drops `procps` |
| Qualified user's login shell | `/bin/bash` | `/bin/ash` — cloud-init creates users before it installs packages, so naming a shell that is not installed yet leaves the account unusable in between. `remote()` asks for `bash` explicitly, so the login shell need not be it. |
| `disable_root` | image default | stated `false`, because the lane logs in as root to measure and an imported image's `cloud.cfg` is not ours to trust |
| `TS_AUTHKEY` | required in preflight | not required, and not requested |
| Tailscale | installed, joined, tagged, `--operator` granted | none. Serve only serves lanes that need a running gateway, and installing `tailscaled` would mean writing an OpenRC service — precisely the thing this lane must not quietly do |
| `loginctl enable-linger` | applied | not applicable |
| Provision's last check | tailnet DNS name, tags, node id | distribution, kernel, pid 1, `/run/systemd/system`, `systemctl`, `rc-service`, `bash`; **fails if systemd is present**, because a systemd box cannot answer the question it was paid for |
| Default lanes | `host artifact lifecycle migration rollback identity persistence uninstall` | `host artifact init` |
| `lifecycle`, `migration`, `rollback`, `identity`, `persistence`, `uninstall` | run | refused by name in preflight, before the droplet is contacted |

Lane `init` needs `artifact` to have run first — it executes the extracted archive's CLI, not a
development checkout — and says so rather than failing obscurely if it has not. Run on a systemd host
it prints the init facts, states that there is no refusal to observe, points at lane `lifecycle`, and
returns success without touching the install.

### 10.4 Which ledger row this bears on

**`Linux host lifecycle`**, currently **PARTIAL**, and secondarily
**`Platform install/doctor/uninstall`**. Neither is promoted here and this lane cannot promote either:
a refusal is not a lifecycle pass.

What a clean refusal would let the ledger say, once run, is narrower and more useful than a pass:

- that the Linux row's systemd scope is **established by measurement** rather than left implicit — the
  existing evidence happens to be Debian/systemd, and until now nothing showed what the other case
  does;
- that the installer **fails closed** on an unsupported init system, leaving no process, no listener,
  and (as measured) whatever residue it actually leaves — which is a security-relevant property, not
  just a usability one;
- that "non-systemd Linux" can be stated as explicitly out of scope with an observation behind it,
  which is a `COMPATIBILITY.md` change for the lead, not a ledger promotion.

A **failing** run is the more valuable outcome: it would mean an unsupported host is left holding a
token, a staged runtime, or a listener, and that is a defect to file rather than a scope note to write.

## 11. The two rollback mechanisms

**This lane has not been executed yet.** It was validated statically — `bash -n`, `shellcheck` with
zero findings, every remote heredoc extracted and parsed on its own, and its pure-shell helpers
unit-tested against known inputs — and no part of it has run against a droplet. Nothing below is a
measurement; it is what the lane will measure. The first real run is the lead's.

### 11.1 Why there are two

There is no single rollback implementation. There are two, and they share almost nothing:

| | Rollback by reinstall | The `rollback` command |
|---|---|---|
| How | `omp-gateway install` from the predecessor's archive again | `omp-gateway rollback [--to <version-directory>]` |
| Chooses its target by | whatever archive the operator points at | reading `installation/history.json`, or `--to` |
| Refuses when | the prior runtime cannot be verified | the history names no predecessor, `--to` is malformed, names the active version, or names a version that is not installed |
| Stages a payload | yes, a fresh one | no, it activates a runtime already on disk |
| Repairs a diverged definition | by rewriting it for the payload it just staged | by rebuilding it from `current.json` when its own activation fails |
| Linux lane | `migration` | `rollback` |
| macOS harness | `scripts/qualify-rollback.sh` | not covered: the command postdates it |

Lane `migration` drives the left column only — all three of its steps are installs — and it passes
11/11 against `v0.1.0-prealpha.17` on a Debian 13 droplet. It never invokes the command, so nothing
in the right column was covered on any platform before lane `rollback` existed. Do not read either
lane as evidence for the other, and do not read the macOS harness as evidence for the command.

### 11.2 The two-artifact prerequisite

Both artifacts are the ones lane `migration` already downloaded, verified, and extracted:
`~/runtime-prev` from `OMP_QUAL_PREVIOUS_TAG` and `~/runtime-root` from `OMP_QUAL_RELEASE_TAG`. Lane
`rollback` downloads nothing and stages nothing; it reads those two roots and the install `migration`
left behind. It therefore needs `artifact lifecycle migration` in front of it, has no environment
knob of its own, and fails closed by name — not obscurely — when any of that is missing.

Two properties of the artifacts decide what the lane can observe, and both are consequences of
[#78](https://github.com/alphastorm/omp-session-gateway/pull/78) rather than of tag ordering:

- **The candidate must carry the command.** The lane greps the candidate's own `cli.js` for the
  rollback target resolver and refuses when it is absent, because a candidate that predates #78 gives
  it nothing to exercise. `v0.1.0-prealpha.17` is the first release that carries it.
- **The predecessor decides whether a bare `rollback` can resolve anything at first.**
  `history.json` is written only by the CLI performing an activation, so a predecessor older than #78
  records nothing. Installing `.13` then `.17` then `.13` — what `migration` does — leaves a history
  naming only `.17`'s staged directory, and a bare `rollback` from `.13` then correctly refuses:
  *"refusing to guess a rollback target: no activation of the active version … is recorded"*. The
  lane asserts that refusal rather than stepping around it, then seeds the history with two explicit
  `rollback --to` invocations, which the candidate's CLI does record, and only then exercises the bare
  form. It works the same way if both artifacts carry #78; the refusal step simply becomes an asserted
  success instead.

Which staged directory belongs to which archive is decided by digest, never by `current.json` and
never by the history: the installer copies a `.js` CLI into the staged runtime verbatim in both
artifacts, so a staged version directory whose `apps/gateway/src/cli.js` matches an archive's byte for
byte was staged from that archive. Every "it went back to the predecessor" claim is anchored to that,
so none of them can be satisfied by a pointer that merely changed.

### 11.3 Invoking it

```sh
export OMP_QUAL_RELEASE_TAG=v0.1.0-prealpha.17   # the candidate; must carry PR #78
export OMP_QUAL_PREVIOUS_TAG=v0.1.0-prealpha.13  # the only other published release

./scripts/provision-linux-qual.sh qualify artifact lifecycle migration rollback
```

On a droplet that has already run `artifact lifecycle migration` in an earlier invocation,
`./scripts/provision-linux-qual.sh qualify rollback` is enough. The lane is also in the default order,
between `migration` and `identity`.

### 11.4 What it proves

Every row below is asserted, prints the value it observed, and fails the lane when it does not hold.

1. **The refusal.** A bare `rollback` with no recorded predecessor exits non-zero, names no target,
   and changes nothing — not the pointer, not the service definition, not the daemon, not the
   history. Its message is compared against the one `apps/gateway/src/installation.ts` documents, so
   a drift between the command and its own docstring shows up as a failing row rather than being
   absorbed.
2. **`--to <version-directory>`,** three times, reporting selection `requested`.
3. **The bare form,** twice, reporting selection `recorded-predecessor` and landing on the
   predecessor the lane computes independently from `history.json` — which also demonstrates the
   documented oscillation between two versions.
4. **Around every one of those:** `current.json` names the target; the unit *file* and the *loaded*
   unit both name it, so the definition was rewritten and `daemon-reload` really happened; the
   `ExecStart` path is absolute and under that version directory; the daemon's main PID changes; the
   loopback listener is bound again and is loopback-only; `config.json` and the publisher token are
   byte-identical to their pre-lane digests and the token keeps mode `600`; `history.json` gains one
   activation equal to the new pointer — or none, when the history already ended with that version,
   which is the documented idempotence — and its nanosecond mtime is at or after `current.json`'s, so
   the append followed the pointer commit; and `status` reports
   `installed/active/ready` with `diverged: false`.
5. **The induced divergence.** `install` and `rollback` both write the service definition first and
   advance `current.json` only after the new runtime proves loopback readiness, so exactly one
   divergence direction is reachable: a crash between those two writes leaves the definition naming a
   *newer* version than the pointer. The lane reproduces that state by hand, including the restart a
   real crash would already have completed, and then asserts that `status` reports `diverged: true`
   with `activeVersion` at the pointer and `serviceVersion` at the definition, exits non-zero, and
   prints `DIVERGED`; that `rollback --to` the pointer's own version is refused; and that the repair
   returns the service to the older proven version, adopting the newer one neither in the pointer nor
   in the definition, and recording no new activation.
6. **The exit state.** The lane finishes by putting the candidate back with a third `--to`, and
   asserts the unit it leaves behind carries `RuntimeDirectory=`. Later lanes measure the candidate,
   and `persistence` reboots; a predecessor unit predating the #69 fix would fail that reboot for
   reasons that are #69 and not rollback.

### 11.5 What it does not prove

- **The command did not perform the conservative divergence repair.** With two installed versions no
  invocation can: `--to` the pointer's own version is refused, and every other target adopts a
  version the pointer never proved. The repair the lane measures is the reinstall that `status`'s
  `DIVERGED` message also prescribes, and the lane says so in its own output. No third version is
  manufactured to make the command reach it, because that would be testing a state the product
  cannot be in.
- **`rollback`'s own repair branch is not reached.** The `catch` that rebuilds the definition from
  `current.json` runs only when a rollback's activation fails, which means breaking a staged runtime.
  A deliberately corrupted runtime is not evidence about this candidate.
- **The opposite divergence direction is not induced,** because no command produces it: neither
  `install` nor `rollback` writes `current.json` before the service definition.
- **The crash window is not measured,** only the state a crash inside it leaves and how the next
  command treats that state.
- **History ordering is shown by mtime,** which orders two writes and says nothing about atomicity.
  Those two writes are documented as *not* atomic.
- **Nothing here is isolated from a production daemon,** and it does not need to be: the droplet has
  one user, one service, and no live daemon to protect. The macOS harness's host-daemon and
  host-plist invariants have no analogue and are not simulated.
- **Five of lane 4's rows are not re-asserted here** — predecessor install names a version, the
  active version changes on the forward upgrade, the predecessor directory survives it, the unit
  stays `enabled`, and a reinstall preserves config and token. They belong to the reinstall path,
  lane `migration` already establishes them, and two overlapping sources of truth for one claim are
  worse than one. The lane prints them where they are cheap to read.

### 11.6 One thing to check before recording numbers

The `lanes` dispatch input in
[`droplet-qualification.yml`](../.github/workflows/droplet-qualification.yml) validates lane names
against a fixed list that does not yet include `rollback`, so an explicit CI subset naming it fails
preflight. An empty `lanes` input runs the script's full default order and therefore picks the lane up
already. That file is the lead's.

## 12. Related documents

- [`RELEASE_STATUS.md`](RELEASE_STATUS.md) — the ledger; the only place a row's status changes.
- [`TEST_PLAN.md`](TEST_PLAN.md) — §4.E authorization and §4.F persistence scenarios this lane feeds.
- [`SECURITY.md`](SECURITY.md) — §4 network exposure, §8 tailnet authorization, §13 acceptance gates.
- [`RELEASE.md`](RELEASE.md) — the canonical artifact verification commands this lane runs remotely.
- [`OPERATIONS.md`](OPERATIONS.md) — install, Serve, paths, and `doctor` semantics.
- [`UPGRADE_ROLLBACK.md`](UPGRADE_ROLLBACK.md) — the macOS harness for forward upgrade and
  rollback-by-reinstall. It predates the `omp-gateway rollback` command and never runs it; see
  [section 11](#11-the-two-rollback-mechanisms) for why that leaves a second lane to run.
- [`COMPATIBILITY.md`](COMPATIBILITY.md) — where a "non-systemd Linux is out of scope" statement would
  belong once [section 10](#10-the-non-systemd-path-alpine-and-openrc) has been run. Owned by the lead.
- [`.github/workflows/droplet-qualification.yml`](../.github/workflows/droplet-qualification.yml) —
  the scheduled unattended runner for this lane; see [section 9](#9-unattended-runs-in-ci).
