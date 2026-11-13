# Third-party notices

The release archive contains a Bun-compiled gateway and a browser bundle built from the pinned
OMP collaboration client. The runtime dependency closure below is derived from the bundled
workspace roots in the distributed `bun.lock`; development-only packages are not shipped. Exact
package integrity values are preserved in `bun.lock` and `SBOM.spdx.json`; `release-info.json`
records the SHA-256 of the distributed lockfile.

The npm packages listed below are not locally modified. Bun 1.4.4 bundles their imported runtime
code into either the gateway executable or the web assets. Their distributed license notices,
source locations, and required attributions are included at the stated archive paths.

## Bundled runtime dependencies

### @oh-my-pi/pi-wire@18.20.0

- Source: <https://github.com/can1357/oh-my-pi/tree/v18.20.0/packages/wire>
- License: MIT
- Copyright: Copyright (c) 2025-2026 Can Bölük; Copyright (c) 2026 Stencil Labs, Inc.
- License text: `licenses/runtime/@oh-my-pi__pi-wire/LICENSE`

### agent-base@7.1.4

- Source: <https://github.com/TooTallNate/proxy-agents/tree/agent-base%407.1.4/packages/agent-base>
- License: MIT
- Copyright: Copyright (c) 2013 Nathan Rajlich
- License text: `licenses/runtime/agent-base/LICENSE`

### asn1.js@5.4.1

- Source: <https://github.com/indutny/asn1.js/tree/v5.4.1>
- License: MIT
- Copyright: Copyright (c) 2017 Fedor Indutny
- License text: `licenses/runtime/asn1.js/LICENSE`

### bn.js@4.12.5

- Source: <https://github.com/indutny/bn.js/tree/v4.12.5>
- License: MIT
- Copyright: Copyright Fedor Indutny, 2015
- License text: `licenses/runtime/bn.js/LICENSE`

### buffer-equal-constant-time@1.0.1

- Source: <https://github.com/goinstant/buffer-equal-constant-time/tree/v1.0.1>
- License: BSD-3-Clause
- Copyright: Copyright (c) 2013, GoInstant Inc., a salesforce.com company
- License text: `licenses/runtime/buffer-equal-constant-time/LICENSE`

### commander@15.0.0

- Source: <https://github.com/tj/commander.js/tree/v15.0.0>
- License: MIT
- Copyright: Copyright (c) 2011 TJ Holowaychuk <tj@vision-media.ca>
- License text: `licenses/runtime/commander/LICENSE`

### debug@4.4.3

- Source: <https://github.com/debug-js/debug/tree/4.4.3>
- License: MIT
- Copyright: Copyright (c) 2014-2017 TJ Holowaychuk; Copyright (c) 2018-2021 Josh Junon
- License text: `licenses/runtime/debug/LICENSE`

### ecdsa-sig-formatter@1.0.11

- Source: <https://github.com/Brightspace/node-ecdsa-sig-formatter/tree/v1.0.11>
- License: Apache-2.0
- Copyright: Copyright 2015 D2L Corporation
- License text: `licenses/runtime/ecdsa-sig-formatter/LICENSE`

### http_ece@1.2.0

- Source: <https://github.com/martinthomson/encrypted-content-encoding/tree/v1.2.0>
- License: MIT
- Copyright: Copyright (c) 2015 Martin Thomson
- License text: `licenses/runtime/http_ece/LICENSE`

### https-proxy-agent@7.0.6

- Source: <https://github.com/TooTallNate/proxy-agents/tree/https-proxy-agent%407.0.6/packages/https-proxy-agent>
- License: MIT
- Copyright: Copyright (c) 2013 Nathan Rajlich
- License text: `licenses/runtime/https-proxy-agent/LICENSE`

### inherits@2.0.4

- Source: <https://github.com/isaacs/inherits/tree/v2.0.4>
- License: ISC
- Copyright: Copyright (c) Isaac Z. Schlueter
- License text: `licenses/runtime/inherits/LICENSE`

### jwa@2.0.1

- Source: <https://github.com/brianloveswords/node-jwa/tree/2.0.1>
- License: MIT
- Copyright: Copyright (c) 2013 Brian J. Brennan
- License text: `licenses/runtime/jwa/LICENSE`

### jws@4.0.1

- Source: <https://github.com/brianloveswords/node-jws/tree/v4.0.1>
- License: MIT
- Copyright: Copyright (c) 2013 Brian J. Brennan
- License text: `licenses/runtime/jws/LICENSE`

### katex@0.18.5

- Source: <https://github.com/KaTeX/KaTeX/tree/v0.18.5>
- License: MIT
- Copyright: Copyright (c) 2013-2020 Khan Academy and other contributors
- License text: `licenses/runtime/katex/LICENSE`

### lucide-react@1.31.0

