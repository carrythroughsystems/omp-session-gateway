# Branch and saved-session resume lane

This runbook is for maintainers running OMP session lifecycle qualification and reviewing the
automated upstream canary stages. Each stable release qualifies the `new-generation`, `fork`, and
`--continue` transitions on the Mac guest, and the Linux and Windows upstream canaries exercise them
daily; see [Compatibility](COMPATIBILITY.md) and [Release status](RELEASE_STATUS.md).

## Mainline lifecycle coverage

The gateway consumes stock OMP `>= 18.1.20` with `collab.autoStart` alone. It reads OMP-owned
discovery, polls metadata, and resolves an exact generation/role only at launch, without storing
capabilities or writing discovery files. The executable lanes below cover lifecycle transitions.
<!-- release-generate:campaign:start -->
The v0.8.0 qualification stays bound to its recorded candidate and devices. The v0.9.0 campaign must pass these scenarios again on its exact signed bytes before its matrix is qualified. See the [release ledger](RELEASE_STATUS.md).
<!-- release-generate:campaign:end -->

### Stock OMP semantics

Upstream source and real stock 18.4.8 runs establish these distinctions. A guest snapshot replicates
every session entry, including sibling branches, so transcript content cannot prove a rewind.

| Command | Session effect | Gateway-visible change | Where tested |
|---|---|---|---|
| `/new` | Switches to a new session | Same instance, generation + 1 | POSIX canary; Mac lifecycle development runner |
| `/fork` | Immediately copies the current session to a new file with the same entries; no selector, despite the command description | Same instance, generation + 1 | POSIX canary; Mac lifecycle development runner |
| `/branch` (alias `/rewind`) | Opens `Rewind · pick the point to continue from` and rewinds inside the same session file | Same instance and generation; no gateway-visible change | POSIX canary |
| `/tree` | Navigates branches within the session | No new session or generation implied by branch navigation | Upstream source semantics; not a separate stage in these lanes |
| Stop, then relaunch with `--continue` in the same working directory | Resumes the saved session in a new process | Old instance gone; new instance at generation 1 | POSIX canary; daily `canary-windows` lane; Mac lifecycle development runner |

### Daily upstream canary

[`scripts/upstream-canary.ts`](../scripts/upstream-canary.ts) runs from the
[canary workflow](../.github/workflows/upstream-canary.yml) on its daily schedule, by
`workflow_dispatch`, and on pull requests touching the canary. Its ordered stages are `prepare`,
`publish`, `snapshot`, `stale-generation`, `view`, `control`, `new-generation`, `fork`,
`branch-rewind`, `continue`, and `unregister`. The `prepare` pre-flight stage resolves the installed
package manifest version, checks the running Bun against `engines.bun`, verifies the stock binary,
and queries its version before any lifecycle stage. Pre-flight failures retain the resolved
manifest version in the report.

On POSIX the tmux host accepts the real slash commands. `new-generation` and `fork` each require
the same instance and generation + 1; once that generation is visible, old-generation View and
Control queries must be refused and fresh links must work. The fork View transcript must retain
both earlier synthetic prompts. `branch-rewind` requires an anchored
in-memory terminal status, `Rewound to selected point`, plus unchanged instance/generation and
working links. The terminal status is never printed. `continue` requires the old instance gone,
a new instance at generation 1, old links refused or gone, and a fresh View transcript containing
a prompt sent before the stop. `unregister` checks host exit and revocation.

Windows uses a hidden console without keystroke transport. It runs `continue` but marks exactly
`new-generation`, `fork`, and `branch-rewind` as `skipped`. The strict platform projection rejects
any other successful skip pattern; summary JSON includes `platform`. These skips are not passed
transitions.

```sh
bun scripts/upstream-canary.ts --omp <binary>
```

### Retained-Mac stable lane

After every lane using the campaign live session has settled successfully and the relay tunnel
has stopped, `ompPublication` in [`stable-qualification.ts`](../scripts/stable-qualification.ts)
runs the shared [`omp-lifecycle-qualification.ts`](../scripts/omp-lifecycle-qualification.ts)
step: `/new`, two synthetic messages, `/fork`, stop and revocation, `--continue` relaunch, then
stop and revocation again. Keystrokes go to the existing `ssh -tt` stdin, not a production
gateway input path. Each rotation requires the same instance and generation + 1, stale launch
POSTs returning `409 generation_mismatch` without a capability, and current View/Control launches
returning `200 no-store`. Resume requires a new instance at generation 1, the same label, and
live launches returning `200`. Rewind is excluded because it is not gateway-visible.

