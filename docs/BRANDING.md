# OMP Session Gateway — brand & UI spec

This specification gives contributors and designers the visual identity, voice, and interface rules for `omp-session-gateway`, an independent companion to [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) for developers working in a terminal. It is visibly a *companion* and never copies upstream's mark; [ADR-049](DECISIONS.md) records the decision behind it.

The system is called **Signal**. Its one rule: the chassis is monochrome, and **color exists only
as state**. Green is live. Amber is your turn. Red is denied. If a color would not change when the
state changed, it should not be a color.

## The mark: "Portal"

An arch — a gateway, drawn as one continuous stroke — with a dot inside it: a live session on the
other side of the boundary. Geometry (96×96 viewBox, optical center 48,49):

- arch `M25 80V47a23 23 0 0 1 46 0v33`, stroke 12, butt caps, no fill
- dot `cx48 cy63 r9`

Rules:

- Never use upstream OMP's π-with-plug mark or derivatives of it.
- Clearspace: one dot diameter (18 units) on all sides. Minimum size 16px.
- The arch is Ink (`logo.svg`, for dark surfaces) or Ink on light (`logo-light.svg`). The dot is
  the live color of the surface it sits on. Never recolor the arch, add a fill, or round its feet.
- The dot is the product-wide motif: every status badge, pulse and bullet is the same circle, and
  Geist's rounded-dot set (`ss08`) makes the punctuation agree with it.
- In the app the mark reports: its dot is live while this device can reach an authorized gateway and steps back to neutral `ink-4` when it cannot, and the empty state fills its dot in `ink-4`.
- The Android status-bar badge is the same mark in solid white on transparent (`badge-96.png`).

## Color

The theme follows the system: one stylesheet, two schemes, no stored preference and no toggle.
Hierarchy comes from surface steps and type, not from hue.

| Token | Dark | Light | Use |
|---|---|---|---|
| ground | `#000000` | `#F4F4F2` | page |
| surface-1 | `#111113` | `#FFFFFF` | the one elevated card, trays |
| surface-2 | `#1C1C1F` | `#EBEBE8` | controls, tiles, inset fields |
| surface-3 | `#27272B` | `#DEDEDA` | pressed and hovered controls |
| line | white 8% | black 8% | hairlines |
| line-strong | white 17% | black 20% | grips, dashed outlines, underlines |
| ink | `#F5F5F3` | `#0B0B0C` | titles, primary actions, focus, selection |
| ink-2 | `#C9C9CD` | `#3C3C41` | body text |
| ink-3 | `#8E8E95` | `#616168` | metadata, labels; the faintest text |
| ink-4 | `#68686F` | `#86868D` | separators, quiet icons; never text |
| live | `#30D67C` | `#12A150` | a session is live; an answer was accepted |
| attention | `#FFB224` (text `#FFC24D`) | `#FFB224` (text `#8A4F00`) | your turn |
| danger | `#FF6369` (text `#FF9A9D`) | `#D92D3A` (text `#B4232E`) | access denied |

What each state color may touch:

- **Live (green):** the mark's dot, working and idle badges, the `Live · N` pill, the all-clear
  dot, the active creation step, and the drawn check after an accepted answer. Nothing else.
- **Attention (amber):** waiting and held badges, the `N waiting` pill and waiting times, the
  request tray's grip and `Input required` label, and the four actions that take the wheel:
  `Open request`, `Control`, `Create and open Control`, and `Hold → next`. A surface has at most
  one amber fill.
- **Danger (red):** an unauthorized banner, host row, connection chip or launch notice. Only a
  denial is red.
- **Everything else is ink.** Neutral primary actions (`Next`, `Done`, `Send`, `Enable background
  alerts`, `Undo`, `View transcript`, `New session` on an empty directory) are inverse ink. Focus
  rings, links, selected options, switches and text selection are ink. Faults that ask nothing of
  the operator — offline, tailnet, desktop, gateway, reconnecting — carry no color at all: the page
  loses its green, which is the signal.

