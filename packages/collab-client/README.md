# `packages/collab-client`

Pinned integration of OMP's existing `packages/collab-web` source at tag `v18.4.2`, commit
`4620bb8338e0ecace7ea237da9d5088d16068617`. The upstream collab package remains version
`16.3.6`; `@oh-my-pi/pi-wire` is pinned exactly to `18.4.2`. Its wire source is unchanged
from the previous engineering baseline; no collaboration protocol or relay framing changes.

These are browser-client provenance pins, independent of both the minimum supported OMP host
version (`>= 18.1.20`) and the root `UPSTREAM.lock.json` engineering host baseline (`v18.5.1`).
The gateway consumes the native registry and controller in stock OMP `>= 18.1.20` without a fork,
custom OMP build, or gateway-specific OMP plugin, while this package pins the embedded browser
client at `v18.4.2`. See [OMP_INTEGRATION.md](../../docs/OMP_INTEGRATION.md) for integration and
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

The 18.4.x refresh brings the redesigned inset transcript/composer panel, updated tool and agent
surfaces, and upstream's coarse-pointer text sizing. The earlier local 16px text-field patch is
now upstream code. Snapshot chunks now buffer inside upstream's guest replica and publish once
on the final chunk or promised entry count, with live entries appended after the snapshot and
finished stream ghosts cleared even when their entries arrive mid-snapshot. The transcript stays
mounted and the last published rows remain visible during resynchronization, replacing the local
first-paint hold. Upstream's separate committed-tool scan avoids rescanning the full transcript on
each streamed token.

The local explicit `Show earlier` window remains: newest 150 entries initially, 300 more per tap,
with an anchored oldest entry and scroll position. Unlike upstream's automatic near-top expansion
and tail re-windowing, this retains an expanded window across live appends and reconnects, and
pairs tool results across the entire retained history. Initial and recovered `live` transitions
still return the main transcript to its tail without discarding that window; the compact agent
transcript remains independent. The `wait` renderer and the retained hub-family renderers
(`hub`, `irc`, `job`, `await`, `poll`, `cancel_job`) support older host releases.

LaTeX delimiters render through KaTeX `0.18.5` as native MathML with `trust: false`; no KaTeX
stylesheet, font URL, or remote asset is emitted. The browser bundle retains npm `marked`
`18.0.9` and the unchanged pure delimiter grammar from `@oh-my-pi/pi-utils` `18.3.0` rather
than adding that package's native dependency closure. Markdown links use the browser URL parser
before the HTTP(S)/mailto allowlist, rejecting control-character-obfuscated unsafe schemes while
retaining relative links and fragments. All runtime assets remain first-party.

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

`upstream/UPSTREAM.json` records the exact source paths, package versions, Bun `1.4.0`, and local patch list.
`upstream/LICENSE` preserves the upstream license. The build remains a narrow integration; it does not fork the
collaboration protocol or transcript UI.
