# `packages/collab-client`

Pinned integration of OMP's existing `packages/collab-web` source at tag `v18.12.6`, commit
`45c35e40c46166dc726ccc52f5d27f40f2449f99`. The upstream collab package remains version
`16.3.6`; `@oh-my-pi/pi-wire` is pinned exactly to `18.12.6`. The collaboration protocol and
relay framing are unchanged; the wire barrel's unrelated TSP runtime is not bundled.

These are browser-client provenance pins, independent of both the minimum supported OMP host
version (`>= 18.1.20`) and the root `UPSTREAM.lock.json` engineering host baseline (`v18.12.5`).
The gateway consumes the native registry and controller in stock OMP `>= 18.1.20` without a fork,
custom OMP build, or gateway-specific OMP plugin, while this package pins the embedded browser
client at `v18.12.6`. See [OMP_INTEGRATION.md](../../docs/OMP_INTEGRATION.md) for integration and
deployment scope.

The local patch passes the capability directly into the root `App` component. The installed PWA
mounts that component in its current document so Android standalone navigation does not depend on
`window.opener`. Embedded gateway mode suppresses the client's competing header, rail, connect
screen, and lifecycle overlays while retaining its transcript, tool cards, agent drill-down, and
sole composer; an active Ask uses that composer rather than a duplicate shell control. OMP's
π artwork is excluded: `OmpMark.tsx` is not vendored, and HeaderBar/ConnectScreen do not import or
render it, and the web build rejects its SVG path if it re-enters the bundle. Capabilities remain
in client memory, and leaving or reloading returns to the gateway
without writing them into a URL, DOM attribute, browser storage, or service-worker cache.
Foreground, BFCache restore, online, and Network Information transitions replace a potentially
stale relay transport. A metadata-free same-origin health probe forces one replacement after an
observed gateway outage recovers; established guests retain bounded relay room recovery.

Embedded recovery probes the launching gateway through an injected selected-source callback and
treats a readable authorization loss as terminal for automatic recovery, allowing a fresh probe
only on foreground, pageshow, or online transitions. Non-embedded callers retain the same-origin
health probe.

The embed state includes required `loading: { received, total } | null` snapshot counters,
without transcript entries. The gateway's sole chip displays **Joining session…** before the
first live connection or **Reconnecting…** afterward, with a floored, clamped percentage only
for valid positive totals. Existing authorization, ended, and sustained-outage messaging keeps
priority; unchanged copy does not repeat live-region announcements.

An optional `takeInitialPromptDraft()` callback drains a shell-owned volatile first-task draft.
Composer calls it once only in live writable Control with a healthy relay, no active Ask, an
empty ordinary text draft, and no photo draft, photo preparation, or pending photo send. It
updates only the ordinary composer text: never Ask input, never a prompt submission, and never
an overwrite. Reconnects, Ask transitions, clearing the draft, and rerenders do not seed again.
The shell binds and clears its holder on disposal; no draft enters storage or gateway requests.

The 18.12.6 refresh brings upstream render coalescing and streaming-tail Markdown parsing
([#14728](https://github.com/can1357/oh-my-pi/pull/14728)), linear-time Markdown/math lexing
([#13961](https://github.com/can1357/oh-my-pi/pull/13961),
[#14667](https://github.com/can1357/oh-my-pi/pull/14667)), idle agent-drawer polling shutdown,
and the eval renderer's printed table/JSON/Markdown views. Streaming updates publish at most
once per animation frame; other frames flush synchronously. Memoized Composer/HeaderBar props
remain stable across unrelated stream updates, including gateway Ask/photo/speech inputs.
Snapshot chunks buffer inside upstream's guest replica and publish once
on the final chunk or promised entry count, with live entries appended after the snapshot and
finished stream ghosts cleared even when their entries arrive mid-snapshot. The transcript stays
mounted and the last published rows remain visible during resynchronization, replacing the local
first-paint hold. Upstream's separate committed-tool scan avoids rescanning the full transcript on
each streamed token.

The local explicit `Show earlier` window remains: newest 150 entries initially, 300 more per tap,
with an anchored oldest entry and scroll position. Unlike upstream's automatic near-top expansion
and tail re-windowing, this retains an expanded window across live appends and reconnects, and
pairs tool results across the entire retained history. Initial and recovered `live` transitions
still return the main transcript to its tail without discarding that window. A monotonic live
epoch preserves this edge even when React batches recovery with the first streamed commit; the compact agent
transcript remains independent. The `wait` renderer and the retained hub-family renderers
(`hub`, `irc`, `job`, `await`, `poll`, `cancel_job`) support older host releases.

LaTeX delimiters render through KaTeX `0.18.5` as native MathML with `trust: false`; no KaTeX
stylesheet, font URL, or remote asset is emitted. The browser bundle vendors the six pure
TypeScript marked-fork, list-continuation, and math-grammar sources from pi-utils `18.12.6`,
including its source-context and `startFrom` hooks. This replaces npm `marked` without installing
pi-utils or pi-natives. Original Marked/Markdown and fork licences are retained in
`licenses/pi-utils-marked/LICENSE`. Rejected currency openers and half-streamed delimiters keep
their existing semantics, now supplied by upstream rather than a local npm-parser adapter.
Markdown links in both settled and streaming blocks use the same browser URL parser
before the HTTP(S)/mailto allowlist, rejecting control-character-obfuscated unsafe schemes while
retaining relative links and fragments. All runtime assets remain first-party.

Both text stacks fall back to `"Symbols Nerd Font Mono"` immediately before their generic family.
The gateway's self-hosted, unicode-range-limited face supplies only Private Use Area glyphs (for
example, icons printed by `ls`/`eza`); ordinary text stays on system fonts. The client defines no
font face and loads no fonts of its own.

Control sessions expose the existing OMP v3 `prompt.images` path as a phone-first photo action.
The Photo action opens an explicit two-choice panel: **Take photo** invokes a rear-camera capture
input, while **Choose existing** opens the ordinary photo library/file picker. The browser rejects
source dimensions above an 8,192px edge or 20 megapixels and normalizes up to four JPEG, PNG, or
WebP inputs to metadata-free JPEGs with a 2,048px edge and 1 MiB per-image cap. Volatile previews
stay available until the host echoes the sent transcript entry; a lost send retains the exact
draft for bounded retry. The gateway HTTP service and service worker never receive media.
Removing, acknowledged sending, or leaving drops preview references; the normalized image then
follows ordinary OMP transcript and model-provider handling on the host. View links remain
read-only at every mutating client method, and pointer capture protects mobile composer actions.

Control text composers offer dismissible keyboard-dictation guidance independently of the optional
browser recognizer. When explicitly enabled by the gateway, live Control prompt and free-text Ask
drafts offer gesture-only browser speech after a document-scoped disclosure: the browser or OS may
send audio to its speech provider. Capture is bounded to two minutes, 128 result segments, 8,000
code points, and 32 KiB of UTF-8 text. Start/stop watchdogs finalize only a review buffer; **Use text**
edits the bound draft at its current selection, and **Send** remains a separate explicit action.
Generation, Ask identity, destination, liveness, pending-response, and page lifecycle changes discard
the recording. No audio is persisted or sent to the gateway; browser support is feature-detected,
not a claim of physical-device qualification or on-device recognition.

`upstream/UPSTREAM.json` records the exact source paths, package versions, Bun `1.4.0`, and local patch list.
`upstream/LICENSE` preserves the upstream license. The build remains a narrow integration; it does not fork the
collaboration protocol or transcript UI.
