# Oh My Pi upstream strategy

This document explains how contributors and maintainers track the Oh My Pi (OMP) baseline, keep gateway policy outside stock OMP, and review dated baseline records.

## Goal

OMP Session Gateway consumes stock OMP's native collaboration registry and controller while keeping Tailscale Serve authorization, HTTP and Server-Sent Events (SSE) routing, **OMP Sessions** (the browser app), and service installers outside OMP.

Administrators install the separate gateway service, set `collab.autoStart` once ([Operator settings](OMP_INTEGRATION.md#1-operator-settings)), and launch plain `omp`. No fork, custom OMP build, gateway-specific OMP plugin, or downstream OMP patch set is maintained.

## Landed upstream seam

Stock mainline OMP `>= 18.1.20` ([PR #11908](https://github.com/can1357/oh-my-pi/pull/11908), merge `4999b98bd5`, [OMP v18.1.20](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.20)) ships the shared collaboration controller, opt-in `collab.autoStart`, the local discovery and query registry, and `omp collab list` and `omp collab link`. Earlier OMP releases lack this registry and are unsupported.

The gateway reads `~/.omp/run/collab-hosts`, queries each OMP host (one running `omp` process) for metadata snapshots, and resolves a **View** or **Control** link (a bearer secret, called a capability in [Protocol](PROTOCOL.md)) only for an explicit launch ([Mainline OMP integration](OMP_INTEGRATION.md)). It never writes OMP's discovery directory or stores capabilities; its private `readiness-token` is used only by `omp-gateway` for local loopback readiness checks.

## Integration boundaries

- Read the published endpoint and per-host query token from each discovery file verbatim, never a derived path.
- Keep `collab.autoStart` as the only required OMP setting.
- Keep HTTP/SSE, attention routing, Tailscale Serve authorization, and **OMP Sessions** in this repository.
- Keep the pinned in-memory `collab-web` integration and its provenance independently reviewable in [`packages/collab-client`](../packages/collab-client/README.md).
- Propose generally useful registry or controller improvements upstream instead of maintaining a separate transport or importing private APIs.
- Never fall back to process-memory inspection, terminal automation, QR decoding, or saved-session scraping when the query surface fails.

## Compatibility discipline

- Record exact engineering source, package, and native pins and review notes in [`UPSTREAM.lock.json`](../UPSTREAM.lock.json) ([Upstream refresh procedure](COMPATIBILITY.md#upstream-refresh-procedure)).
- Request upstream baseline refreshes through the weekly Monday `15:17 UTC` release-request workflow; see [Unattended release driver](RELEASE.md#unattended-release-driver).
- Inspect embedded browser-client and vendored-helper source drift daily (`08:23 UTC`) against published OMP releases without requesting a release; see [Source drift report and refresh](../packages/collab-client/README.md#source-drift-report-and-refresh).
- Validate discovery files, `snapshot` and `link` queries, error codes, and generation (OMP's counter that increments when a session is replaced) and access races ([Protocol](PROTOCOL.md)).
- Treat only `ENOENT` and `ECONNREFUSED` as proof that a queried OMP host is dead.
- Exercise start, stop, switch, branch, resume, and gateway restart against stock mainline OMP ([Daily upstream canary](LIFECYCLE_BRANCH_RESUME.md#daily-upstream-canary)).
- Verify link formats through the upstream link parser in [`packages/collab-client`](../packages/collab-client/README.md) without logging or storing capabilities.
- Qualify each signed release against its pinned baseline; see [Current claim](COMPATIBILITY.md#current-claim).

## Communication

Cite the merged general-purpose collaboration and discovery contribution ([PR #11908](https://github.com/can1357/oh-my-pi/pull/11908)), not an obligation for OMP to adopt the gateway. State that OMP Session Gateway is independent and community-maintained unless upstream formally adopts or endorses it.

## Baseline review record

Entries below are dated upstream compatibility reviews and are kept as written.

### v18.20.0 — 2026-11-13

`v18.20.0` (`c308970263ae13744ea15ab67302e3dac840e266`, tree `ba890953dd69eb4bf73bb7233bbe50ccfacd6912`) keeps the registry, collab settings, `docs/collab.md` and the native IPC sources byte-identical to v18.18.0, so registry v1, the discovery format, the query contract, the relay envelope and the `18.1.20` minimum are unchanged. Host per-peer backlog shedding adds `error.resync` and re-hello recovery, and `select` requests gain optional `approval` metadata without a new response shape. `packages/collab-web` changes `lib/client.ts` and the Ask and task renderers, including HTML-form Ask results; the embedded client adopts those in its own reviewed refresh. Upstream `7027a619a41c1eccdae6a5f07de91c43e2a487e3` changes the successful rewind status to `Rewound N turns`, which the canary matcher now accepts alongside the old text. Source review only: no candidate, qualification or installed-byte smoke is claimed, and published v0.11.0 keeps its v18.18.0 qualification.

### v18.18.0 — 2026-11-07

v18.18.0 (`b5a6b2f7e5b6606b6562e678ead83f21738f34a0`, tree
`cc847a53faf634167bde0ae8c12cb1d6ef38a412`) keeps those contracts unchanged from v18.17.0:
the complete `packages/coding-agent/src/collab`, `packages/collab-web`, and
`crates/pi-natives/src/ipc` trees, collaboration commands, extension UI controller,
`modes/types.ts`, `docs/collab.md`, `docs/extensions.md`, and `packages/wire/src/index.ts`
are byte-identical. Upstream
[`shell-trace.ts`](https://github.com/can1357/oh-my-pi/blob/b5a6b2f7e5b6606b6562e678ead83f21738f34a0/packages/wire/src/shell-trace.ts)
now permits `string | number[]` for non-UTF-8 bytes in bash `details.trace`, including argv,
assignments, redirections, unit source, and diagnostics. The current embedded client's JSON/AES
codec preserves these arrays; its bash renderer does not consume `details.trace` and continues
to show the command, text, images, and status badges, without shell visualization. This is a
presentation-only limitation, not an observed discovery, launch, or decoding incompatibility.
Additive bash `details.cwd` / `cdSeparator` and write `details.touchesNoFiles` are also ignored.
The embedded codec now vendors the upstream pure `asStrictBytes` helper, preserving the
whole-`ArrayBuffer` fast path and copy fallback. Bun remains `1.4.4` (upstream requires `>=1.4.4`).

The embedded v18.18.0 client (`b5a6b2f7e5b6606b6562e678ead83f21738f34a0`) adopts shared wire
envelopes, strict byte buffers, wait lists, job-intent labels and exact-width Markdown code spans.
Its seven pure pi-utils helpers have exact blob provenance; no native helper package or offline
export/trace viewer is installed. Shell-trace byte arrays remain safely ignored by the existing
live command/output renderer. Gateway in-memory bootstrap, View guards, Ask/photo/speech drafts,
bounded recovery and transcript anchoring remain local patches with named regression proofs in
`packages/collab-client/upstream/UPSTREAM.json`. The host minimum and published qualification
matrix are unchanged; source/browser regression tests are not physical-device qualification.

### v18.17.0 — 2026-11-06

v18.17.0 (`75e7801e247d4e3263439d4cc08ccad60dc64bdd`) keeps registry v1, the discovery file
format and query contract, the relay protocol, and `collab.autoStart` behavior unchanged from
v18.16.0: the collaboration host (`packages/coding-agent/src/collab/host.ts`), registry
(`registry.ts`), settings (`settings.ts`), collaboration slash commands
(`packages/coding-agent/src/slash-commands/builtin-collaboration.ts`), `docs/collab.md`,
`packages/collab-web/src/app.tsx` and `lib/client.ts`, and the `crates/pi-natives/src/ipc/`
native IPC transport (`mod.rs`, `unix.rs`, `windows.rs`) are byte-identical between the two tags.
[can1357/oh-my-pi#17960](https://github.com/can1357/oh-my-pi/pull/17960) and
[#17997](https://github.com/can1357/oh-my-pi/pull/17997) add extension transcript presenters
(`registerTranscriptPresenter`, `ctx.ui.refreshTranscript`) and route CLI guest claim and release
in `collab/guest.ts` through `ctx.setCollabGuest()`;
[#16476](https://github.com/can1357/oh-my-pi/pull/16476) adds an extension link browser that
editor-area dialogs and asks close before mounting;
[#17961](https://github.com/can1357/oh-my-pi/pull/17961) exposes `getShortcutConflict` and
keybindings to extensions; and [#17848](https://github.com/can1357/oh-my-pi/pull/17848) adds an
in-session pin indicator and `/unpin` (`notifySessionPinChanged`) while leaving `/collab`,
`/join`, and `/leave` unchanged. Upstream direct commits `488cafa0e0` and `fcdda683f1` add
`packages/wire/src/shell-trace.ts` and `shell-viz.ts` re-exports to `packages/wire/src/index.ts`
(leaving the relay envelope helpers and types unchanged), `a55b04a332` updates
`packages/wire/src/tsp.ts`, `19ef041ec5` hardens `packages/natives/test/ipc.test.ts`, and the
package manifests bump versions, none of which the gateway reads or sends; `adcb8800b6` changes a
host `wait` tool result's `details.waited` (`CoordinationDetails.waited`) from one message object
to a list of messages (`null` still means timed out) and updates `collab-web`
`tool-render/tools/irc.tsx`, so the embedded client carries a local compatibility patch in its
`irc`/`wait` renderer (`packages/collab-client/upstream/UPSTREAM.json`) to accept both the list
and the older single message. The v18.18.0 source refresh adopts that list renderer directly,
retaining only the singleton/null/empty adapter and the regression cases.

### v18.16.0 — 2026-11-02

v18.16.0 (`650f3a108229ee11bf68ba3377f4e8c3391cd424`) in turn kept these contracts unchanged from
v18.12.5: collaboration settings, slash commands, and `collab-web` `app.tsx` and `lib/client.ts`
are byte-identical, and `docs/collab.md` changes only table formatting.
[can1357/oh-my-pi#17699](https://github.com/can1357/oh-my-pi/pull/17699) rewrites registry
validation as schemas that accept the same discovery and snapshot fields, and
[can1357/oh-my-pi#17704](https://github.com/can1357/oh-my-pi/pull/17704) moves the relay envelope
helpers into `packages/wire/src/index.ts` with the same byte layout.
[can1357/oh-my-pi#16682](https://github.com/can1357/oh-my-pi/pull/16682) keeps a dialog-backed ask
pending across a host relay reconnect, so `inputRequired` may stay `true` through it;
[can1357/oh-my-pi#16957](https://github.com/can1357/oh-my-pi/pull/16957) lets the host supersede
queued streaming `message_update` frames, which the embedded client renders from each cumulative
message; and [can1357/oh-my-pi#16936](https://github.com/can1357/oh-my-pi/pull/16936) rotates the
room when a session moves to a sibling file, which the gateway sees as a session replacement. The
remaining changes touch the CLI guest, the `collab-web` export viewer, and extension and TUI
surfaces, none of which the gateway reads or sends.

### v18.12.5 and v18.12.3 — 2026-10-21 and 2026-10-19

v18.12.5 (`d5cd750e41fede277f9eb933455da92a0738915e`) in turn kept these contracts unchanged from
v18.12.3: every relevant path is byte-identical between those tags except `package.json`, which
only the version bumps change, and `docs/extensions.md`, where
[can1357/oh-my-pi#16361](https://github.com/can1357/oh-my-pi/pull/16361) documents GitLab MR
references for the extension `ctx.annotations` diff source, which the gateway neither reads nor
sends. v18.12.3 (`53a0377db6845e0dae606146130766ec92d407fd`) in turn kept these contracts
unchanged from v18.10.2: the collaboration host, registry, settings, collaboration slash commands,
`docs/collab.md`, `collab-web` `app.tsx` and `lib/client.ts`, and `packages/wire/src/index.ts`
are byte-identical between those tags.
[can1357/oh-my-pi#15680](https://github.com/can1357/oh-my-pi/pull/15680) adds an optional
`runtime` build identity to session entries, including replicated ones, which the gateway never
reads and the embedded client does not consume;
[can1357/oh-my-pi#15467](https://github.com/can1357/oh-my-pi/pull/15467) changes only a CLI
guest's prompt-cache key; and the remaining changes touch the TUI approval dialog, extension
plan-review hooks, and a `collab-web` eval renderer now included by the independent v18.12.6 client
refresh. That refresh also takes render coalescing, streaming-tail Markdown, linear-time
Markdown/math lexing, and idle agent-drawer polling shutdown. The discovery/query contract is
unchanged; browser source tests and synthetic smoke do not qualify a new signed artifact.

### v18.10.2 — 2026-10-12

Since v18.10.2, upstream
[`a608a9ca07`](https://github.com/can1357/oh-my-pi/commit/a608a9ca07c9443634e80d877d61c602099dab91)
serves the registry over native IPC with the same one-line JSON request and response, a 0600
socket, overlong paths relocated under the owner-only `/tmp/omp-<euid>`, and same-user peers
only; the gateway reads the published endpoint verbatim, so its queries are unchanged.

### v18.18.0 canary — 2026-11-07

Exact-version canary run
[42337262675](https://github.com/carrythroughsystems/omp-session-gateway/actions/runs/42337262675)
passed for stock OMP 18.18.0 on 2026-11-07 at gateway
`9a3388fd7a96342b1e31989305bf68f6d2958234` across all eleven Linux stages (`prepare`, `publish`,
`snapshot`, `stale-generation`, `view`, `control`, `new-generation`, `fork`, `branch-rewind`,
`continue`, `unregister`) and the eight supported Windows stages (with `new-generation`, `fork`,
and `branch-rewind` skipped by design on Windows) as **Tested** evidence; no candidate or
qualification is claimed for v18.18.0, and the release-generated matrix below is unchanged.
The canary does not exercise non-UTF-8 shell-trace rendering.

### v18.8.3 and v18.5.1 — 2026-10-08 and 2026-10-03

As in v18.8.3, upstream
[can1357/oh-my-pi#14714](https://github.com/can1357/oh-my-pi/pull/14714) stops mirroring frames
while no guest is joined, and a generated `sessionName` may carry a title-card prefix
([OMP integration](OMP_INTEGRATION.md#3-polling-and-lifecycle)). From OMP `18.5.1`, an automatic
start whose relay is unreachable or times out is retried
([operator settings](OMP_INTEGRATION.md#1-operator-settings)).