Evidence is additive at `ompPublication.evidence.lifecycle`, with `newGeneration`, `fork`, and
`resumed` records containing booleans/counts only. The receipt schema stays 3. An interrupted step
leaves the lane non-passed, and the whole lifecycle reruns on resume. Prove the step before a
campaign with the development entry point:

```sh
bun scripts/omp-lifecycle-development.ts --omp <absolute path to stock OMP dist/cli.js>
```

The development runner uses an isolated loopback gateway in `dev-localhost` mode, private discovery
and OMP HOME directories, and a Python `pty.fork` host with PTY stdin and stdout/stderr discarded
to `/dev/null`, matching the campaign `ssh -tt` wrapper. It prints only evidence JSON and removes
everything it started. It does not qualify the retained Mac or a signed candidate.

### Tested evidence — 2026-10-01

- On macOS with Bun 1.4.2, the canary passed three consecutive runs on stock OMP 18.4.8 and one
  on stock 18.1.20; the daily `canary-windows` lane subsequently passed in CI (for example run
  `37140425389` on stock OMP `18.5.1`).
- The Mac lifecycle development runner passed three consecutive runs on stock 18.4.8. A
  deliberately rejected wrong-version run also left nothing behind after cleanup.
- These local runs are **tested evidence** only; each stable campaign qualifies the lifecycle
  transitions on its exact signed candidate (passed for `v0.7.4` in
  [`RELEASE_STATUS.md`](RELEASE_STATUS.md)).

## Fork-era measurement archive — historical, superseded for mainline

**Every command, setting, path, measured transition, and conclusion below is fork-era evidence**
from the named 2026-08-20 runtime. It retains its original dates, digests, limitations, and
observations; it does not describe the shipping prerequisite or qualify mainline behavior.
Publisher endpoint settings, socket-close removal, token proofs, and push-era timing apply only
to that historical build. Use [OMP_INTEGRATION.md](OMP_INTEGRATION.md) for the current contract.


Two OMP lifecycle transitions — `/branch` and saved-session resume — measured against the live
tailnet gateway on 2026-08-20, using scratch OMP sessions created under `/tmp` and read-only
`curl`/HTTP observation of the production daemon.

This document is the named record for those measurements. It does not promote any ledger row. Every
value below was read off a timestamped observation; the lead decides what the numbers mean.

## 1. Why this lane exists

Blocker 4 of [`RELEASE_STATUS.md`](RELEASE_STATUS.md) reads, verbatim:

> the candidate OMP path passes branch, saved-session resume, and applicable default-relay
> connectivity scenarios without exposing a stale capability. Switch ordering, socket-close crash
> removal, and TTL-sweeper expiry were measured at the `v17.3.8` pin on 2026-08-19 and are recorded
> above; **branch and resume still need a session carrying real conversation history**.

The emphasis is the whole difficulty. An earlier attempt used an empty scratch session, where
`/branch` is a no-op: `showUserMessageSelector()` short-circuits with `No messages to branch from`
when `getUserMessagesForBranching()` is empty, and `showTreeSelector()` short-circuits with
`No entries in session`. Nothing is revoked, nothing is republished, and the measurement is vacuous.

So this lane's first job is to *manufacture real history* — drive a scratch session through actual
model turns, prove on disk that user messages exist, and only then branch.

The security property under test is ordering, not merely rejection: generation N must stop being
launchable **before** generation N+1 becomes visible. If the two overlapped, a phone holding a stale
card could trade it for a live capability during the window. The worst case is a stale **control**
capability, so both modes are probed at the stale generation.

## 2. What was under test

| Component | Value |
|---|---|
| Host | macOS 26.6.1 (`25G76`) arm64, Bun 1.3.14 |
| Gateway daemon | PID 12327, `0.1.0-2813d6b23306`, started 05:45:08 local, unrestarted throughout |
| Active pointer | `installation/current.json` → `{"versionDirectory":"0.1.0-2813d6b23306"}` |
| Listener | `127.0.0.1:4317`, `auth.mode = tailscale-serve` |
| Observed origin | this workstation's canonical Tailscale Serve origin, `https://<host>.<tailnet>.ts.net`; the literal value is `http.publicOrigin` in the operator's `config.json` and is deliberately not written here |
| OMP build | `~/.local/lib/omp-code-mode/releases/17.3.8-f4acd6b19e5b6382de857c6814162e551526d27f46549a6569260ad24ab96e39` (pin `v17.3.8` / `858f7dd9`) |
| Publisher settings | host `config.yml`: `collab.autoStart: control`, `collab.registryEndpoint: auto` |
| Scratch model | `openai-codex/gpt-5.6-luna:low` (cheapest configured role; prompts are one word) |

