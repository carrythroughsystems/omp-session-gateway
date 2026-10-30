# OMP Session Gateway — brand & UI spec

Identity for `omp-session-gateway`: a sober, security-first infra tool that is
visibly a *companion* to [oh-my-pi](https://github.com/can1357/oh-my-pi) without
copying its mark. This file is the design source of truth.

## The mark: "The Gate"

A lintel over two posts — a gateway that quietly echoes π — with an emerald dot
passing through: a live session crossing the boundary. Geometry (96×96 viewBox,
all radii 2):

- lintel `x12 y16 w72 h10`
- posts `x24/x62 y26 w10 h52`
- dot `cx48 cy58 r8` in Live emerald

Rules:

- Never use upstream OMP's π-with-plug mark or derivatives of it.
- Clearspace: one dot diameter (16 units) on all sides. Minimum size 16px.
- The dot is always Live emerald; the frame is Ink on dark surfaces
  (`logo.svg`) or Ink-dark on light surfaces (`logo-light.svg`). Never recolor.
- The dot doubles as the product-wide "live" motif (status dots, pills).

## Color

Dark-first (GitHub audience, terminal-native product). Blue-black ground —
deliberately cooler than OMP's warm `#0d0d0d`.

| Token | Hex | oklch | Use |
|---|---|---|---|
| ground | `#060809` | oklch(0.13 0.005 240) | page background |
| ink-dark | `#0B0E11` | oklch(0.16 0.008 240) | icon tiles, buttons on light |
| surface | `#0E1319` | oklch(0.18 0.012 245) | cards, panels |
| border-subtle | `#161C22` | oklch(0.22 0.012 245) | inner hairlines |
| border | `#1C232B` | oklch(0.26 0.014 245) | card borders |
| ink | `#E8ECEF` | oklch(0.94 0.004 240) | headings, primary buttons |
| body | `#B6BEC7` | oklch(0.80 0.010 240) | body text |
| muted | `#8A939D` | oklch(0.66 0.012 240) | meta, labels |
| live | `#31C48D` | oklch(0.73 0.14 163) | live status, accents, links, focus |
| control | `#C99B45` | oklch(0.73 0.11 80) | Control action (privileged) |
| danger | `#C85045` | oklch(0.58 0.14 27) | unauthorized / error states |
| kinship | `#F97316` | — (upstream orange) | see rule below |

**Kinship rule:** upstream orange appears at most once per surface, only as a
micro-dot (≤5px UI, ≤8px banner) adjacent to an oh-my-pi mention — never in the
mark, never on interactive elements, never as a fill. It is a citation, not an
accent.

## Type

- **Runtime PWA:** system/local font stacks for text — `system-ui, sans-serif` /
  `ui-monospace, monospace`. The PWA additionally uses one self-hosted, lazily loaded Symbols
  Nerd Font Mono subset for Private Use Area glyphs, served as first-party assets. Runtime
  assets must remain first-party; no remote fonts, Google Fonts requests, third-party scripts,
  or CDNs. This is a privacy requirement, not an optional offline optimization.
- **Public site:** the same first-party rule, satisfied by self-hosted latin subsets in
  `site/fonts/` (Space Grotesk, variable weight, for the wordmark and headings; JetBrains Mono,
  variable weight, for eyebrows, pills, and code; provenance in `THIRD_PARTY_NOTICES.md`).
  Body text stays on the system sans stack. The site's only script is the inline copy-button
  enhancement for setup commands; it makes no network, storage, or analytics calls.
- **Exported artwork:** `assets/banner.html` and `assets/og.html` use Space Grotesk 500/600 and
  JetBrains Mono 400/500 from Google Fonts to render static assets (`bun run media:brand`). Those
  artwork sources are not runtime shells; do not copy their font-loading links into the app
  or site. Existing media retains its recorded provenance.
- Wordmark (artwork and site): "OMP Session Gateway", weight 600, letter-spacing −0.015em.
  Mono labels: 11–12px, uppercase, letter-spacing 0.1–0.22em.

## Voice

Sober and exact. Sentence case everywhere except mono eyebrows. No emoji, no
exclamation marks. Security claims stated as invariants ("Capabilities are
requested only when you tap an action."). Keep the standing disclaimer in prose:
"Community project; not affiliated with or endorsed by the Oh My Pi maintainers." (rendered artwork
keeps the short form "Community project; not affiliated with OMP."). Describe stock mainline OMP
`>= 18.1.20` as the prerequisite, not a gateway-specific build.

## Message hierarchy

1. **Outcome:** live terminal sessions, one private mobile page; View or Control
   without moving a collaboration link for each session.
2. **Stock OMP, no fork:** OMP `>= 18.1.20` supplies the native registry and
   controller. No custom OMP build or gateway-specific OMP plugin is needed.
   The gateway remains a separate companion, not an official OMP product.
3. **One-time setup:** install the gateway with Bun 1.4.0, enable
   `collab.autoStart` once, and configure TUN-mode Tailscale Serve with an exact
   user allowlist and Funnel disabled. Then start participating sessions with
   plain `omp`. Say "no per-session link copying", not "no setup".
4. **Evidence and limits:** link [Compatibility](COMPATIBILITY.md) for supported and qualified
   platforms and known limits; separate synthetic product media from hardware evidence.

README hierarchy: promise → demo → how it works → build and run → using it → private by design → supported platforms → docs.

## Asset inventory

Paths below are relative to the repository root.

| File | Purpose |
|---|---|
| `assets/logo.svg` | mark, transparent, for dark backgrounds |
| `assets/logo-light.svg` | mark for light backgrounds |
| `assets/banner.html` | banner source (1280×320) for placements outside the README; `bun run media:brand` renders it |
| `assets/banner.png` | rendered banner @2x (2560×640) |
| `assets/og.html` | social preview source (1280×640); `bun run media:brand` renders it |
| `assets/og.png` | GitHub social preview and site `og:image` (1280×640) |
| `apps/web/src/icon.svg` | PWA icon source (512, rx116 tile); app favicon |
| `apps/web/src/favicon.svg` | site favicon source (96, rx22 tile) |
| `apps/web/src/icon-192.png` / `apps/web/src/icon-512.png` | manifest icons, `purpose: any` |
| `apps/web/src/icon-maskable-512.png` | manifest icon, `purpose: maskable` |
| `apps/web/src/apple-touch-icon-180.png` | apple-touch-icon |
| `apps/web/src/index.html`, `apps/web/src/app.ts`, `apps/web/src/styles.css`, `apps/web/src/manifest.webmanifest` | maintained PWA shell, behavior, styles, and manifest; see [web app notes](../apps/web/README.md) |
| `site/` | canonical public site (`carrythroughsystems.github.io/omp-session-gateway`), system font stacks only, no JavaScript; `pages.yml` stages the mark, favicon, `og.png`, and the three raw PWA captures (`screen-*.png` from `docs/media/0{1,2,3}-*.png`) from their canonical sources at deploy time, so `site/` never carries copies |

Manifest snippet:

```json
"background_color": "#060809",
"theme_color": "#060809",
"icons": [
  { "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml" },
  { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
  { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
  { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
]
```

README top: the mark via `<picture>` (`logo.svg` dark, `logo-light.svg` light) above the H1 and
the one-line promise; the banner is not embedded. `<meta name="theme-color" content="#060809">`.

## PWA UI system ("OMP Sessions")

Register: restraint — strong type, clear hierarchy,
few colors, no decoration that isn't information. One accent per state:
emerald = live, amber = needs-you/privileged, red = unauthorized.

- Layout: the directory is one couch-first triage column, `min(100% − 2rem, 35rem)`
  at every viewport; open sessions widen separately (see Collaboration shell).
  Spacing on a 4px grid. System font stacks for text in the app; only Private Use
  Area symbols use the self-hosted, lazily loaded Nerd Font subset (Space
  Grotesk/JetBrains Mono webfonts remain README/banner-only).
- Radii: 12px rows/cards and hero, 999px pills. Borders 1px `border`;
  shadows only on trays — hierarchy comes from surface
  steps, not elevation.
- Masthead: brand row (mark 20px + mono eyebrow `PRIVATE TAILNET DIRECTORY` in
  live color + trailing 44px Settings control), then H1 `Sessions`/`Needs you`
  beside the state pill (`Live · N` emerald / `N waiting` amber). With several
  hosts configured, one compact native `select` (`All hosts` / host names,
  `aria-label` only) scopes the directory under the heading.
- Session identity (every row, the hero, and the collaboration shell header)
  mirrors Tern's: a 40px light tile (`ink` on `raised`, 10px radius) holds the
  title's leading Nerd Font icon from the self-hosted symbol face, or the
  title's first letter as a monogram, with the session state as a 10px badge
  on the tile's corner — filled emerald working, emerald ring idle, muted
  unknown, amber waiting, amber ring held. The icon leaves the title text,
  spoken names (`aria-label`, document title, push bodies) drop icons, and an
  icon inside a title draws as a 1em cell with a fixed gap.
- Titles: 2-line clamp at weight 600 (`overflow-wrap: anywhere`), never a
  single-line ellipsis on phones; the shell header keeps one line.
- Metadata line (`.row-meta`): discrete mono facts at 11.5px that wrap between
  facts, never inside one; each fact carries its own trailing `·` separator,
  and only a fact wider than the row truncates. Working rows order project ·
  state (`Working`/`Idle`/`Activity unknown`) · `up <elapsed>` (`m`, `h m`,
  `d h`) · model slug; the project is omitted when the title already is the
  project, and the host appears first only while more than one host is in view
  (several sources and `All hosts` scope). Waiting and held rows show project
  (and host); the hero shows project · model (and host).
- Needs-you queue: one amber `Up next` hero (tile + title + summary, sentence-case
  ask preview with a 2px amber rule, block `Open request`, quiet 48px `Options`
  opening `This request` with `Hold for desk`/`View transcript`), `Then` rows with chevrons, dashed `On hold`
  rows with `Requeue`, then working rows.
- Working rows: one bordered frame per session — whole-row View button (tile,
  title, metadata line) and a quiet trailing 44px icon-only `Hide` control
  (eye-off, `faint` → `ink` on hover) with the explicit `Hide … on this device`
  accessible name.
- Collaboration shell: one centered header row on wide screens (small 28px tile
  before the one-line title, capped so Back and the actions never move). Phone
  widths put Back and Control/connection state on the first row and give the
  tile and title a full-width second row, so long titles never collide with
  controls. From 37rem up, the session, its header row, and its triage bar
  share one centered column, `min(100% − 2rem, 60rem)`: wide enough for the
  client's 900px transcript, with no empty frame around it.
- All clear: compact left-aligned status (ringed live dot, `All clear`, one muted
  line), without repeating live counts already present in the masthead; incomplete
  coverage uses a neutral dot and numeric host coverage. Alert state appears only while
  background alerts are enabled; otherwise a pill chip routes to Settings.
  Its sole delight moment is a same-scope queue → all-clear arrival: the emerald
  ring expands to 2.5× and fades over the long token, the title rises 4px over
  medium, and the copy follows 60ms later. The shell's answered/all-clear check
  draws once over medium. No arrival on load, scope change, or routine refresh;
  reduced motion shows only the final state (ADR-042).
- First run (ADR-042): three neutral trays — `Connected`, `Background alerts`,
  `View or Control` — after the first authoritative directory render, never over
  another tray. Reuse the 32px gateway mark and existing notification control;
  show only current host/session facts and the explicit-action capability promise.
  Each step has one topic, a distinct height, a primary Next/Done action, heading
  focus and a 48px Close/Back control. Skip and Not now are real exits/advances,
  not permission prompts. Resume the last step; completing or skipping stays done.
  Noninteractive tray headings receive focus without an outline; interactive controls retain
  their focus rings. The affiliation/build footer appears in Settings, not the introduction.

- Settings trays: `Background alerts` contains the seven-state toggle and mono build line;
  enabled alerts expose `Alert detail · <level>`, opening a child with the three radios.
- Creation trays: visible `New session` actions in the heading area and empty state lead through
  Host, Project, Working copy, Profile, and review, one focused neutral panel at a time. Logical
  Back replaces the native panel; every step keeps heading focus, measured distinct heights and
  48px targets. `Create and open Control` names the authority explicitly. Optional First task
  stays in memory and seeds the composer without sending. Starting session shows three steps:
  `Starting in Tern`, `Waiting for OMP`, `Opening Control`, with emerald completed checks, an
  active status-pulse dot (still under reduced motion), and muted future steps. Opening Control
  remains visible until the shell mounts. Starting/Stopped watching/terminal
  copy distinguishes observing from stopping the host command; `Check creation` never silently
  starts another operation. Unconfigured/older hosts offer `Retry options`, not a dead Create.
- Trays (ADR-041): one native host for secondary surfaces, one topic/action per panel,
  concise title and one 48px leading Close/Back control. Adjacent panels differ by at least
  24px, with measured height and content transitions using ADR-040's Material tokens.
  Context determines tone: requests are amber; alerts, recovery and Undo are neutral.
  Native modality preserves context and focus; the grip alone drags, content scrolls,
  and the bottom clears the safe area. Undo is a compact non-modal polite status row: tile,
  two-line copy and filled Undo action, without a heading, grip or countdown.
  Open request grows from metadata/Connecting to the actual pinned client at about 72%
  of the visual viewport. One header owns Close, session tile/title, connection dot and icon-only
  Expand; the inner shell bar is hidden and its frame flattened until promotion. Expand grows
  into the same full-screen session without remounting.
- Status banner: full-width `surface` strip with a leading status dot
  (live/loading/danger). Unauthorized uses `danger` text + dot and hides rows.
- Empty state: ghost mark (22% opacity), `NO LIVE SESSIONS` kicker, mono hint
  about `collab.autoStart`.
- Focus: 2px `live` ring, 2px offset; modal trays focus the current panel heading.
- Motion (ADR-040): only on user-initiated transitions and genuine state changes,
  never on routine refreshes. Directory ↔ session is a shared-axis slide with the
  tapped tile morphing into the header tile; rows slide when a session changes
  group, rise in when added, fade out when hidden, and the heading cross-fades
  between `Sessions` and `Needs you`. Material 3 emphasized curves
  (`--ease-emphasized`, `-decelerate`, `-accelerate`), 200–400 ms, no overshoot;
  a pressed tile settles to 0.94. `prefers-reduced-motion` removes everything but
  the final state, and the loading dot's pulse stops with it.
- Links: `live` color, hover lighten (`#5FD9A9`).

Security-UX invariants (do not regress): capabilities fetched only on tap
(no-store), never rendered into DOM attributes/history/storage; Background alerts
keeps the standing community/affiliation line.

### Availability ownership

The banner owns device/local-gateway interruptions; host rows name only independently failed
remote sources. Loading and foreground refresh are neutral, never warnings or Retry actions.
Failed fleet bootstrap uses that same banner, not a second row; local transport failure takes
precedence. Offline preserves remote observation clocks and expiry while recovery continues.
An established fault stays named during a pending retry, even before the first snapshot.
Remote launch denial belongs to its host row, never the device/local authorization banner.
Hiding or opening a remote session is not local recovery. Remote expired-session and failed-launch
feedback stays on that source; Refresh host checks its list without retrying a capability launch.
Cross-host Next-ask failures name the target in the existing triage bar, not the healthy
predecessor's connection chip, and offer Sessions to reach that host's list-only recovery.
The target owns that notice through predecessor health and Hold updates. It has no expiry timer:
Sessions, explicit dismissal, a new launch, or a successful target observation releases it.
Its denial accent is red; non-auth target failures retain amber.
Local targets follow the same ownership as remote targets, including in-session mode withdrawal.
Successful expiry refresh ends the failure notice; dismissing it restores Hold without waiting for refresh.
Withdrawing View or Control during a launch names the unavailable mode instead of opening it.
Coverage aggregates `N of M hosts up to date` without repeating labels. Only complete coverage
earns `Live · N` and `Live sessions`; incomplete coverage uses a neutral `Listed · N` pill and
`Sessions`. Cached rows retain legible text, with dashed borders, muted state badges, and
`List as of {time}` metadata. Every availability clock formats the last successful observation
with the same locale-aware hour/minute formatter, never the failed-check time.
Multiple empty lists share an `as of` clock only when their underlying observation instants match,
not merely because their formatted hour and minute happen to match.

An empty incomplete list explains that sessions may be missing; it never claims all clear.
Access denial is red and has no Retry promise. A retained empty observation says `No sessions
as of {time}`; an expired or authorization-withdrawn list does not claim it was empty.
Withdrawal invalidates the old observation clock until a fresh authorized snapshot arrives.
These observation distinctions apply to All hosts and single-host directories too.
An independently observed remote empty list remains visible when local access is withdrawn.
Quiet rechecks keep a retained empty observation's clock primary and checking progress secondary.
In a session, reported health faults
override neutral initial joining; the chip's name remains visible in request trays, and the
triage bar supplies retry timing rather than repeating the fault. Creation keeps its
single-topic steps; the explicit Create-and-Control action is amber, and unavailable creation
offers recovery choices instead of a disabled primary action.

## Relationship to upstream

Independent community project; not affiliated with or endorsed by the Oh My Pi
maintainers. Respect `NOTICE.md`. "OMP" appears in the name as plain nominative
reference; do not restyle upstream's logo.