Contrast floors in both schemes: every text token (ink through ink-3, attention text, danger text)
is at least 4.5:1 on ground and on surfaces 1 through 3, which `apps/web/e2e/theme.e2e.ts`
asserts; every icon or state graphic (ink-4, live) is at least 3:1 on ground and on surfaces 1
and 2, except light-scheme live on surface-2 (2.8:1), where it is always paired with its state in
words.

States never depend on hue alone: active is a filled dot and at rest is a ring, a cached row's tile
is a dashed outline, and every colored surface also carries its state in words.

The palette carries no upstream-orange accent; companionship with OMP is stated in prose.

## Type

- **Geist** for text and **Geist Mono** for identifiers, both self-hosted latin subsets vendored
  from the pinned upstream release by `scripts/vendor-geist.ts`
  (`apps/web/src/fonts/geist/`, OFL-1.1, provenance in `THIRD_PARTY_NOTICES.md`). The upright
  faces are precached with the application shell and preloaded; the italic is cached on first use.
  `font-display: swap`, system fallbacks behind them, `font-synthesis: none`.
- Mono is for things a terminal would print: host labels, project names, model slugs, the build
  hash, `code`. Words, counts, durations and labels are never mono.
- Sentence case everywhere. No tracked capitals, no uppercase eyebrows.
- Scale (app): H1 32–38px/680, tracking −0.04em; card and tray titles 20px/640; row titles
  16px/600; body 15–17px/400; metadata 13px/400–600; identifiers 12.5px mono. Figures are tabular
  wherever a number can change in place.
- OMP's terminal title icons use the self-hosted **Symbols Nerd Font Mono** subset (Private Use
  Area only, lazily loaded, ADR-039). The embedded collaboration client takes Geist for its text
  and keeps its own mono stack: tool output needs box-drawing and block glyphs at one advance
  width, which a latin subset cannot supply.
- Runtime assets remain first-party: no remote fonts, third-party scripts, or CDNs. This is a
  privacy requirement, not an offline optimization.
- **Public site:** the same two subsets, staged into `site/fonts/` from the PWA's copies at deploy
  time; the site carries no font file of its own. Its only script is the inline copy-button
  enhancement for setup commands; it makes no network, storage, or analytics calls.
- **Exported artwork:** `assets/banner.html` and `assets/og.html` load the same vendored files, and
  `bun run media:brand` renders them and every raster icon with no network access.
- Wordmark (artwork and site): "OMP Session Gateway", weight 640, letter-spacing −0.02em.

## Voice