Every scratch OMP process was launched identically, with a working directory under `/tmp` and a
deliberately minimal environment:

```sh
env -i HOME=~ \
       PATH=~/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
       TERM=xterm-256color LANG=en_US.UTF-8 \
       TMPDIR=/var/folders/bw/9_6b87vx17v6n5st9ght7f840000gn/T/ \
       ~/.local/bin/omp --model openai-codex/gpt-5.6-luna:low [--resume <session-id>]
```

`TMPDIR` is load-bearing and easy to lose. On darwin the rendezvous point is
`$TMPDIR/omp-session-gateway-$(id -u)/registry.sock` — verified present on this host, inode
286216800, mode `srw-------`, created 05:45 with the daemon. An `env -i` launch that omits `TMPDIR`
therefore resolves a different endpoint, and by design the publisher then fails quiet rather than
disturbing OMP: a missing gateway must never break normal operation. That failure mode is lane
practice carried in from the operator, not something re-measured here; every launch below set the
variable.

`HOME` is deliberately the *real* home: the session needs the
host's real credentials and the real `collab` settings to be the thing under test. The isolation in
this lane is the working directory and the process lifetime, not the home directory.

### 2.1 Reaching the real `/branch` path, and the one deviation

`/branch` is not a single code path. Its handler branches on a setting:

```ts
// packages/coding-agent/src/slash-commands/builtin-registry.ts
name: "branch",
handleTui: (_command, runtime) => {
  if (settings.get("doubleEscapeAction") === "tree") runtime.ctx.showTreeSelector();
  else runtime.ctx.showUserMessageSelector();
}
```

`doubleEscapeAction` defaults to `"tree"`, the host's `~/.omp/agent/config.yml` does not set it, and
the sealed Code Mode config (`runtime/config/code-mode-routed.yml`) does not set it either. So on
this workstation, unmodified, `/branch` opens the **tree selector** and lands on
`session.navigateTree()` — the patch's `"tree navigation"` reason — rather than on
`session.branch()`, the patch's `"branch"` reason.

The intended lever was a per-invocation `--config` overlay. That is unavailable: the Code Mode
launcher owns the flag and refuses it outright, exit 70 —

```
omp-code-mode: config and extension arguments are owned by the launcher; refusing --config
```

— because config and extension arguments are the ones its activation preflight verified. The
alternative levers were rejected: `app.session.fork`, which opens the user-message selector
directly, has no default key and the host binds none; and editing the global `config.yml` would
change behaviour for the founder's live sessions, which this lane must not touch.

The deviation actually taken: a **project-scoped** settings file inside the scratch working
directory only.

```jsonc
// /tmp/omp-lifecycle-qual/work/.cursor/settings.json
{ "doubleEscapeAction": "branch" }
```

This is OMP's own project-level precedence layer, not a patch: `#loadProjectSettings()` calls
`loadCapability(settingsCapability.id, { cwd })` and deep-merges every item whose `level` is
`"project"`, and the Cursor provider contributes `<cwd>/.cursor/settings.json` parsed as raw JSON
with no key filtering. Since `doubleEscapeAction` is unset at user level, the project value wins
over the default. The file lives in a `/tmp` directory that was deleted at the end of the run and
nothing outside that directory was modified.

