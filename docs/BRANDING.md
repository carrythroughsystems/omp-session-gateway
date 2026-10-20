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

- **Runtime PWA and public site:** system/local font stacks only —
  `system-ui, sans-serif` / `ui-monospace, monospace`. Runtime assets must remain
  first-party; no remote fonts, Google Fonts requests, third-party scripts, or CDNs.
  This is a privacy requirement, not an optional offline optimization.
- **Exported artwork:** `assets/banner.html` uses Space Grotesk 500/600 and
  JetBrains Mono 400/500 from Google Fonts to render static assets. That artwork
  source is not a runtime shell; do not copy its font-loading links into the app
  or site. Existing media retains its recorded provenance.
- Artwork wordmark: "OMP Session Gateway", weight 600, letter-spacing −0.015em.
  Mono labels: 11–12px, uppercase, letter-spacing 0.1–0.22em.

## Voice

Sober and exact. Sentence case everywhere except mono eyebrows. No emoji, no
exclamation marks. Security claims stated as invariants ("Capabilities are
requested only when you tap an action."). Keep the standing disclaimer:
"Community project; not affiliated with OMP." Describe stock mainline OMP `>= 18.1.20` as the
prerequisite, not a gateway-specific build.

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
| `assets/banner.html` | README banner source (1280×320) |
| `assets/banner.png` | rendered banner @2x (2560×640) |
| `assets/og.png` | GitHub social preview and site `og:image` (1280×640) |
| `apps/web/src/icon.svg` | PWA icon source (512, rx116 tile); app favicon |
| `apps/web/src/favicon.svg` | site favicon source (96, rx22 tile) |
| `apps/web/src/icon-192.png` / `apps/web/src/icon-512.png` | manifest icons, `purpose: any` |
| `apps/web/src/icon-maskable-512.png` | manifest icon, `purpose: maskable` |
| `apps/web/src/apple-touch-icon-180.png` | apple-touch-icon |
| `apps/web/src/index.html`, `apps/web/src/app.ts`, `apps/web/src/styles.css`, `apps/web/src/manifest.webmanifest` | maintained PWA shell, behavior, styles, and manifest; see [web app notes](../apps/web/README.md) |
| `site/` | canonical public site (`carrythroughsystems.github.io/omp-session-gateway`), system font stacks only; `pages.yml` stages the mark, favicon, `og.png`, and product-flow capture from their canonical sources at deploy time, so `site/` never carries copies |

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

README banner: use `assets/banner.png` at top (it is dark-mode native and acceptable
on light GitHub). `<meta name="theme-color" content="#060809">`.

## PWA UI system ("OMP Sessions")

Register: restraint — strong type, clear hierarchy,
few colors, no decoration that isn't information. One accent per state:
emerald = live, amber = needs-you/privileged, red = unauthorized.

- Layout: the directory is one couch-first triage column, `min(100% − 2rem, 35rem)`
  at every viewport; open sessions widen separately (see Collaboration shell).
  Spacing on a 4px grid. System font stacks only in the app (Space
  Grotesk/JetBrains Mono webfonts remain README/banner-only).
- Radii: ~10px rows/cards, 12px hero, 999px pills. Borders 1px `border`;
  shadows only on overlays (toast, sheets) — hierarchy comes from surface
  steps, not elevation.
- Masthead: brand row (mark 20px + mono eyebrow `PRIVATE TAILNET DIRECTORY` in
  live color + trailing 44px Settings control), then H1 `Sessions`/`Needs you`
  beside the state pill (`Live · N` emerald / `N waiting` amber).
- Needs-you queue: one amber `Up next` hero (title, mono project/model
  summary, sentence-case ask preview with a 2px amber rule, block
  `Open request`, quiet `Hold for desk`/`Transcript` alternates), `Then` rows
  with chevrons, dashed `On hold` rows with `Requeue`, then working rows.
- Working rows: one bordered frame per session — whole-row View button with a
  live dot, full-width title, then one compact mono detail line ordered uptime,
  project, model slug. Project and model consume only their content and available
  space; uptime remains visible. The quiet inset `Hide` control retains a 44px
  target and explicit `Hide … on this device` label without looking destructive.
- Collaboration shell: one centered header row on wide screens. Phone widths
  put Back and Control/connection state on the first row and give the session
  title a full-width second row, so long titles never collide with controls.
  From 37rem up, the session, its header row, and its triage bar share one
  centered column, `min(100% − 2rem, 60rem)`: wide enough for the client's
  900px transcript, with no empty frame around it.
- All clear: compact left-aligned status (ringed live dot, `All clear`, one muted
  line), without repeating live counts already present in the masthead. Alert state appears only while background alerts are
  enabled; otherwise a pill chip routes to Settings.
- Settings sheet: bottom sheet with mono section kickers, the seven-state
  alert toggle, detail options (only while enabled), and a mono build line.
- Status banner: full-width `surface` strip with a leading status dot
  (live/loading/danger). Unauthorized uses `danger` text + dot and hides rows.
- Empty state: ghost mark (22% opacity), `NO LIVE SESSIONS` kicker, mono hint
  about `collab.autoStart`.
- Focus: 2px `live` ring, 2px offset; dialogs take initial focus themselves.
  Motion: none on list re-renders; only the loading dot pulses, and
  `prefers-reduced-motion` disables it.
- Links: `live` color, hover lighten (`#5FD9A9`).

Security-UX invariants (do not regress): capabilities fetched only on tap
(no-store), never rendered into DOM attributes/history/storage; the Settings
sheet keeps the standing community/affiliation line.

## Relationship to upstream

Independent community project; not affiliated with or endorsed by the Oh My Pi
maintainers. Respect `NOTICE.md`. "OMP" appears in the name as plain nominative
reference; do not restyle upstream's logo.