Sober and exact. Sentence case everywhere. No emoji, no
exclamation marks. Security claims stated as invariants ("Capabilities are
requested only when you tap an action."). Keep the standing disclaimer in prose:
"Community project; not affiliated with or endorsed by the Oh My Pi maintainers." (rendered artwork
keeps the short form "Community project; not affiliated with OMP."). Describe stock mainline OMP
`>= 18.1.20` as the prerequisite, not a gateway-specific build.

Public release copy uses comma thousands separators for integer quantities of 1,000 or more.
Keep unit labels unchanged (`seconds`, `ms`, `MiB`); group hyphenated quantities too
(`1,800-second`). Versions, dates, timestamps, digests, ports, IDs, URLs, and code spans stay literal.
Apply this style when rendering public copy, without rewriting stored release evidence.

## Message hierarchy

1. **Outcome:** live terminal sessions, one private mobile page; View or Control
   without moving a collaboration link for each session.
2. **Stock OMP, no fork:** OMP `>= 18.1.20` supplies the native registry and
   controller. No custom OMP build or gateway-specific OMP plugin is needed.
   The gateway remains a separate companion, not an official OMP product.
3. **One-time setup:** install the gateway with Bun 1.4.4, enable
   `collab.autoStart` once, and configure TUN-mode Tailscale Serve with an exact
   user allowlist and Funnel disabled. Then start participating sessions with
   plain `omp`. Say "no per-session link copying", not "no setup".
4. **Evidence and limits:** link [Compatibility](COMPATIBILITY.md) for supported and qualified
   platforms and known limits; separate synthetic product media from hardware evidence.

README hierarchy: promise → demo → how it works → get started → using it → private by design → supported platforms → docs.

## Asset inventory

Paths below are relative to the repository root. Every raster below is rendered from its committed
source by `bun run media:brand`, which records source, input and output digests in
`assets/artwork.json`; `scripts/site-coherence.test.ts` fails when any of them drifts.

| File | Purpose |
|---|---|
| `assets/logo.svg` | mark, transparent, for dark backgrounds |
| `assets/logo-light.svg` | mark for light backgrounds |
| `assets/banner.html` → `assets/banner.png` | banner (1280×320, rendered @2x) for placements outside the README |
| `assets/og.html` → `assets/og.png` | GitHub social preview and site `og:image` (1280×640) |
| `apps/web/src/icon.svg` | PWA icon source (512, rx116 black tile); app favicon |
| `apps/web/src/icon-192.png` / `apps/web/src/icon-512.png` | manifest icons, `purpose: any` |
| `apps/web/src/icon-maskable.svg` → `apps/web/src/icon-maskable-512.png` | manifest icon, `purpose: maskable` (full-bleed, mark inside the safe zone) |
| `apps/web/src/apple-touch-icon-180.png` | apple-touch-icon (the icon source on an opaque black square) |
| `apps/web/src/badge.svg` → `apps/web/src/badge-96.png` | notification badge: white on transparent, as Android's status bar requires |
| `apps/web/src/favicon.svg` | site favicon source (96, rx22 tile) |
| `apps/web/src/fonts/geist/` | vendored Geist and Geist Mono subsets with their manifest |
| `apps/web/src/index.html`, `apps/web/src/app.ts`, `apps/web/src/icons.ts`, `apps/web/src/styles.css`, `apps/web/src/manifest.webmanifest` | maintained PWA shell, behavior, icons, styles, and manifest; see [web app notes](../apps/web/README.md) |
| `site/` | canonical public site (`carrythroughsystems.github.io/omp-session-gateway`); `pages.yml` stages both marks, the favicon, `og.png`, the two Geist subsets, and the three raw PWA captures (`screen-*.png` from `docs/media/0{1,2,3}-*.png`) from their canonical sources at deploy time, so `site/` never carries copies |

Manifest snippet:

```json
"background_color": "#000000",
"theme_color": "#000000",
"icons": [
  { "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml" },
  { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
  { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
  { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
]
```

The manifest has one splash color, so it stays dark; the document declares both schemes with two
`theme-color` metas (`#000000` dark, `#f4f4f2` light) and `color-scheme: dark light`.

README top: the mark via `<picture>` (`logo.svg` dark, `logo-light.svg` light) above the H1 and
the one-line promise; the banner is not embedded. README media and the visual lane are pinned to
the dark scheme.

## PWA UI system ("OMP Sessions")

Register: one thing at a time. The page answers one question — does anything need you? — and the
answer is the largest thing on it.

- Layout: the directory is one triage column, `min(100% − 2rem, 35rem)` at every viewport; open
  sessions widen separately (see Collaboration shell). Spacing on a 4px grid.
- Surfaces: **one elevated card** (the request that needs you, `surface-1`, 24px radius) sits
  over **plain rows** on the ground: no card, no border, a rounded surface only under a press or
  hover. Secondary surfaces are **floating trays**. Controls are `surface-2` pills; nothing has a
  border where a surface step will do. Dark elevation is a hairline ring, light elevation a soft
  shadow.
- Icons are drawn (`apps/web/src/icons.ts`): one 20px grid, 1.75px round strokes, the current text
  color. No text glyph stands in for an icon.
- Masthead: one 44px toolbar row — the mark at the left, then `New session` and the icon-only
  Settings control — and below it the H1 `Sessions`/`Needs you` beside the state pill
  (`Live · N` green / `Listed · N` neutral / `N waiting` amber). With several hosts configured, one
  compact native `select` (`All hosts` / host names, `aria-label` only) scopes the directory under
  the heading.
- Session identity (every row, the hero, the tray header, and the collaboration shell header): a
  44px neutral tile (`surface-2`, 13px radius) holds the title's leading Nerd Font icon, or the
  title's first letter as a monogram, with the session state as a 13px badge on the tile's corner,
  ringed in the surface behind it — filled green working, green ring idle, muted unknown, amber
  waiting, amber ring held. The icon leaves the title text, spoken names (`aria-label`, document
  title, push bodies) drop icons, and an icon inside a title draws as a 1em cell with a fixed gap.
- Titles: 2-line clamp at weight 600 (`overflow-wrap: anywhere`), never a
  single-line ellipsis on phones; the shell header keeps one line.
- Metadata (`.row-meta`): groups of discrete facts, one group per line — where the session runs
  (host · project) and what it is doing (state · uptime · model). A group never wraps, so a
  separator can never dangle; a group wider than the row truncates its identifiers first.
  Identifiers are mono, words and durations are not. Working rows show project, then
  `Working`/`Idle`/`Activity unknown` · `up <elapsed>` (`m`, `h m`, `d h`) · model slug; the project
  is omitted when the title already is the project, and the host appears first only while more than
  one host is in view. Waiting and held rows show project (and host); the hero shows project (and
  host), then the model slug.
- Needs-you queue: under `Up next`, one hero card — tile, title and summary, the ask set as a message bubble, then amber `Open request` beside a tonal `Options` button. A view-only hero's `View transcript` is ink, because reading does not take Control. `Then` rows carry their wait and a chevron; `On hold` rows carry `Requeue`; working rows follow ([Needs you](USAGE.md#needs-you)).
- Working rows: the whole row is the View target (tile, title, metadata), with a quiet trailing 44px icon-only `Hide` control (eye-off, `ink-4` → `ink` on hover) and the explicit `Hide … on this device` accessible name ([Hold and hide](USAGE.md#hold-and-hide)).
- Collaboration shell: one header row at every width — Back (icon alone on phones), a 30px tile before the one-line title, Control, and connection state. From 37rem up, the session, header, and triage bar share one `min(100% − 2rem, 60rem)` column for the 900px transcript; `--gateway-*` tokens theme the client and keep selection, focus, and Send in ink.
- All clear: a left-aligned status (ringed live dot, `All clear`, one muted line) without repeating masthead counts; incomplete coverage uses a neutral ring and host coverage, and alert state appears when enabled or routes to Settings. On a same-scope queue → all-clear transition, the ring expands to 2.5× and fades over `--motion-long`, the title rises 4px over `--motion-medium`, copy follows 60ms later, and the answered check draws over `--motion-medium` (static under reduced motion, ADR-042).
- First run (ADR-042): three neutral trays (`Connected` with a 44px arriving mark, `Background alerts`, `View or Control`) after the first authoritative directory render, never over another tray ([First run](USAGE.md#first-run)). Each step has a distinct height, heading focus without a ring, interactive focus rings, a 48px Close/Back control, and one primary action (`Enable background alerts` in inverse ink and tonal `Next` while alerts are off); the build footer stays in `Background alerts`.
- Settings trays: `Background alerts` contains the seven-state toggle and the build line; `Alert detail` options are cards with a drawn radio whose selected card is outlined in ink; `Hosts` coverage uses ink switches. See [Background alerts](USAGE.md#background-alerts).
- Creation trays: neutral single-topic panels with distinct heights, heading focus, and 48px targets, with `Create and open Control` as the one amber action ([Start a new session](USAGE.md#start-a-new-session)). Progress shows `Starting in Tern`, `Waiting for OMP`, and `Opening Control` with drawn green checks, a pulsing live dot (static under reduced motion), and muted future steps; unavailable or uncertain states use tonal `Retry options` or `Check creation` instead of a disabled button.
- Trays (ADR-041): a tray **floats** inset 8px from every edge (or safe area), 32px radius, no border, over a plain scrim, with a 48px Close/Back control and >= 24px height step between adjacent panels ([Tray controller](../apps/web/README.md#trays)). Request grips are amber; alerts, recovery, and Undo (non-modal tile, two-line copy, inverse-ink `Undo`, no heading, grip, or countdown) are neutral; `Open request` uses ~72% visual viewport height and a flat frame until full-screen promotion.
- Status banner: a `surface-1` card with a leading ring, a title, detail, and its actions. Loading is a single muted line with a pulsing dot, never a card. Unauthorized uses a danger wash with a filled dot and hides rows.
- Empty state: the mark with its dot filled in `ink-4`, `No live sessions`, the `collab.autoStart` hint, and an inverse-ink `New session`.
- Focus: 2px ink ring, 2px offset; modal trays focus the current panel heading.
- Motion (ADR-040): only on user-initiated transitions and genuine state changes,
  never on routine refreshes. Directory ↔ session is a shared-axis slide with the
  tapped tile morphing into the header tile; rows slide when a session changes
  group, rise in when added, fade out when hidden, and the heading cross-fades
  between `Sessions` and `Needs you`. Emphasized curves
  (`--ease-emphasized`, `-decelerate`, `-accelerate`), 120–400 ms, no overshoot. Touch answers
  under the thumb: pills settle to 0.97, a pressed tile to 0.94, surfaces step one tone.
  `prefers-reduced-motion` removes everything but the final state, and every pulse stops with it.
- Links: ink with an underline; never color alone.

Security-UX invariants (do not regress): capabilities fetched only on tap
(no-store), never rendered into DOM attributes/history/storage; Background alerts
keeps the standing community/affiliation line.

### Availability ownership

Notice ownership, target arbitration, and observation state transitions belong to [Availability model](ARCHITECTURE.md#availability-model). This section specifies their visual and copy treatment:

- Initial loading and foreground refresh stay neutral, without warning colors or `Retry` actions; quiet rechecks keep a retained empty observation's clock primary and checking progress secondary.
- Access denial (`403` / `forbidden`) uses `danger` red on the banner, remote host row, connection chip, and launch or triage notice, and never offers `Retry`; non-authorization faults stay neutral (`ink`, no state color).
- Complete coverage earns the green `Live · N` pill, the `Live sessions` list subheading, and the ringed green dot on `All clear`. Incomplete coverage uses a neutral `Listed · N` pill, the `Sessions` list subheading, a neutral ring on `Host coverage incomplete`, and `N of M hosts up to date` without repeating host labels; an empty incomplete list states that sessions may be missing and never claims `All clear`.
- Cached (stale) rows keep legible text with dashed tile outlines, muted state badges, and `List as of {time}` metadata; every availability clock formats the last successful observation with the same locale-aware hour-and-minute formatter, never a failed-check timestamp.
- A retained empty observation renders `No sessions as of {time}`; an expired or authorization-withdrawn source renders `The previous session list was withdrawn.` or `No session list received yet.` instead of claiming the list was empty.
- Inside an open session, reported health faults override neutral initial joining, the connection chip's label remains visible in request trays, and the triage bar carries retry timing (`Retrying in <N>s`, `Reconnecting automatically…`) rather than repeating the fault name.

## Relationship to upstream

Independent community project; not affiliated with or endorsed by the Oh My Pi
maintainers. Respect `NOTICE.md`. "OMP" appears in the name as plain nominative
reference; do not restyle upstream's logo.