Consequence for reading section 3: the transition measured there is `session.branch()`, driven from
the user-message selector, which is the genuine "branch this conversation at an earlier message"
operation. The tree-navigation spelling of `/branch` that this host would use by default is **not**
covered — see [section 6](#6-what-this-lane-does-not-cover).

### 2.2 A concurrent condition that reshaped the run

Between 14:59:19Z and 15:19:56Z the directory went from six cards at revision 14 to zero at revision
21 and stayed empty for over 90 s, including the scratch session's own card. This was not caused by
this lane, which had issued only `GET`s and one `POST` that returned `404`. The daemon had not
restarted — PID 12327 up since 05:45:08, still bound to the same socket inode, and a raw `connect()`
to it succeeded — and 26 `omp-code-mode` processes were still alive, so publishers had left the
registry with their processes intact.

Two facts settled it. Restarting the scratch session published immediately (revision 21 → 22), which
proves the socket, mutual authentication, token, registry and Serve path were all healthy; and the
lead identified the stuck publishers as [#61](https://github.com/alphastorm/omp-session-gateway/issues/61)
residue in processes that predate the fix being activated on this workstation, plus one card that was
their own soak host faulting under repeated launch probes. Those diagnoses are theirs, recorded here
because they explain the run's shape rather than because this lane measured them.

The consequence for this document: the branch measurement runs on the **restarted** scratch session,
`6f9d137d-…`, not on the original `03be1cfa-…`. That original instance was probed after its card had
gone and returned `404` for both view and control at 15:28:28Z. Everything in sections 3 and 4 was
measured after the restart, against a directory the lane had entirely to itself.

## 3. Branch

### 3.1 Real history first

The scratch session was driven through two complete model turns:

| Turn | Prompt | Reply | Session entry |
|---|---|---|---|
| 1 | `Reply with exactly the single word: alpha` | `alpha` | user `8924c972` → assistant `b8911987` |
| 2 | `Reply with exactly the single word: bravo` | `bravo` | user `15414632` → assistant `624eb3d1` |

On disk, in
`~/.omp/agent/sessions/--private-tmp-omp-lifecycle-qual-work--/2026-08-20T14-57-00-625Z_01a01fac-e8d1-7000-a662-da5009d3e9ae.jsonl`,
session id `01a01fac-e8d1-7000-a662-da5009d3e9ae`. Two `message` records with `role: "user"` is
exactly what `getUserMessagesForBranching()` reads, so the selector had to be populated.

It was. `/branch` rendered:

```
 Select a message to create a new branch from that point
  Reply with exactly the single word: alpha
› Reply with exactly the single word: bravo
 Branch from Message
```

Two selectable entries, the most recent pre-selected — the component starts at
`filteredMessages.length - 1`. This is the observation the earlier attempt could not make, and it is
the precondition for everything below.

A single `ENTER` accepted the highlighted entry, calling `session.branch(entryId)`.

The branch produced a **new session file**,
`2026-08-20T15-31-04-917Z_01a01fcc-1a55-7000-b924-160141b9ab2d.jsonl` (created 15:31:04.917Z),
carrying the `alpha` exchange forward — entry ids `8924c972` and `b8911987` preserved verbatim — and
excluding the message branched from, whose text was returned to the editor. The original session
file was left intact. That is a real branch of real history, not a restart.

### 3.2 Ordering at the transition

Instance `6f9d137d-c1d2-47de-9af0-75aca9e10160`, stale generation 1. The directory was polled every
250 ms; launch probes were interleaved, alternating stale and current generation once the record
changed. Timestamps are UTC, millisecond resolution, as recorded.

```
15:30:07.478Z  DIR    rev=22  card present, gen1, canView=true canControl=true
15:30:07.488Z  LAUNCH gen1 view -> 200  len=66  sha256:26726748a454ca7f
15:30:19.507Z  LAUNCH gen1 view -> 200  len=66  sha256:26726748a454ca7f
15:30:31.540Z  LAUNCH gen1 view -> 200  len=66  sha256:26726748a454ca7f
15:30:43.598Z  LAUNCH gen1 view -> 200  len=66  sha256:26726748a454ca7f
15:30:55.659Z  LAUNCH gen1 view -> 200  len=66  sha256:26726748a454ca7f
               --- ENTER accepted the branch target ---
15:31:05.014Z  DIR    rev=23  card ABSENT
15:31:05.027Z  LAUNCH gen1 view -> 404  not_found
15:31:05.579Z  LAUNCH gen1 view -> 404  not_found
15:31:05.847Z  DIR    rev=24  card present, gen2, canView=true canControl=true
15:31:05.859Z  LAUNCH gen1 view -> 409  generation_mismatch
15:31:06.407Z  LAUNCH gen2 view -> 200  len=66  sha256:b4cc71bd7b2ed768
15:31:06.956Z  LAUNCH gen1 view -> 409  generation_mismatch
15:31:07.508Z  LAUNCH gen2 view -> 200  len=66  sha256:b4cc71bd7b2ed768
15:31:08.060Z  LAUNCH gen1 view -> 409  generation_mismatch
15:31:08.606Z  LAUNCH gen2 view -> 200  len=66  sha256:b4cc71bd7b2ed768
15:31:09.162Z  LAUNCH gen1 view -> 409  generation_mismatch
15:31:09.711Z  LAUNCH gen2 view -> 200  len=66  sha256:b4cc71bd7b2ed768
15:31:10.262Z  LAUNCH gen1 view -> 409  generation_mismatch
15:31:10.815Z  LAUNCH gen2 view -> 200  len=66  sha256:b4cc71bd7b2ed768
15:31:11.093Z  LAUNCH gen1 view -> 409  generation_mismatch
15:31:23.152Z  LAUNCH gen1 view -> 409  generation_mismatch
15:31:35.177Z  LAUNCH gen1 view -> 409  generation_mismatch
15:31:40.786Z  DIR    rev=25  card ABSENT
15:31:40.800Z  LAUNCH gen1 view -> 404  not_found
15:31:41.064Z  DIR    rev=26  card present, gen2
15:31:41.077Z  LAUNCH gen1 view -> 409  generation_mismatch
15:31:41.630Z  LAUNCH gen2 view -> 200  len=66  sha256:b4cc71bd7b2ed768
   … four further gen1 409 / gen2 200 pairs …
15:31:46.026Z  LAUNCH gen2 view -> 429  rate_limited
15:32:11.520Z  LAUNCH gen1 view -> 409  generation_mismatch
15:32:23.575Z  LAUNCH gen1 view -> 409  generation_mismatch
15:32:35.641Z  LAUNCH gen1 view -> 409  generation_mismatch
```

The stale-**control** probe, deliberately held back until the launch rate budget refilled:

```
15:34:12.090Z  DIR    rev=26  card present, gen2, canView=true canControl=true
15:34:12.124Z  LAUNCH gen1 view    -> 409  generation_mismatch
15:34:12.136Z  LAUNCH gen1 control -> 409  generation_mismatch
15:34:12.147Z  LAUNCH gen2 view    -> 200  len=66  sha256:b4cc71bd7b2ed768
15:34:12.159Z  LAUNCH gen2 control -> 200  len=87  sha256:7be0fffb66f71fef
```

### 3.3 What those numbers prove

- **Revocation strictly precedes publication.** Generation 1 stopped being launchable at
  15:31:05.027Z (`404`, the record was gone) and generation 2 first became visible at 15:31:05.847Z.
  That is an **833 ms** window in which the old generation was already dead and the new one did not
  yet exist. The sequence is `200 → 404 → 409`, never `200 → 200`, and the directory never showed
  two generations at once. A phone holding a generation 1 card could not have traded it for a
  generation 2 capability at any observed instant.
- **The worst case is refused.** A stale **control** launch at generation 1 returned `409
  generation_mismatch` while generation 2 was live and `canControl: true`. Both modes fail closed at
  the stale generation; mode availability on the new record does not resurrect the old one.
- **The new generation is a different secret.** Generation 1's view capability digested to
  `sha256:26726748a454ca7f` at every probe across 48 seconds; generation 2's digested to
  `sha256:b4cc71bd7b2ed768`. The branch replaced the collaboration host rather than re-advertising
  the previous links. View is 66 characters, control 87.
- **The refusal is durable, not a race artifact.** Generation 1 was still `409` at 15:32:35.641Z,
  90 seconds after the branch.
- **Launch responses stay `no-store`.** Every `200` carried `cache-control: no-store, max-age=0`
  with body keys exactly `capability, generation, mode`. No capability appears in a URL component.
- **A second revoke/publish pair follows, at the same generation.** At 15:31:40.786Z the record
  disappeared again (rev 25) and returned at generation 2 (rev 26) 278 ms later, with the *same*
  capability digest `sha256:b4cc71bd7b2ed768`. This is a re-announcement of the same host, not a new
  secret, and it also revokes before it republishes: generation 1 read `404` inside that window too.
  Whatever drives it — post-switch metadata reconciliation is the obvious candidate — it does not
  weaken the ordering property, and it does mean a branch produces two directory-visible removals
  rather than one.
- **`429` at 15:31:46.026Z is the gateway's own bound, not a failure.** `LaunchRateLimiter` allows
  20 launches per 60 s per (identity, instance). The burst spent the budget; the probe schedule was
  designed around it and the stale-control probe was taken in a fresh window.

## 4. Saved-session resume

Three transitions were measured across three process lifetimes, all resuming the branched session
`01a01fcc-1a55-7000-b924-160141b9ab2d` in the same `/tmp` working directory.

Before the first clean exit, the branched session was given a third real turn, unintentionally: the
branch had pre-filled the editor with the branched-from text, so the first `/exit` was appended to it
and submitted as a prompt (`Reply with exactly the single word: bravo/exit`, replied at 15:35:08Z).
It is recorded here because it is in the session file and because it explains why the transcript
below reads oddly. A second, standalone `/exit` performed the clean shutdown.

### 4.1 Clean exit removes the card, and the pre-exit generation dies with it

First cycle, instance `6f9d137d-c1d2-47de-9af0-75aca9e10160` at generation 2 — the post-branch
generation:

```
15:35:01.707Z  DIR    rev=26  card present, gen2
15:35:01.722Z  LAUNCH gen2 view -> 200  len=66  sha256:b4cc71bd7b2ed768
   … 17 further gen2 probes, all 200, same digest, through 15:38:17.805Z …
               --- /exit ---
15:40:33.517Z  DIR    rev=27  cards=0
15:40:33.5Z    LAUNCH gen2 view    -> 404  not_found   ┐ one batch, issued back to back
15:40:33.5Z    LAUNCH gen2 control -> 404  not_found   │ within the same second; per-probe
15:40:33.5Z    LAUNCH gen1 view    -> 404  not_found   ┘ timestamps were not captured
```

Second cycle, instance `439aa68d-d450-4a14-8bca-869b6f795024` at generation 1, with millisecond
coverage across the removal:

```
15:43:42.547Z  DIR    rev=28  card present, gen1, canView=true canControl=true
15:43:42.560Z  LAUNCH gen1 view -> 200  len=66  sha256:27af6a28c6af6b7d
15:43:54.808Z  LAUNCH gen1 view -> 200  len=66  sha256:27af6a28c6af6b7d
15:44:06.860Z  LAUNCH gen1 view -> 200  len=66  sha256:27af6a28c6af6b7d
               --- /exit submitted ~15:44:05Z ---
15:44:18.081Z  DIR    rev=29  cards=0
15:44:18.093Z  LAUNCH gen1 view -> 404  not_found
   … 12 further probes through 15:45:47.563Z, every one 404 …
```

Removal is pinned to 15:44:18.081Z ± 250 ms by the directory poll, and the first stale probe 12 ms
later already read `404`. The `/exit` submission time is the fuzzy end: it is derived from the
supervisor reporting 2 m 54 s of uptime at the moment the keystroke was written, against a process
start of approximately 15:41:11Z, so roughly **13 s** elapsed between the command and the card
disappearing. That interval is OMP's own shutdown work — flush, teardown — and not gateway latency;
the registry acts on socket close. The 35-second TTL was never reached in either cycle, so this is
socket-close removal, not expiry.

Exit code was 0 in both cycles. The process exited cleanly; the card did not linger.

### 4.2 Resume republishes on a fresh instance at generation 1

```
15:41:09.700Z  DIR    rev=27  cards=0, pre-exit instance 6f9d137d ABSENT
15:41:09.713Z  LAUNCH 6f9d137d gen2 -> 404  not_found
15:41:21.767Z  LAUNCH 6f9d137d gen2 -> 404  not_found
               --- omp --resume 01a01fcc-… started ~15:41:11Z ---
15:41:28.699Z  DIR    rev=28  card present: 439aa68d@gen1 [work]
15:41:33.815Z  LAUNCH 6f9d137d gen2 -> 404  not_found
   … five further probes through 15:42:58.154Z, every one 404 …
```

And the second resume, of the same saved session, after the second clean exit:

```
15:45:29.411Z  DIR    rev=29  cards=0, pre-exit instance 439aa68d ABSENT
15:45:29.424Z  LAUNCH 439aa68d gen1 -> 404  not_found
15:45:41.468Z  LAUNCH 439aa68d gen1 -> 404  not_found
               --- omp --resume 01a01fcc-… started ~15:45:31Z ---
15:45:48.133Z  DIR    rev=30  card present: 162db4b4@gen1 [work]
15:45:53.491Z  LAUNCH 439aa68d gen1 -> 404  not_found
   … six further probes through 15:47:17.960Z, every one 404 …
```

Final state of the resumed instance `162db4b4-fe7e-407c-a1a6-0c868add0051`, at 15:47:07.158Z:

```
gen1 view    -> 200  len=66  sha256:3d6a8529e60d6341   cache-control: no-store, max-age=0
gen1 control -> 200  len=87  sha256:cab5acd27e2d6fe6   cache-control: no-store, max-age=0
gen2 view    -> 409  generation_mismatch
439aa68d gen1 control -> 404  not_found
```

The resumed process carried the branched history: its transcript rendered the `alpha` exchange and
the `bravo/exit` exchange, i.e. resume restored real conversation history rather than an empty
session.

### 4.3 What those numbers prove

- **Resume republishes, on a new identity, at generation 1.** Three process lifetimes over the same
  saved session produced three distinct instance ids — `6f9d137d…`, `439aa68d…`, `162db4b4…` — each
  advertising **generation 1**. The publisher's instance id is `randomUUID()` per controller, so it
  is per-process and not derived from the session id. That matters: if it were session-derived, a
  resume would land on the same `(instance, generation)` pair a stale card already names, and the
  stale card would start resolving to the new session's live capability. It does not.
- **The pre-exit generation never becomes launchable again.** Across both cycles, the pre-exit
  `(instance, generation)` pair returned `404 not_found` on every one of 41 probes — 12 for the
  first cycle's pair, 29 for the second — spanning 15:40:33Z–15:47:07Z, including after the
  replacement card was live. `404` rather than `409` is the correct non-enumerating answer here:
  the instance is gone entirely, not merely superseded.
- **A stale control capability is refused after resume too.** The last probe in section 4.2 is
  specifically `control` at the pre-exit instance: `404`.
- **Republication is not instant, and does not need to be.** The card appeared about 18 s and about
  17 s after process start in the two cycles — OMP startup plus collaboration-host connection, since
  registration deliberately happens only after the host connects. During that gap the directory
  simply had no card, which is the safe state.
- **A future generation is refused.** `gen2` on a live generation-1 record returned `409
  generation_mismatch`, so a card cannot be forged forward any more than backward.

## 5. Secret handling in this lane

- No capability was ever written to disk, logged, or pasted. The poller records only HTTP status,
  the response's body key names, the capability's **byte length**, and `sha256:` plus the first 16
  hex characters of its digest. Digests are the only capability-derived values in this document.
- The six distinct capabilities observed are listed by digest and length only: `26726748a454ca7f`
  (66, view), `b4cc71bd7b2ed768` (66, view), `7be0fffb66f71fef` (87, control), `27af6a28c6af6b7d`
  (66, view), `3d6a8529e60d6341` (66, view), `cab5acd27e2d6fe6` (87, control). All belong to scratch
  sessions that no longer exist, so all are revoked.
- `/collab` was deliberately **never** run. Under a supervised process its output would be captured,
  and `SECURITY.md` §11 records that upstream's manual `/collab` prints the full capability to the
  terminal by design — the exact 2026-08-19 incident. Auto-publication via
  `collab.autoStart: control` needs no such command.
- The publisher token was never read, and `config.json` was read for `http.publicOrigin`,
  `http.port` and `auth.mode` only.
- All observation was `GET /api/v1/sessions` and `POST …/launch`. Nothing in this lane mutated
  gateway state.
- Aggregate over the whole lane: **39** `200`, **48** `404 not_found`, **19** `409
  generation_mismatch`, **3** `429 rate_limited`. Every `200` carried `cache-control: no-store,
  max-age=0` and body keys exactly `capability, generation, mode`. No `200` was ever returned for a
  stale generation or a removed instance.

## 6. What this lane does not cover

- **The tree-navigation spelling of `/branch`.** This host's `doubleEscapeAction` default of
  `"tree"` routes `/branch` to `showTreeSelector()` and `session.navigateTree()`; the run here
  overrode the setting in a scratch project file to reach `session.branch()`. The patch hooks both
  (`"branch"` and `"tree navigation"` both call `#reconcileSessionSwitch`), but only the `"branch"`
  reason was executed. The default path an operator would hit on this workstation is untested, and
  its extra summarize prompt (`branchSummary.enabled`) is an untested code path on top of that.
- **`/fork`, `/btw`, `/new`, and handoff.** All four are separate reasons through the same
  reconciler. `/new` was measured on 2026-08-19 and is already in the ledger; the other three are
  not measured anywhere.
- **In-session `/resume <id>`.** Only exit-then-resume-in-a-new-process was measured. `/resume`
  issued *inside* a live session is a generation bump on the same instance — structurally the branch
  case — and was not exercised.
- **The sub-250 ms interior of the revocation window.** The directory poll bounds the ordering at
  250 ms and the launch probes at ~550 ms. An overlap shorter than one poll interval would not have
  been seen. The `404` observations make an overlap unlikely rather than impossible, and 833 ms of
  measured gap is comfortably wider than the sampling error.
- **No browser and no phone.** Every observation is `curl` against the tailnet origin. Nothing here
  says anything about the PWA's handling of a stale card, about Android, or about any forbidden
  browser sink. The capability-leak matrix is untouched.
- **One session, one branch depth, one relay.** A single branch from a two-turn transcript. No deep
  tree, no repeated branching, no branch during an active turn or a pending attention request, and
  no relay-room behaviour was inspected — the default relay was in use but not measured.
- **Crash-path resume.** Both exits were clean `/exit` with exit code 0. Resume after a `SIGKILL`,
  after TTL expiry, or with the gateway down at resume time is untested.
- **Removal latency is a bound, not a figure.** The ~13 s exit-to-removal interval mixes OMP's
  shutdown with the registry's reaction and rests on a supervisor uptime reading, not a captured
  process exit timestamp. Treat the millisecond values as reliable and the interval as approximate.
- **This is one host, one build, one day.** macOS 26.6.1 arm64, gateway `0.1.0-2813d6b23306`, OMP
  release `17.3.8-f4acd6b19e…`. Nothing here re-runs any other platform row at the `v17.3.8` pin.

## 7. Which ledger rows these observables bear on

They **bear on**, without promoting:

- **Blocker 4** — the direct target. Its remaining clause is *"branch and resume still need a
  session carrying real conversation history"*. A session with two real model turns was branched
  from a populated selector, and a saved session with that history was resumed twice, with stale
  view and stale control refused at every step. On the evidence here the clause is satisfiable for
  the `session.branch()` spelling of branch and for exit-then-resume; the default tree-navigation
  spelling of `/branch` and the default-relay half of the blocker are not addressed.
- **Real lifecycle revocation (PARTIAL)** — adds branch and resume to the switch, crash, and TTL
  orderings already recorded at this pin, with the same `200 → 404 → 409` shape and an explicit
  stale-control probe.
- **Capability non-persistence (PARTIAL)** — adds that launch stays `no-store, max-age=0` with body
  keys `capability, generation, mode` on all 39 `200` responses issued in this lane, and that a
  generation replacement
  mints a different secret. It adds no browser-sink evidence.

They explicitly **do not bear on** Android rows, browser rows, host lifecycle rows, Tailscale
authorization, or the relay soak.

Per the ledger's updating rule, the row text is the lead's to change; this document is the named
record such a change would cite.

## 8. Reproducing it

1. Create a scratch working directory under `/tmp`. To exercise `session.branch()` rather than tree
   navigation, add `{"doubleEscapeAction":"branch"}` at `<scratch>/.cursor/settings.json`; the Code
   Mode launcher refuses `--config`, so a per-invocation overlay is not available.
2. Launch OMP with the `env -i` line in [section 2](#2-what-was-under-test), working directory set
   to the scratch directory. Confirm the card appears in `GET /api/v1/sessions`.
3. Drive at least two one-word turns. Confirm on disk that the session `.jsonl` under
   `~/.omp/agent/sessions/<slugified-cwd>/` holds `message` records with `role: "user"`, then run
   `/branch` and confirm the selector lists them. If it says `No messages to branch from`, stop —
   the measurement would be vacuous.
4. Poll `GET /api/v1/sessions` at 250 ms and interleave `POST …/launch` with
   `Origin:` set to the exact `http.publicOrigin` from the gateway's `config.json`,
   `Content-Type: application/json` and body
   `{"generation":N,"mode":"view"|"control"}`. Budget the probes: 20 launches per 60 s per
   (identity, instance), and take the stale-control probe in a fresh window.
5. Accept the branch with `ENTER`, then `/exit`, then relaunch with
   `--resume <session-id>`. Record the digest and byte length of any capability; never the value.
6. Note that after a branch the editor is pre-filled with the branched-from text, so a following
   slash command will be appended to it and submitted as a prompt. Clear the editor first.
7. Remove the scratch directory and the `~/.omp/agent/sessions/<slugified-cwd>/` directory when
   done.

## 9. Related documents

- [`RELEASE_STATUS.md`](RELEASE_STATUS.md) — the ledger; the only place a row's status changes.
- [`TEST_PLAN.md`](TEST_PLAN.md) — scenario C, lifecycle correctness, and gate 3, "old generations
  are unlaunchable before replacements become visible".
- [`SECURITY.md`](SECURITY.md) — §6 capability handling, §11 and its `/collab` boundary note.
- [`OMP_INTEGRATION.md`](OMP_INTEGRATION.md) — the controller contract that requires revoking
  generation N before publishing N+1 on switch, branch, resume, and tree navigation.
- [`UPGRADE_ROLLBACK.md`](UPGRADE_ROLLBACK.md) — the sibling lane for installer state; it explicitly
  covers no OMP publisher, so the two do not overlap.
