# Windows qualification

This runbook is for maintainers running Windows release qualification and reviewing the Windows host
test lanes. For normal Windows installation, follow the
[operations guide](OPERATIONS.md#2-cli-and-daemon-installation). Windows x86-64 build 26100 (Server
2025) at interactive logon — from an Administrator or a standard account — is qualified in the
current stable release (`v0.7.4`); see [Compatibility](COMPATIBILITY.md) and
[Release status](RELEASE_STATUS.md).

## Mainline Windows: tested evidence and the remaining delta — 2026-09-24

Stock OMP `>= 18.1.20` is the current prerequisite; [PR #11908](https://github.com/can1357/oh-my-pi/pull/11908), merge `4999b98bd5`, ships in [OMP v18.1.20](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.20). Configure only
`collab.autoStart` and use plain `omp`.

Three hosted `windows-latest` lanes now exercise the mainline Windows host path:

| Lane | Runs | What it exercises |
|---|---|---|
| `portable-source (windows-latest)` | every change | repository scan, typecheck, web build, 47 of 52 test files, both leak scans; `scripts/test-portable.ts` names the five host-bound exclusions and why |
| `windows-service-lifecycle` | every change | gateway install as a current-user scheduled task, readiness, another local user denied the readiness token, rotation, port-changing reinstall, no-stop refusal, uninstall; then, as a standard local user without `SeSecurityPrivilege`, install and reinstall with `--no-start`, status, the registered task's command started as that user until ready, and uninstall (#293, #294) |
| `canary-windows` (upstream canary) | daily against latest stock OMP, and on canary or reader changes | stock OMP starts in its own hidden console and publishes its named pipe; the unchanged `OmpHostReader` reads the discovery entry, queries a snapshot, refuses a stale generation, and releases View and Control; both join through the default relay and Control's prompt echoes; the host tree is ended and its pipe observed gone |

The Windows canary passed all six stages against stock OMP 18.3.0 in discovery runs
[36012005712](https://github.com/alphastorm/omp-session-gateway/actions/runs/36012005712) and
[36014286823](https://github.com/alphastorm/omp-session-gateway/actions/runs/36014286823). One
later run, [36015033822](https://github.com/alphastorm/omp-session-gateway/actions/runs/36015033822),
failed at `publish`: OMP's first command in the fresh profile, which also unpacks its native addon,
outlasted the canary's 10-second command bound. OMP commands now get a 60-second bound, with no
retry. With that bound, the pull request's `canary-windows` runs passed all six stages against the
latest stock OMP (18.3.0), for example [36016871476](https://github.com/alphastorm/omp-session-gateway/actions/runs/36016871476).

The published v0.5.3 archive also installed on `windows-latest` with the PowerShell commands in
[OPERATIONS.md](OPERATIONS.md#2-cli-and-daemon-installation) and [RELEASE.md](RELEASE.md#verify-a-published-build),
run exactly as written, in discovery run
[36018098085](https://github.com/alphastorm/omp-session-gateway/actions/runs/36018098085). The
checksum check printed `True`, `install` reported loopback health ready, and `status` showed
installed, active, ready, and not diverged. `uninstall` then preserved configuration and the
readiness token. That was a one-time rehearsal of the published bytes, not a standing lane.

**What this closes.** Before these lanes, the gateway had never queried a real stock OMP over the
named pipe OMP publishes on Windows; hosted CI covered only the gateway's own service lifecycle.

**Why hosted CI does not replace the signed-artifact Windows lane (automated from v0.6.0 below).**
Qualifying a release requires an exact signed gateway candidate and mainline OMP binary through
install, reboot with no pre-login listener, interactive login and automatic start, `doctor`,
rotation, upgrade, rollback, and uninstall, with TUN-mode Tailscale Serve and a physical client.
Hosted runners cannot reboot into a login session, so the automated signed-artifact lane below runs
on a disposable Server 2025 VM for each stable release. Windows starts the gateway at interactive
logon (`LogonTrigger`), not at unattended boot.

## Automated signed-artifact lane

`scripts/windows-stable-qualification.ts` exports `preflightWindows`, `runWindows`,
`windowsNeedsCleanup`, and `cleanupWindows`. The stable orchestrator supplies the exact verified
candidate and predecessor archive paths, the OMP lock identity, whole-object checkpointing, and
the exclusive Pixel lease. This module never downloads substitute gateway bytes during a stable
run and cannot mark a stable receipt passed on its own.

The controller is the operator's Mac with Bun 1.4.0, FreeRDP 3.32.2 (`sdl-freerdp`), and pywinrm
0.5.0 in `~/.local/share/omp-session-gateway/qualification/venv`. Keep the Vultr credential in
the private `~/.vultr-apikey` file and the tagged Tailscale join credential and API
credential in the existing private qualification files. Preflight checks current egress, provider
image/plan availability, existing resources, tools, the attached device, and archive digests.
All pre-existing instance and firewall IDs become protected for the attempt. A Vultr API access
control rejection requires authorizing the operator's current `/32`; never broaden it to all IPs.
The stable campaign (or explicit development `run`) is provisioning authority; there is no
second environment-variable gate. The creation cap, positive ownership label and protected
inventory snapshot remain mandatory. Tailscale inventory and cleanup use `tailnet/-`, binding
every query to the API credential's own tailnet rather than a hard-coded account identifier.

The development commands are:

```sh
export PATH="$HOME/.local/lib/omp-session-gateway/bun/v1.4.0:$PATH"
bun scripts/windows-stable-qualification.ts preflight
bun scripts/windows-stable-qualification.ts artifacts --tag vX.Y.Z-prealpha.N
bun scripts/windows-stable-qualification.ts run --tag vX.Y.Z-prealpha.N
# Also safe after an interrupted controller; recovers ownership from the checkpoint epoch.
bun scripts/windows-stable-qualification.ts cleanup
```

`artifacts` and `run` take the campaign's candidate tag and pair it with the published stable
predecessor, both through the campaign's own argument parsing and release verification: signed
tag, exact asset set, GitHub release state, checksums, GitHub attestations, and Sigstore bundles.
A development run therefore installs exactly the pre-release bytes a campaign would; the earlier
stable-only pair never exercised a pre-release tag, which hid a version-derivation defect until a
paid campaign. A retained attempt resumes only for the tag it recorded. Development
state is private under `~/.local/share/omp-session-gateway/qualification/dev/windows/`; it is
**tested evidence only**, never candidate qualification. The separate epoch vault has a `0700`
parent and `0600` files. It is the only persisted location for guest access credentials and
infrastructure identifiers, and is removed only after instance destruction.

The lane creates one firewall and one Server 2025 Standard VM (`ewr`, `vc2-4c-8gb`: 4 vCPU,
8 GiB). Through v0.7.0-prealpha.1 it used `vc2-2c-4gb`, where building stock OMP 18.4.2 from
source peaks near 2.4 GiB of Bun private memory beside Windows itself; that build failed
(`omp-build exit 1`) in two of the three stable attempts that reached it, as the Debian lane's OMP
build was once killed on a 4 GiB host before it moved to 8 GiB. Vultr refused this Windows image
on the High Performance `vhp-4c-8gb-amd` plan (HTTP 400). The VM's size is test-host capacity,
not part of the qualified Windows claim. The firewall
admits TCP 3389 and 5985 from the current operator `/32` only. WinRM uses authenticated NTLM with
message encryption required and rejects `AllowUnencrypted`. Scripts and file payloads travel
through framed stdin, not remote argv or environment. The active RDP certificate's SHA-256 is
read over WinRM and explicitly pinned; RDP reads its password from stdin. No ignore/TOFU mode is
used. The tagged Tailscale join uses a private guest file consumed via `--auth-key=file:...` and
removed in `finally`. TUN-mode Serve targets loopback, with Funnel disabled.
Windows uses `tailscale up --unattended=true` for machine-wide connectivity; authenticating
with `login` alone did not establish the persistent backend in the development run.
The guest does not rely on the provider's resolver: before its first download, toolchain staging
sets every up adapter to `1.1.1.1` and `8.8.8.8`, clears the DNS cache, and proves `github.com`,
`pkgs.tailscale.com`, `registry.npmjs.org` and `login.tailscale.com` resolve, failing as
`name resolution failed: <host>` otherwise. On 2026-10-02 the Vultr-assigned resolver answered
SERVFAIL for the Tailscale names and their CloudFront target while `github.com` resolved, which
failed two v0.7.2 campaign attempts with a bare `WebException` at the Tailscale MSI download.
Allocation and authenticated WinRM admission share one 12-minute deadline. Admission requires
three consecutive read-only successes spanning at least 60 seconds; a transport error resets
both the count and window, while a guest assertion failure aborts immediately. The observed
`transportStabilitySamples` and `transportStabilityDurationMs` are receipt facts. Mutations are
not retried by this readiness boundary.

Each authenticated probe has at most **180 seconds**, capped by the remaining combined deadline,
to accommodate a fresh instance's first WinRM exchange. The controller sends SIGTERM at that bound;
the helper independently attempts command cleanup and shell closure before exiting. If it does not
exit within five seconds, the controller sends SIGKILL, awaits exit, and drains both pipes before
reporting failure. A subprocess deadline remains a failed probe, not a successful observation or an
automatic mutation retry.

### Transport recovery and failure evidence

The helper reports a closed failure kind (`transport`, `guest`, or `helper`), stage
(`connection`, `command`, `output`, or `upload`), recognized condition, HTTP status when present,
and command disposition. Exception types and status fields supply classification; diagnostic
messages never do. Controller-authored product assertions remain `product`. Invalid credentials,
encoding/import failures, malformed guest JSON, arbitrary guest failures, and unexplained process
exit 143 remain `harness`. A recognized connection/reset/read timeout or retryable HTTP status
during a declared read-only operation is `infra_transient`. Only a controller-owned deadline
while its read-only connection probe is pending produces `probe_deadline`; external cancellation
cannot acquire that classification. These are lane failure records, not campaign retry authority.

After the unchanged initial authenticated stability window, read-only operations share a reconnect
helper with delays of **2, 4, 8, and 16 seconds**, at most five calls, inside a **90-second**
operational budget that includes time already spent executing probes. Process teardown remains
mandatory on expiry. Cleanup uses this reconnect path, never another 12-minute allocation window.
Mutating guest actions and upload streams are never replayed.

An interrupted upload is reconciled by existence and SHA-256 after read-only connection recovery.
The inspector must exclusively open the file, proving that its writer no longer owns it, before
hashing or permitting removal. Complete matching bytes are reused; a partial file is removed only
after that proof, and the failed upload remains terminal rather than starting another stream.
Unknown writer disposition, authentication, or helper faults do not become successful recovery.
Private helper diagnostics retain only the existing redacted, source-free exception context;
typed failures contain closed codes and numeric/boolean observations, not that diagnostic text.

Read-only admission also reports remaining per-tag creation allowance. Provider quota metadata is
explicitly marked unobservable; admission neither assumes unlimited capacity nor allocates a probe VM.

The Windows progress and completed result retain `transportProbes`: one metadata-only row per
authenticated probe, checkpointed at invocation start, first authenticated response, controller
SIGTERM (if sent), and process exit. `startedAt`, `signalAt`, and `exitedAt` are UTC epoch
milliseconds; `timeoutMs` records the applied bound and `exitCode` the subprocess outcome.
New observations may additionally record `controllerDeadline` and the SIGKILL timestamp `killAt`.
`firstResponseLatencyMs` measures from invocation start to the helper's first authenticated
`open_shell` reply, not completion of the guest command or shell teardown. Unobserved events are
`null`, so a timeout during teardown differs from no observed authenticated reply. Only the helper's
fixed timestamp marker is consumed; no host, credential, argv, script, stdout or stderr is copied
into these rows. Failed checkpoints refuse qualification. Historical immutable progress without
this additive diagnostic field remains cleanable and is not rewritten to invent probe observations.

An initial pinned RDP logon establishes the interactive session required by installation; the
client then disconnects. The sequence is predecessor install → candidate upgrade with private-state digests unchanged →
doctor → reboot → at least three pre-login samples over at least 30 seconds → pinned RDP login
and automatic gateway LogonTrigger startup → doctor → stock OMP named-pipe discovery and
View/Control/stale-generation launch checks → ordinary Chrome on the physical Pixel under the
shared lease → owned OMP-tree stop and revocation → readiness rotation → history-selected
rollback → candidate restoration → uninstall with private state preserved. The gateway's task
is never manually started after reboot. An independently named, epoch-owned interactive task
launches only the OMP fixture; it avoids WinRS destroying that console when its management shell
disconnects. Measurement uses ordinary Chrome, without installing or replacing the Android
WebAPK. Foreground activity, its owning launcher package, display and keyguard baseline are
captured privately and restored before the Pixel lease is released. Restoration uses the
existing app's launcher intent, not a non-exported Chrome activity; cleanup closes this epoch's
ordinary Chrome pages and restores that baseline after a crash. A failed restore carries
`pixelUnrestored: true` to fence the production lease. Development retains its exact-epoch lock
until cleanup proves restoration; another lane's lock is never broken.

**Post-mutation status.** `install`, `rollback` and `rotate-readiness-token` return once the gateway
proves readiness, but on this two-vCPU guest one immediate `status` read has still failed after them
and the next read passed with nothing reinstalled (the 2026-09-24 predecessor install, the
2026-09-29 candidate upgrade). Each read-only status predicate that follows a mutation therefore
reads for up to 60 seconds, the product's own Windows readiness budget, before failing; the mutation
is never repeated, and the controller logs every read past the first. A status that never settles
fails as `status mismatch: <fields>`, naming only the predicate's fields. That and a native command's
name and exit code are the only guest error text the WinRM adapter forwards.

**Standard-user fresh install.** The same VM then proves the non-elevated path (#293, #294).
After the Administrator's uninstall the lane creates `ompstd` plus the epoch's first eight hex
digits: a local account in Remote Desktop Users, never Administrators, whose controller-generated
password lives only in the epoch vault and reaches the guest only as encrypted WinRM input. It
gets read and execute on the staged Bun, the candidate and the pinned OMP build (doctor probes
`omp --version`), and on the WinRM listener's descriptor, because the WinRS shell the adapter
uses is outside Remote Management Users. Nothing else in the staging root is readable to it. Only
an administrator can read the listener's configuration, so the Administrator's calls, not the
account's, verify on every call that unencrypted WinRM stays off. WMI refuses a standard
account's network logon, so the account runs only the gateway and Tailscale CLIs; the
Administrator observes its task, processes and listener.
Through its own WinRM shell the lane requires a token with neither `BUILTIN\Administrators`,
deny-only included, nor `SeSecurityPrivilege`. Tailscale serves one Windows user at a time, so
the Administrator then hands it over the way a person would: its desktop signs out (a connected
tray client refuses every other account), Serve resets, and `tailscale logout` deletes its
unattended profile. The lane deletes that node, and the standard account joins as a new tagged
node under the same hostname; the join's origin is authoritative. After a pinned RDP logon as the
account, the candidate installs fresh → reboot → at least three pre-login samples → pinned RDP
logon and automatic startup → the full doctor as the account → readiness rotation → uninstall
with private state preserved. Every doctor and pre-login sample, for either account, requires the
logon trigger to name the account the task runs as. These observations carry a `standard`
prefix. Predecessor, upgrade, rollback, OMP and Pixel journeys stay Administrator-only, because
v0.6.2 cannot install without elevation.

**Tagged-node doctor result.** Follow the existing [Debian identity convention](LINUX_QUALIFICATION.md#gap-3--denied-tailscale-identity),
not an N/N claim. The tagged host's self-probe through Serve has no user identity. Record the
true/total split and the exact false set: `identityAllowed`, `pwa`, and `sessionHealth`
(`publisherHealth` on older builds), plus `securityHeaders` only when that refused response
actually omits CSP. Every other check must be true, including `loopbackTrustSound`,
`serveMapping`, `funnelDisabled` and `compatibility`; missing host checks and additional failures
are rejected. The allowed half comes from the user-owned Pixel: load the shell through this
Windows Serve origin, find the fixture, and exercise View and Control. The node stays tagged.

OMP is built from the exact locked stock source commit and tree, not a floating global package.
A local bare checkout proves both Git objects; its exported source archive is hash-checked after
encrypted upload. The guest performs a frozen Bun install and native Windows build, then writes
`collab.autoStart: control` to the profile's `config.yml` and requires the built binary to read it
back. Over WinRM, the compiled binary's `config set` can exit 0 without writing anything: in a
v0.6.0-prealpha.3 development run its host started with auto-start off and never published.
`scripts/windows-qualification-pins.json` binds the Windows native tarball/payload hashes to the
OMP version, commit and tree and pins Bun/Tailscale artifacts. Both preflight and the portable
tests reject divergence from `UPSTREAM.lock.json`; an upstream refresh must refresh these
Windows pins too. No upstream lock/schema change is needed for the separate lane-owned pins.

On a stable-campaign failure, cleanup first reconciles the exact vault-bound instance and its
epoch-labelled inventory. Confirmed absence skips guest commands. A live guest gets one bounded
reconnect before guest teardown, Serve reset and logout; failed reconnect skips those commands
instead of spending four full command timeouts against an unreachable VM. Exact-label tailnet
deletion, instance deletion, firewall deletion and vault removal still run. Once the Administrator has
handed Tailscale over, the gateway uninstall, Serve reset and logout run as the standard account:
Windows refuses the Administrator's Tailscale CLI while another account holds it. Each provider deletion
refetches ownership and applies the positive prefix and protected-resource checks. Lost create
responses are recoverable by the exact epoch-derived label even without a vault. Cleanup polls
for deletion and requires zero `omp-winqual-*` instances and firewall groups account-wide.
Guest-command failures become diagnostic counts only after the exact owned VM is confirmed gone.
They never excuse failed firewall/tailnet absence, Pixel restoration, or safe vault-removal proofs.
Instance and firewall IDs are retained privately so a changed ownership label cannot masquerade as
absence. Changed/protected owners, missing Pixel recovery state, and unresolved absence remain
blocking, retain recovery state, and prohibit automatic campaign retry. Paid infrastructure cleanup
does not wait behind another lane's Pixel lease.
Provider reads retry a transient 5xx. A lookup that answers missing, or a Vultr listing without its
array, is final only when a second read five seconds later agrees: on 2026-09-29 one listing did so
while the lane polled for allocation, failing an attempt whose VM was still booting.
A stable interrupted attempt is reconciled, never blindly replayed; start a fresh epoch
afterwards. For development only, a code failure after guest access retains the VM for immediate
repair: rerunning `run` resumes that epoch, skips completed phases, and checks staging
postconditions rather than replacing the VM. `cleanup` is explicit after an abandoned attempt.
Failed phase resumes are counted in evidence; repair time is not called successful phase time.
Development resume is refused after three hours, and every VM must be destroyed within four
hours of creation. The current development campaign permits six total VM creations, one at a
time. Production failures retain their unconditional cleanup semantics.

### Development evidence — 2026-09-29: v0.7.0-prealpha.1

Tested evidence only; none of it qualifies a release. One VM paired `v0.7.0-prealpha.1` with
published v0.6.3 and built locked OMP 18.4.2.

The stable campaign had failed this lane in toolchain staging with `native command failed: bun.exe
exit 1`, which cannot say whether the frozen install or the OMP build failed. Hosted `windows-2025`
runners with Bun 1.4.0 built the same pinned sources five times (18.3.0 twice, 18.4.2 three
times), including once in the guest's shape: its `C:\omp-winqual-<uuid>` root and ACL, a stock
PATH without git, node, python or npm, and `LongPathsEnabled` 0 (the longest installed path was
232 characters). Peak Bun private memory was 2,432 MiB for 18.3.0 and 2,473 MiB for 18.4.2. The
development VM then built 18.4.2 in its own staging (1,196,995 ms for the phase). The failure did
not recur and its cause is not claimed; the two build calls now report as `bun-install` and
`omp-build`.

Three phase attempts failed, each diagnosed on the retained guest:

- `candidate_upgraded`: the immediate `Installed` status read failed. The same read-only status
  later reported ready, installed, active and not diverged, with `activeVersion` and
  `serviceVersion` both `0.7.0-6d2a377aaae5`, and replaying the v0.6.3 → v0.7.0 install
  (6,782 ms) converged on the first of 15 reads. Post-mutation status now settles within a bound
  (#312).
- `pixel_verified`: Chrome, released by Android's cached-apps freezer and resumed in the foreground
  with the keyguard down, did not answer DevTools during the nine-second wait; three replays of the
  same helper connected in about three seconds. The wait is now a 30-second deadline that names its
  last error (#313).
- `pixel_verified` again: `View did not remain read-only`. The journey compared the pre-18.4.2
  lowercase placeholder while the composer was disabled; its View assertion is now shared with
  the browser e2e (#314).

After those repairs the lane passed from `candidate_upgraded` to cleanup. The upgrade took
40,264 ms with config and readiness preserved. Three pre-login samples spanned 54,086 ms and the
logon started the gateway in 55,165 ms; doctor passed 15/18 with the tagged-node false set. OMP
published in 34,907 ms. The Pixel stage took 16,676 ms: identity accepted, View read-only, Control
writable, prompt accepted, returned to the directory. Revocation, readiness rotation,
history-selected rollback, restoration and uninstall with state preserved followed. The standard
account's token held neither Administrators nor `SeSecurityPrivilege`; three pre-login samples
spanned 54,716 ms, its logon started the gateway in 37,177 ms, its doctor passed 15/18 and its
uninstall left no task, process or listener. No post-mutation status read needed the settle
window. Cleanup left zero instances and firewall groups, deleted the tailnet node and removed the
vault.

### Development evidence — 2026-09-27: standard-user sub-lane

Tested evidence only; none of it qualifies a release. Both runs paired the candidate with published
v0.6.2.

On `v0.6.3-prealpha.1`, one VM passed every Administrator phase, including the Pixel, then the
account's token check, the Tailscale handover, and the account's tagged join and first RDP logon. It
failed four times on the way, each diagnosed on the retained guest:

- The WinRM bootstrap read `WSMan:\localhost\Service\AllowUnencrypted` for every account. A standard
  account cannot and got `ItemNotFoundException`, so the check now runs for the Administrator only.
- Vultr answered one lookup of the running, owned VM as absent, failing the lane with the VM
  healthy. An owned instance, firewall, or tailnet device is now absent only when a second read,
  five seconds later, agrees.
- `Get-NetAdapter` threw `CimJobException` as the account. Over its network logon, WMI refused every
  CIM query (`Win32_Process`, `Get-NetTCPConnection`, `Get-ScheduledTask`, `Get-NetAdapter`), while
  the Task Scheduler's COM interface and .NET's interface and listener tables answered. The join now
  reads the interface table, and the Administrator observes the account's task, processes, and
  listener.
- The account's fresh install then read `active: false` from the product's own `status` while its
  task ran (COM state 4). That was a product defect: WMI refused `Get-ScheduledTask` to a standard
  user's network logon, including SSH. PR #298 fixed it and the stop race its faster query exposed.

Cleanup after the handover ran as the standard account and passed on its first attempt.

On `v0.6.3-prealpha.2` (archive `5a1ba40e79a0…`), a fresh VM passed the whole lane with no failed
phase attempt. The account's token carried neither Administrators nor `SeSecurityPrivilege`, and its
fresh install became ready. Three pre-login samples over 63,487 ms held its task present but not
running, with no process or listener. Its logon started the gateway in 72,072 ms. Its doctor passed
15/18, with the Administrator's tagged-node false set (`identityAllowed`, `pwa`, `sessionHealth`).
Rotation changed readiness and kept the config, and uninstall kept both. The eleven standard phases
took 487 s. Both accounts' tasks named their own account in the logon trigger. Cleanup left zero
instances and firewall groups, deleted the tailnet node, and removed the vault.

### Development evidence — 2026-09-24

Published v0.5.3 and predecessor v0.5.2 passed local checksum, signed-tag, GitHub attestation,
Sigstore bundle and archive-identity verification. Input verification alone is not a lifecycle
pass; the observed lifecycle follows. None of these development observations qualify a release.

The first disposable attempt reached authenticated WinRM and observed Windows build `26100`,
2 logical CPUs and 4,090 MiB usable memory. Firewall creation took 3,042 ms, instance creation
1,655 ms, and authenticated transport readiness 395,633 ms. Toolchain staging then failed on a
Vultr HTTP 500 while refetching the owned instance. The failure was not retried or called a pass.
Guest cleanup also reported `resetServe`; the original aggregation retained that step name but
not its underlying cause, so no product defect or root-cause fix is claimed. Cleanup now
distinguishes an unjoined `NeedsLogin` daemon from a running Serve configuration. All provider
deletion steps continued despite the guest failure. The attempt ended after 591.74 s, and explicit idempotent
cleanup proved zero qualification instances, zero qualification firewall groups, no matching
tailnet node and no access vault. No gateway lifecycle or physical-client phase is claimed for
that failed attempt.

The second attempt reached the same guest build and shape, with 3,715 ms firewall creation,
3,468 ms instance creation and 340,892 ms authenticated WinRM readiness. Staging failed with
`WinRMTransportError`; its HTTP detail was not retained by the initial adapter, so no precise
transport cause is claimed. That attempt ended after 524.03 s and the same explicit zero-resource
cleanup proof passed. Inspection found the 189,235,200-byte source tar was being serialized as
one guest JSON value. Upload now uses a 67,418,996-byte gzip archive and bounded 64-KiB binary
frames decoded directly into the destination file, not a whole-payload string. Five portable
standard-library tests in `scripts/windows-winrm.test.py` exercise framing, byte preservation,
EOF, response bounds and diagnostic redaction with a fake transport before another VM is created.
Cloud destruction precedes Pixel cleanup-lease acquisition, so device contention cannot retain
a paid VM; a failed device restoration keeps the private recovery vault for the next cleanup.

The third VM was retained for development repair rather than recreated. Its first transport
attempt failed on provider HTTP 500 (73.80 s invocation). A subsequent 731.78 s invocation
timed out because the vault still held the provisional create-response address; a read-only
provider lookup showed an active, running guest, a different allocated address, and unchanged
guest access. Transport admission now waits for allocation and saves that current address.
The next invocation reached staging but rejected a successful native command (44.45 s): the
PowerShell helper had shadowed the global native exit-code variable. A local PowerShell repro
rejected `/usr/bin/true` before the fix; afterwards it accepted exit 0 and rejected exit 1.
Another staging invocation (42.31 s) refused an ownership re-fetch before upload. Subsequent
list and single-resource reads satisfied every ownership predicate, including the admitted
protection set; the transient refusal's exact cause is not claimed.

Bounded archive streaming then completed and all three uploaded archive digests passed. The
initial Tailscale `login` invocation failed (399.82 s invocation); adding unattended login
enrolled an authorized, correctly tagged node but left the guest backend at `NoState` (31.59 s).
An initial RDP session did not resolve that state (54.03 s). Switching the connection command
to `up --unattended=true` completed tagged TUN/Serve setup and the locked stock OMP build.
That 519.11 s invocation subsequently failed the immediate predecessor readiness/version
predicate. The same read-only predicate later reported installed, active, ready, not diverged,
and the expected `0.5.2-005df2868300` runtime without another install; its transient result is
not attributed to a product defect. Development resume now inspects that completed install
and preserved private-state digests rather than reissuing it.

The candidate upgrade next preserved both digests, but the initial N/N doctor assumption
rejected four checks (49.27 s invocation). `compatibility` was a harness PATH omission, fixed
by placing the exact owned OMP build on the guest command PATH. The other three failures were
the documented tagged-node denial, not a product defect: the operator received 200 for the
session list, shell, manifest and worker, while the Windows host received 403 for all four.
The lane now enforces and records the documented split above; it never changes auth mode or
enrolls an untagged node to make doctor report N/N.

The next invocation (204.82 s) recorded the expected 15/18 pre-reboot doctor split, rebooted,
then observed three pre-login samples over 55,411 ms with no gateway process, running task or
listener. Pinned RDP login started the gateway automatically in 42,950 ms without a manual task
start. Post-login doctor correctly failed `loopbackTrustSound` while the TUN adapter was still
converging. A later read-only doctor showed the adapter up and only the three expected identity
denials; no manual network repair was made. The readiness probe now requires the artifact's
actual `tailscaleConnected` and `loopbackTrustSound` checks as well as HMAC readiness. Its direct
guest smoke passed, but the earlier 42,950 ms measurement is not relabelled as combined readiness.

An added task-definition gate initially rejected omitted default XML fields (27.96 s invocation).
The observed task has exactly one `LogonTrigger` and `InteractiveToken`; Task Scheduler's
effective properties report enabled and Limited privilege while exported XML omits their
defaults. The gate now checks those effective properties. It passed before stock OMP publication
in the next invocation (50.71 s), which then exposed a separate harness PID-capture defect.
The reused hidden-console launcher writes its PID to `Console.Out`, not PowerShell's object
pipeline; the wrapper had saved zero while the real stock OMP publisher was alive. The wrapper
now captures Console output explicitly, rejects nonpositive PIDs, and removes the owned PID
reference after a verified stop. The old reference was repaired from the single exact-binary
publisher and its actual discovery record, and that owned process was stopped before exercising
the corrected launcher. No discovery file or socket was changed.

The corrected launcher published the named pipe, and View/Control plus stale-generation
contracts passed. The first physical invocation (70.36 s) loaded the Windows-hosted shell and
directory on the user-owned Pixel, joined read-only View and writable Control, accepted a prompt
and returned to the directory. Restoring the prior installed-PWA activity then failed with adb
exit 255 because `SameTaskWebApkActivity` is not exported. The owned lease remained held.
Restoration now resolves that activity's actual WebAPK task owner and launches its existing
launcher intent. A 28.92 s recovery verified the original foreground component, Awake display
and keyguard=false before releasing the lease. The failed phase remains a failure and must
complete again with restoration included; it is not silently credited as passed.

The final resumed invocation completed in 174.02 s, including the physical phase again and
successful cleanup. Its private `evidence.json` records **tested-development-only**, 13 failed
phase resumes, the expected doctor split, and every required lifecycle observation. Successful
phase segments were:

| Phase | Observed duration | Result |
|---|---:|---|
| Locked toolchain staging | 484,749 ms | Stock OMP 18.3.0 source/tree and Windows native payload; Bun 1.4.0; Tailscale 1.102.4 |
| Predecessor install postcondition | 11,557 ms | v0.5.2 ready; completed prior install adopted without reinstall |
| Candidate upgrade | 36,966 ms | v0.5.3 ready; configuration and readiness digests preserved |
| Reboot request / pre-login gate | 24,709 / 74,445 ms | Three negative samples spanning 55,411 ms |
| Automatic post-login startup | 42,950 ms | Gateway HMAC readiness; later TUN convergence caveat above |
| Post-reboot doctor | 16,306 ms | 15/18; false only identityAllowed, pwa, sessionHealth; actual logon/interactive task verified |
| OMP publication and launch | 33,118 ms | Named pipe, generation 1; View/Control 200; both stale generations 409; no-store |
| Physical Pixel including restoration | 17,916 ms | User identity accepted; read-only View, writable Control, prompt, directory return; baseline restored |
| OMP revocation | 9,699 ms | Owned host stopped and directory revocation observed |
| Readiness rotation | 18,960 ms | Changed readiness digest, ready, configuration preserved |
| History-selected rollback | 21,959 ms | v0.5.2 ready with configuration and rotated readiness state preserved |
| Candidate restoration | 20,427 ms | v0.5.3 restored and ready; both digests preserved |
| Uninstall | 12,956 ms | No gateway task/process/listener; configuration and readiness state preserved |

The user-owned Pixel **did successfully reach the tagged Windows node** through its HTTPS
Serve origin. The host's denied self-probe and the Pixel's allowed path are distinct observations.
All three disposable VMs were destroyed. The final attempt's start-to-evidence interval was
6,052,503 ms (about 101 minutes), including diagnosis and repair pauses, not a cold-start benchmark.
Cleanup returned zero qualification instances, zero qualification firewall groups, matching
tailnet node deleted and vault removed. A separate 9.88 s cleanup invocation returned the same
zero-resource result. The receipt is mode 0600 and passed the forbidden-key/network-identifier
scan; the Pixel lease was released only after foreground/display/keyguard restoration. Temporary
parser, uncompressed source archive and restoration scratch files were removed.

No product defect was established. Those third-VM observations were resumed v0.5.3 development
evidence, not a fresh uninterrupted run or v0.6.0 qualification. They did not exercise the
combined post-login HMAC/TUN gate during a new reboot; the fourth-VM observation below does.

### Fourth VM: first-boot admission follow-up

A new VM was started with the separate provisioning flag unset and credential-scoped
`tailnet/-` inventory. The uninterrupted invocation failed after 455.95 s: firewall creation
took 7,883 ms, instance creation 7,171 ms, and cold authenticated WinRM 346,711 ms, but the
subsequent initial RDP fingerprint request returned `WinRMTransportError HTTP 400`. A separate
framed read-only certificate query later succeeded without a repair. The original fault's
cause is not established; neither that query nor the subsequent resume is a claimed fix.

The admission contract was strengthened separately: one authenticated success after boot is
not stability. The final boundary requires the three consecutive observations described above.
Injected tests prove that an error between successes resets the count and elapsed window,
that instability cannot extend the deadline, and that a guest assertion is not retried. A
separate live read-only smoke on this fourth guest observed three successes spanning 74,314 ms
(82.19 s command), recorded privately in `transport-stability-vm4.json`. This verifies the new
boundary but does not retroactively replace the original attempt's transport checkpoint.

The retained fourth VM then completed in one resumed invocation of **1,814.61 s** with exactly
one failed-phase resume recorded. From `toolchain_staged` onward, the final implementations ran
in sequence without another repair or resume, including a real reboot and the combined
post-login readiness gate. Its v0.5.3/v0.5.2 gateway inputs, stock OMP 18.3.0, Bun 1.4.0,
Tailscale 1.102.4 and Windows build 26100 were unchanged from the pins above.

| Fourth-VM phase | Observed duration | Result |
|---|---:|---|
| Toolchain staging | 936,976 ms | Fresh guest tools, archived source build and tagged TUN/Serve |
| Predecessor installation | 47,011 ms | v0.5.2 ready |
| Candidate upgrade | 67,189 ms | v0.5.3 ready; both private-state digests preserved |
| Reboot request / pre-login gate | 26,852 / 88,521 ms | Three negative samples spanning 61,958 ms |
| Automatic post-login startup | **94,568 ms** | Pinned RDP login, HMAC readiness and actual connected/TUN doctor predicates |
| Post-reboot doctor | 23,524 ms | 15/18; only the three expected identity denials; logon/interactive task verified |
| OMP publication and launch | 41,679 ms | Named pipe, generation 1, View/Control 200, stale generations 409, no-store |
| Pixel lease, checks and restoration | 279,809 ms | User identity accepted; View, Control, prompt, directory return and baseline restoration |
| OMP revocation | 14,519 ms | Owned fixture stopped and revocation observed |
| Readiness rotation | 32,937 ms | New readiness digest, ready, configuration preserved |
| History-selected rollback | 35,726 ms | v0.5.2 restored with private state preserved |
| Candidate restoration | 36,323 ms | v0.5.3 restored with private state preserved |
| Uninstall | 17,582 ms | No gateway task/process/listener; private state preserved |

The user-owned Pixel again reached the **tagged Windows node** successfully; DND was untouched.
No manual gateway task start occurred after reboot. Start-to-evidence elapsed time was
2,472,201 ms (about 41.2 minutes), including the failed initial invocation and diagnosis. This
is explicitly **resumed**, not fresh-uninterrupted, and remains tested-development-only.

Cleanup proved zero qualification instances and firewalls, the matching tailnet node deleted
and the access vault absent. A separate 2.82 s cleanup invocation returned the same result.
Four VMs were created in total and all were destroyed. The Pixel lease was released after
verified restoration. Mode-0600 `evidence-vm4-resumed.json` and `progress-vm4-resumed.json`
preserve this attempt; its evidence and the separate stability proof passed the forbidden-key
and network-identifier scan. The exact signed v0.6.0 candidate still requires its own stable
campaign; no development evidence is promoted to qualification.

## Fork-era procedure and evidence archive

**Every diagnosis, measurement, command, and release requirement below is a fork-era record**
against the named patched OMP/source artifacts. Preserve its dates, failures, timings, counts,
checksums, and signature caveats; none now describes the shipping prerequisite or a mainline pass.
The final historical paired-patch requirement below is superseded: a new Windows claim must
instead qualify exact mainline OMP and gateway artifacts through discovery, View/Control,
revocation, install, reboot/login, readiness-token rotation, upgrade/rollback, and cleanup.


Hosted CI (`platform-qualification.yml`, job `windows-service-lifecycle`) proves install,
named-pipe derivation, token ACLs, rotation and uninstall on Windows. The runner is then
destroyed, so nothing there can prove the service comes back after a reboot. That is the same
class of defect as issue #69 on Linux, which was invisible to every install-time check and only
appeared across a boot.

This document records the failed 2026-08-20 diagnosis and the successful 2026-08-21 persistent-VM
source acceptance. Release support still requires the signed-byte rerun described below.

## Finding: the Windows gateway is login-gated by design

`apps/gateway/src/service.ts:84` registers the Scheduled Task with:

```xml
<Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
<Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType>…</Principals>
```

A `LogonTrigger` fires on interactive logon and an `InteractiveToken` principal can only run
while that session exists. **The Windows gateway therefore does not start at boot. It starts at
the next interactive logon.**

This is coherent with the product being a user-level agent, but it is not symmetric across
platforms, and the asymmetry is user-visible:

| Platform | Mechanism | After a reboot with nobody logged in |
| --- | --- | --- |
| Linux | systemd user unit, `WantedBy=default.target`, plus `loginctl enable-linger` (`service.ts:63`) | **Runs.** Proven on hardware after issue #69: class `manager`, no interactive login. |
| macOS | LaunchAgent, `RunAtLoad` (`service.ts:71`) | Does not run until the user logs in. |
| Windows | Scheduled Task, `LogonTrigger` + `InteractiveToken` (`service.ts:84`) | Does not run until the user logs in. |

Linux is the outlier because lingering was enabled deliberately. Whether Windows and macOS
should match it is a product decision, not a bug to fix silently — but the operational answer to
"will my phone see sessions after the computer reboots?" differs by platform today and should be
documented wherever install is described.

### The install failure is a separate defect, not the logon gating

An early reading blamed the non-interactive transport for `install` failing with

```
service installed but the loopback readiness proof did not become valid
```

**That was wrong, and a later run refuted it.** An RDP logon was established first — `query
session` showed `rdp-tcp#1  Administrator  Active` and `explorer` was running — and `install`
failed identically. The interactive session is required for the task to *run*, but it is not why
install fails.

Polling every 3 s during the install shows what actually happens:

| t | task | state | lastResult | bun procs | listener :4317 |
| --- | --- | --- | --- | --- | --- |
| 21s | absent | – | – | 1 | 0 |
| 24s | present | Running | 267009 | 2 | 0 |
| 39s | present | Running | 267009 | 2 | 0 |
| 42s | present | Ready | 267014 | 2 | 0 |
| 45s | absent | – | – | 0 | 0 |

The Scheduled Task is created and genuinely runs — two `bun` processes, the daemon alive for
about 18 s — but it never binds the loopback listener before `install` gives up and rolls back.

The cause was a fixed 15 s readiness budget (`cli.ts`) against ACL verification that spawns a
separate PowerShell process per path (`config.ts`, `applyWindowsAcl` and
`assertWindowsAclPrivate`, reached from five call sites). A single minimal `Get-Acl` spawn on this
2-vCPU host measured 2132, 1780, 1787, 1810, 1762 ms — mean 1854 ms. A cold `serve` executes ten
of those spawns before it binds the listener — one for `config.json`, five for the publisher token
and the two directories it creates, four more when the push service re-verifies them — so ACL
verification alone costs ~18.5 s. The budget was gone before the listener was reached, which is
exactly the ~18 s of daemon lifetime tabulated above.

Tracked as [#90](https://github.com/alphastorm/omp-session-gateway/issues/90).
**Fixed and accepted in source on a persistent host.** `readinessBudgetMs` keeps 15 s on Linux and
macOS and allows a 60 s hard deadline on Windows. On 2026-08-21 the exact source archive from
`622c242c625f3ab23b11b55f5a6994953895ba23` completed install on the same modest 2-vCPU shape in
77,498 ms end to end, with the Scheduled Task running and the listener bound only to `127.0.0.1`.
The deadline remains fail-closed: tests pin its last legal poll and a never-ready service still
terminates at the bound. PowerShell ACL startup cost remains performance debt; the bounded fix is
enough for correctness but is not evidence that ten process spawns are efficient.

The original failure remains useful regression evidence: its readiness proof rolled back
completely and never claimed success for a service that had not served.

## Persistent-VM acceptance — 2026-08-21

Environment: Windows Server 2025 Standard build `26100`, 2 vCPU, 4 GiB, Bun `1.3.14`, and a
Vultr firewall allowing RDP/WinRM only from the operator's current `/32`. The gateway input was a
deterministic unsigned archive from source
`622c242c625f3ab23b11b55f5a6994953895ba23`, SHA-256
`f458ab376350bb03246fe60ba3401bd67927ef19b6270461fb9c441fc567c2e2`, targeting OMP
`v17.4.1` / `9350b7990d26ebf69a604edc82d8558ef04adf30`.

| Transition | Observed result |
| --- | --- |
| Cold install with an RDP interactive session | Exit 0 after 77,498 ms; task `Running`, loopback health ready, one listener on `127.0.0.1`, 44-byte publisher token owned by the current user with only current-user/SYSTEM allow ACEs. |
| Reboot before login | Both management ports went down and returned; task `Ready`, no interactive Administrator, no `4317` listener, and `status` reported installed but inactive/not ready. Config and token hashes were unchanged. |
| First interactive login after reboot | A certificate-pinned RDP login created an active Administrator session. Without `/Run` or another manual service action, the `LogonTrigger` fired after boot and the gateway reached ready in 106,388 ms; task, listener, config, and token invariants held. |
| Token rotation | Exit 0 after 55,987 ms; token changed, config did not, task and loopback readiness returned. |
| Active upgrade | A synthetic help-text-only build staged a distinct runtime and became ready after 82,287 ms; config/token were byte-identical and activation history recorded the new pointer. |
| History-selected rollback | Returned to the exact source runtime after 59,040 ms; config/token stayed byte-identical, current pointer, latest activation, service definition, and `status` agreed. |
| Tailscale/doctor | Tailscale `1.102.3` was Authenticode-valid and joined as a temporary user-owned node. TUN-mode Serve mapped HTTPS to `127.0.0.1:4317`; `doctor` passed **17/17**. Tailscale was brought down after qualification. |
| Patched OMP path | Pristine upstream `v17.4.1` accepted patch SHA-256 `abcc8866f76fc82485a42c0ce51ca19aec3b928afcddf0af1c25c35dd10ad4e2`. The Windows publisher suite passed 13/13; an unsigned `omp/17.4.1` binary (SHA-256 `4afb47e07092d8a1c14e6fbbc6ec15a5aa8b51bd78ffff25bbab299d0d942c24`) auto-published one generation with View and Control. Both launch modes returned `200` and `no-store`; a mismatched generation returned `409` with no capability; forced process termination removed the card at revision 2 in 374 ms. |
| Uninstall | Exit 0 in 4,648 ms; task, gateway/OMP processes, and listener were absent, while config and publisher token were preserved exactly. |

This accepts the source fix and the reboot→interactive-login contract. It does **not** promote
Windows yet: the gateway archive and patched OMP binary in this lane were unsigned, and the complete
`read-only.test.ts` file exposed a Windows-only fixture hang after its first six passing cases.
The final release lane must repeat against signed gateway and patched-OMP artifacts and disposition
that fixture hang rather than hiding it.

## Provider findings (Vultr)

Vultr was evaluated as the persistent-Windows provider. Usable, but only via WinRM.

| Question | Result |
| --- | --- |
| Startup scripts (`script_id`) on Windows | **Never run.** Attached at create; sshd was never installed and the marker file never appeared. |
| `user_data` (Cloudbase-Init) on Windows | **Never runs.** `Get-Service cloudbase-init` does not exist on the image, so there is no agent to consume it. |
| SSH | Not available. Keys are injected for Linux only; port 22 never opened across 25 polls (~750 s). |
| RDP 3389 | Open and reliable. |
| WinRM 5985 | **Open out of the box and works.** `Administrator` + the instance's default password over NTLM. |
| WinRM encryption | `AllowUnencrypted` is `false`; pywinrm's NTLM transport applies message-level encryption. |
| Time to WinRM | ~4–5 min from create. A plain TCP port check is misleading — it reads open during setup and then times out. Poll with a real authenticated call. |
| `default_password` | **Returned only in the create response.** It is absent from `GET /v2/instances/{id}`, so an instance whose creation response was discarded is unreachable and must be destroyed. |

Latest accepted image: Windows Server 2025 Standard (`os_id` 2514), `vc2-2c-4gb`, region `ewr`,
Windows build `26100`, PowerShell 5.1, and Bun `1.3.14`. The VM also built the exact patched OMP
Windows binary successfully after installing the official `@oh-my-pi/pi-natives@17.4.1` addon.

### Reproducible provider recipe

1. Create the instance and **capture `default_password` from the create response immediately**;
   it is unrecoverable afterwards.
2. Attach a Vultr firewall group at creation that permits 3389 and 5985 only from the operator's
   current `/32`; do not wait for a guest firewall repair after public boot.
3. Poll with an authenticated WinRM call, not a port scan.
4. Verify the RDP certificate fingerprint through WinRM's local `Remote Desktop` certificate store
   before accepting it, then create the required interactive session.
5. Label the instance `omp-winqual-*`; leave no gateway, OMP, listener, or active tailnet connection
   while held, and destroy the VM immediately after the signed-candidate rerun.

## The self-hosted Windows workstations are not the qualification path

Two Windows 11 Pro workstations sit on the operator's tailnet and already host repository CI
(`nyc-pc`, an AMD Ryzen 9 7950X; `sf-pc`, an Intel Core i9-14900K). They run the gateway's
`gateway-ci-linux-x64` runners, so the question of using them for Windows qualification is a fair
one. They are not suitable, for four independent reasons.

- **The lane they already provide is Linux.** Those hosts run *Linux x64* runners inside Docker.
  Reusing them for Windows qualification means running on the Windows host itself, which is a
  different and far more invasive arrangement than the container lane they were qualified for.
- **SSH reaches Session 0, and the gateway needs an interactive one.** Access is key-only OpenSSH
  running as a Windows service, which is non-interactive. The Scheduled Task is
  `LogonType: InteractiveToken` by design, so a Session 0 caller cannot make it run, and the
  reboot-then-login sequence that the qualification actually turns on cannot be driven that way.
- **Reboots are not available.** Both hosts carry production inference appliances that must keep
  running, and neither has automatic logon, so a reboot halts the workload until a human logs in
  interactively. That is the opposite of a disposable qualification host.
- **They are the wrong shape for the measurement that matters.** The slow-ACL defect this document
  records was found on a 2-vCPU, 4 GiB host. These are 32-thread desktops with large memory
  headroom, so a pass on them would say nothing about the constrained case that actually failed.

The disposable provider VM recipe above remains the qualification path. It is reproducible, costs
little, reproduces the constrained shape, and leaves no residue on a machine anyone depends on.

## Remaining release qualification

Automatic logon is the obvious way to create the interactive session a Scheduled Task needs, and
**Windows Server 2025 refuses it**. `AutoAdminLogon=1`, `DefaultUserName`, `DefaultPassword`,
`DefaultDomainName`, `AutoLogonCount=5` and `DisableCAD=1` were all set and verified present in
the registry; across two reboots `LogonUI` remained at the login screen and `explorer` never
started. Do not spend more time on this knob.

**RDP works and is solved.** `sdl-freerdp` connects headlessly from macOS with no X server,
because SDL uses native Cocoa; `xfreerdp` cannot, since `DISPLAY` is unset and `+auth-only`
deliberately skips the display and therefore creates no session. One short connection is enough:
an RDP logon fires the `LogonTrigger`, and a disconnected RDP session keeps its processes
running, so the client does not need to stay attached. Lock 3389 to the operator's egress
address alongside 5985.

Remaining to advertise Windows:

1. Produce and retain an exact signed patched-OMP Windows artifact, whether through a future paired
   package or an equivalent qualified build from the accepted patch route.
2. Repeat the accepted install → reboot → no-login inactive proof → RDP login → automatic start →
   `doctor`/rotation/upgrade/rollback/uninstall sequence against the exact signed gateway candidate
   and that exact OMP binary.
3. Keep the product promise explicit: Windows starts at interactive login, not unattended boot.
   Changing that would require a boot trigger and non-interactive principal with different
   privilege and token-ACL consequences; this qualification does not authorize that redesign.
4. Resolve or explicitly baseline the Windows-only `read-only.test.ts` fixture hang. The publisher
   path itself passed 13/13, the remaining isolated patch fixtures passed, and the production binary
   published and revoked correctly, but a hung fixture is not a green full-suite claim.

At the 2026-08-21 fork-era beta cut, `Windows host lifecycle` remained **PARTIAL for release** for
that beta campaign; mainline campaigns from `v0.6.0` onward automate and pass the full
signed-artifact Windows lane above.

Beta itself uses the command-complete, versioned v17.4.1 patch route documented in
`patches/oh-my-pi/README.md`. Upstreaming and paired packaging are not beta gates. This scope choice
does not weaken the integration requirement, imply stock-OMP compatibility, or promote Windows.

## Cost and hygiene

The two 2026-08-20 probes and the successful 2026-08-21 qualification VM were destroyed. Before
the final deletion, gateway and OMP tasks were absent, no Bun/OMP process or port-4317 listener
remained, and the temporary Tailscale identity was logged out. The Vultr API then reported zero
`omp-winqual-*` instances and zero firewall groups; the captured administrator password and local
state file were shredded/removed. The one unrelated pre-existing instance was not touched. No
instance identifier, address, login, or credential is recorded in this repository.