- Source: <https://github.com/lucide-icons/lucide/tree/1.31.0/packages/lucide-react>
- License: ISC, with the included Feather-derived icons under MIT
- Copyright: Copyright (c) 2026 Lucide Icons and Contributors; Copyright (c) 2013-present Cole Bemis
- License text: `licenses/runtime/lucide-react/LICENSE`

### minimalistic-assert@1.0.1

- Source: <https://github.com/calvinmetcalf/minimalistic-assert/tree/v1.0.1>
- License: ISC
- Copyright: Copyright 2015 Calvin Metcalf
- License text: `licenses/runtime/minimalistic-assert/LICENSE`

### minimist@1.2.8

- Source: <https://github.com/minimistjs/minimist/tree/v1.2.8>
- License: MIT
- Copyright: no assertion in the distributed package license
- License text: `licenses/runtime/minimist/LICENSE`

### ms@2.1.3

- Source: <https://github.com/vercel/ms/tree/2.1.3>
- License: MIT
- Copyright: Copyright (c) 2020 Vercel, Inc.
- License text: `licenses/runtime/ms/LICENSE`


### react@19.2.7

- Source: <https://github.com/facebook/react/tree/6117d7cca4906492c51fe6a03381e35adfd86e7d/packages/react>
- License: MIT
- Copyright: Copyright (c) Meta Platforms, Inc. and affiliates
- License text: `licenses/runtime/react/LICENSE`

### react-dom@19.2.7

- Source: <https://github.com/facebook/react/tree/6117d7cca4906492c51fe6a03381e35adfd86e7d/packages/react-dom>
- License: MIT
- Copyright: Copyright (c) Meta Platforms, Inc. and affiliates
- License text: `licenses/runtime/react-dom/LICENSE`

### safe-buffer@5.2.1

- Source: <https://github.com/feross/safe-buffer/tree/v5.2.1>
- License: MIT
- Copyright: Copyright (c) Feross Aboukhadijeh
- License text: `licenses/runtime/safe-buffer/LICENSE`

### safer-buffer@2.1.2

- Source: <https://github.com/ChALkeR/safer-buffer/tree/v2.1.2>
- License: MIT
- Copyright: Copyright (c) 2018 Nikita Skovoroda
- License text: `licenses/runtime/safer-buffer/LICENSE`


### scheduler@0.27.0

- Source: <https://github.com/facebook/react/tree/861811347b8fa936b4a114fc022db9b8253b3d86/packages/scheduler>
- License: MIT
- Copyright: Copyright (c) Meta Platforms, Inc. and affiliates
- License text: `licenses/runtime/scheduler/LICENSE`

### web-push@3.6.7

- Source: <https://github.com/web-push-libs/web-push/tree/v3.6.7>
- License: MPL-2.0
- Copyright: Copyright 2015 Marco Castelluccio
- License text: `licenses/runtime/web-push/LICENSE`


## Vendored and locally modified runtime component

### @oh-my-pi/collab-web@16.3.6

- Source: <https://github.com/can1357/oh-my-pi/tree/c308970263ae13744ea15ab67302e3dac840e266/packages/collab-web>
- Pinned source: tag `v18.20.0`, commit `c308970263ae13744ea15ab67302e3dac840e266`
- License: MIT
- Copyright: Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük; Copyright (c) 2026 Stencil Labs, Inc.
- License text: `licenses/collab-web/LICENSE`
- Distributed code: `apps/web/dist/assets/collab-client.<content-hash>.js` and
  `apps/web/dist/assets/collab-client.<content-hash>.css`
- Local modifications: memory-only capability bootstrap with no URL/hash/storage writes; embedded
  gateway chrome and sole Ask-aware composer; strict read-only mutation guards; photo capture,
  metadata stripping, bounds, volatile previews, transcript acknowledgements, and retry; foreground,
  online, relay-room, and gateway-health transport recovery; generation-bound sends with fresh hello;
  long-transcript windowing and coalescing-safe live-transition tail reset; exact-optional typing;
  redacted capability errors; retained hub-family renderers; speech input; artwork exclusion; and
  the gateway's self-hosted PUA symbol fallback. All dispositions are in `upstream/UPSTREAM.json`.

### @oh-my-pi/pi-utils@18.20.0 — vendored pure helpers only

- Source: <https://github.com/can1357/oh-my-pi/tree/c308970263ae13744ea15ab67302e3dac840e266/packages/utils/src>
- Exact source files: `marked.ts`, `marked/core.ts`, `marked/inline-closers.ts`,
  `marked/inline-text.ts`, `marked-list.ts`, `math-delimiters.ts`, and `bytes.ts`, copied without modifications
  into `packages/collab-client/upstream/src/vendor/pi-utils/`.
- License: MIT; original Marked MIT and Markdown BSD-3-Clause notices are preserved.
- Copyright: Copyright (c) 2018+ MarkedJS; Copyright (c) 2011-2018 Christopher Jeffrey;
  Copyright (c) 2004 John Gruber; Copyright (c) 2025 Mario Zechner;
  Copyright (c) 2025-2026 Can Bölük; Copyright (c) 2026 Stencil Labs, Inc.
- License text: `licenses/pi-utils-marked/LICENSE`
- Distributed code: the same first-party `collab-client.<content-hash>.js` bundle.
- Only these pure TypeScript sources are vendored. Neither the pi-utils npm package nor pi-natives
  is installed or bundled. This fork replaces npm `marked`, supplying linear-time lexing,
  source-context math hooks, and streaming-tail rendering; `bytes.ts` supplies strict WebCrypto
  buffers without a native runtime closure. Offline export/trace entrypoints and `omp-stats` are
  excluded from the live bundle; see `upstream/UPSTREAM.json.excludedEntrypoints`.

OMP itself is a separately installed mainline prerequisite, not a bundled or locally modified
runtime component of this archive. The upstream OMP license text is retained at
`licenses/oh-my-pi/LICENSE`; the client and runtime attributions above remain applicable.

## Vendored font subsets

### Symbols Nerd Font Mono (Nerd Fonts v3.5.1)

- Source: <https://github.com/ryanoasis/nerd-fonts/tree/v3.5.1>
- Source archive: <https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/NerdFontsSymbolsOnly.zip>
- License: MIT (font file); glyph sets additionally under Apache-2.0 (Material Design Icons),
  CC BY 4.0 (Codicons, Font Awesome), OFL-1.1 (Weather Icons), OFL-1.1-RFN (Pomicons), and
  Unlicense (Font Logos, listed as "unlicensed" upstream); the release SBOM concludes
  `MIT AND Apache-2.0 AND CC-BY-4.0 AND OFL-1.1 AND OFL-1.1-RFN AND Unlicense`
- Copyright: Copyright (c) 2014 Ryan L McIntyre
- License text: `licenses/fonts/nerd-fonts/LICENSE`
- Distributed code: `apps/web/dist/assets/nerd-symbols-<chunk>.<content-hash>.woff2`
- Local modifications: Private Use Area-only subset split by unicode-range, hinting dropped,
  and converted to WOFF2 by `scripts/vendor-nerd-symbols.ts`.
- Icon-set licenses and upstream source/version table: `licenses/fonts/nerd-fonts/ICON_SETS.md`
  reproduces the release README's table verbatim; individual icon-set terms remain applicable.
- Font Awesome 6.5.1 attribution: Fonticons, Inc. (<https://fontawesome.com>),
  <https://github.com/FortAwesome/Font-Awesome/tree/6.5.1>,
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); modified as described above.
- Codicons 0.0.45 attribution: Microsoft and contributors,
  <https://github.com/microsoft/vscode-codicons>,
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); modified as described above.

### Geist and Geist Mono (Geist v1.9.2)

- Source: <https://github.com/vercel/geist-font/tree/v1.9.2>
- Source archive: <https://github.com/vercel/geist-font/releases/download/v1.9.2/geist-font-v1.9.2.zip>
  (SHA-256 `15f066d58dcb99fb10014a49913009fdaf41e464cfb8851a44b44e593c95d3d8`)
- License: SIL Open Font License 1.1 (`OFL-1.1`); the upstream license reserves no font name
- Copyright: Copyright 2026 The Geist Project Authors (<https://github.com/vercel/geist-font>)
- License text: `licenses/fonts/geist/LICENSE`
- Distributed code: `apps/web/dist/assets/geist-latin.<content-hash>.woff2`,
  `apps/web/dist/assets/geist-italic-latin.<content-hash>.woff2`, and
  `apps/web/dist/assets/geist-mono-latin.<content-hash>.woff2`
- Local modifications: the upright, italic, and mono variable faces subset to Latin, Latin-1
  Supplement, Latin Extended-A, punctuation, arrows, and comparison operators with a fixed set of
  layout features, hinting dropped, and converted to WOFF2 by `scripts/vendor-geist.ts`; per-file
  digests are recorded in `apps/web/src/fonts/geist/manifest.json`.

## Public site fonts

The canonical public site (`site/`, deployed to GitHub Pages) serves the same Geist and Geist Mono
subsets described above. The Pages workflow stages `geist-latin.woff2` and
`geist-mono-latin.woff2` from `apps/web/src/fonts/geist/` into `site/fonts/` and publishes
`licenses/fonts/geist/LICENSE` beside them as `fonts/LICENSE.txt`, so no page requests a remote
font service and the site carries no font file of its own.

The top-level `LICENSE` covers OMP Session Gateway itself. `NOTICE.md` describes the project's
independent relationship to Oh My Pi; it does not replace any license text listed above.
