# `packages/collab-client`

This package tells contributors how OMP Session Gateway embeds and verifies Oh My Pi's (OMP's) browser collaboration client, checks upstream source drift, and bounds client-side speech and photo inputs.

It vendors a live-runtime subset of upstream `packages/collab-web` at tag `v18.18.0` (commit `b5a6b2f7e5b6606b6562e678ead83f21738f34a0`, upstream `@oh-my-pi/collab-web` package version `16.3.6`) with `@oh-my-pi/pi-wire` pinned to `18.18.0` (`package.json`) and Bun `1.4.4` (`upstream/UPSTREAM.json`). Collaboration framing and relay envelopes match upstream; `@oh-my-pi/pi-wire`'s Tern Surface Protocol (`tsp.ts`) runtime is not bundled.

These browser-client provenance pins are tracked independently of both the minimum supported OMP host version (`>= 18.1.20`) and the root `UPSTREAM.lock.json` engineering host baseline; see [Mainline OMP integration](../../docs/OMP_INTEGRATION.md). Paths below starting with `package.json`, `upstream/`, or `test/` are relative to `packages/collab-client/`; paths starting with `.github/`, `scripts/`, or `licenses/` are relative to the repository root.

## Source drift report and refresh

The daily **Upstream OMP canary** (`08:23 UTC` in `.github/workflows/upstream-canary.yml`) inspects browser-client sources against npm `latest` of `@oh-my-pi/pi-coding-agent` independently of the host pin, including when `UPSTREAM.lock.json` equals `latest`; reusable release-request canary calls skip this job so drift never blocks a release request.

Because upstream keeps `@oh-my-pi/collab-web` at `16.3.6`, package version equality never proves unchanged source. For a local read-only check from the repository root, run `bun scripts/client-drift.ts` (prints the JSON report to `stdout`); optional `GH_TOKEN` authenticates GitHub API and issue reads (in CI, `contents: read` and `issues: read`), and nothing from upstream is installed or executed.

The workflow's `client-drift-report` artifact (`client-drift-report.json`) records:

- `release` and `embedded`: `{ tag, commit, tree }` for stable `@oh-my-pi/pi-coding-agent` npm `latest` versus `{ tag, commit }` from `upstream/UPSTREAM.json`.
- `hostPin`: `{ tag, commit, version }` from root `UPSTREAM.lock.json` for context, never used as a skip condition.
- `changes`: every changed path in `packages/collab-web/**` (excluding `excludedEntrypoints`) and in vendored helper `sourcePath`s, with `oldBlob` and `newBlob` Git SHA-1 hashes (`null` for added or removed files).
- `changedHelpers`: each vendored helper compared against its own recorded upstream commit and blob hash, with its `vendoredPath`.
- `patchOverlaps`: active local patch IDs whose `files` overlap changed upstream or helper paths (`src/`-prefixed relative to `upstream/`).
- `refreshScope` and `issueAction`: the sorted changed upstream paths and the `create`/`update`/`none` decision consumed via `GITHUB_OUTPUT` by the workflow's separate checkout-free issue-writer job (API, truncation, or provenance errors fail inspection).

Direct scheduled or manual runs on `main` create or update `Embedded client drift: <embedded tag> → <release tag>` with the `client-drift` label, deduplicated by release commit or exact title and label, without auto-closing issues or mutating release state. PR and release-request runs inspect only.

To refresh this package, copy only `refreshScope` paths at the reported commits into `upstream/` without copying the whole upstream package or restoring excluded entrypoints, and reconcile overlapping active patches against their purpose, `removeWhen` condition, and regression proofs (moving superseded patches to `localPatches.retired`).

Copy changed helpers from their recorded upstream paths without installing `@oh-my-pi/pi-utils` or `@oh-my-pi/pi-natives`, update `upstream/UPSTREAM.json` (`tag`, `commit`, `observedAt`, helper Git blob hashes, and patch records) and `package.json` (`@oh-my-pi/pi-wire` when needed) together, and run `test/vendor-provenance.test.ts` and repository checks as an implementation PR.

## Embedded integration

`upstream/src/embed.ts` (`startCollabWithCapability`) is the sole production client entrypoint (`upstream/src/embed-contract.ts`). It mounts `App` (`upstream/src/app.tsx`) in the current document with an in-memory capability (**View** or **Control** link) so navigation never depends on `window.opener` and capabilities never enter URLs, DOM attributes, storage, or caches; leaving or reloading returns to [the directory](../../docs/USAGE.md#the-directory).

Embedded mode (`CollabEmbedOptions.shellOwnsLifecycle: true`) hides upstream's standalone header, agent rail, connect screen, and lifecycle overlays while keeping its transcript, tool cards, agent drawer, and single composer (used for both prompts and active host Ask requests).

`UPSTREAM.json.excludedEntrypoints` (`upstream/UPSTREAM.json`) records excluded standalone bootstrap (`src/main.tsx`), OMP's π mark (`src/components/shell/OmpMark.tsx`), and offline HTML export and trace viewers (including retained-but-unbundled `src/tool-render/standalone.tsx`), relative to upstream `sourcePath`; bundle-input tests in `test/vendor-provenance.test.ts` enforce this boundary.

Foreground, `pageshow`, `online`, and Network Information transitions replace stale relay sockets. When `CollabEmbedOptions.probeGateway` is supplied, recovery probes the selected gateway (`"healthy"` on a valid session list, `"unavailable"` on transport or server failure, and `"forbidden"` on a readable `403`, which stops automatic relay refresh and probe retries until a foreground or online transition); non-embedded callers fall back to same-origin `GET /api/v1/health`.

`CollabEmbedState.loading` publishes `{ received, total } | null` snapshot counters without transcript payloads so the shell renders connection progress ([View and Control](../../docs/USAGE.md#view-and-control)).

Optional `CollabEmbedOptions.takeInitialPromptDraft` drains a shell-bounded volatile first-task draft (capped by the host shell at 8,000 code points and 32 KiB) once into an empty `Composer.tsx` input in live writable **Control** when the relay is healthy, no Ask is active, and no photo draft or send is in flight; reconnects, rerenders, and disposal never reapply or persist it ([Protocol §5](../../docs/PROTOCOL.md#5-in-memory-collab-client-bootstrap)).

The codec and tool renderers use `@oh-my-pi/pi-wire` shared envelope functions, the vendored `asStrictBytes` byte-buffer helper, `wait` message-list rendering with an adapter for older single-message/null/empty host results, job-intent labels with command fallback, `eval` table/JSON/Markdown views, and retained hub-family tool cards (`hub`, `irc`, `job`, `await`, `poll`, `cancel_job`).

Live bash cards render command, text, image, and status output while ignoring `details.trace` string or byte-array fields.

Streaming updates publish at most once per animation frame while non-streaming frames flush synchronously, with memoized `Composer` and `HeaderBar` props, separate committed-tool scanning, and idle agent-drawer polling shutdown. Guest-replica snapshots buffer until the final chunk or promised entry count, keeping the last published rows visible during resynchronization and clearing finished stream ghosts.

`upstream/src/components/transcript/Transcript.tsx` renders the newest 150 entries (`TRANSCRIPT_WINDOW`) and reveals 300 more per **Show earlier** tap (`TRANSCRIPT_WINDOW_STEP`), pinning the oldest visible entry and scroll offset across live appends and reconnects while pairing tool results across the full retained history. Bottom-lock holds within 40 px of the tail, and a monotonic `liveEpoch` returns the main transcript to the latest message on connect and reconnect.

Markdown and math rendering (`upstream/src/components/transcript/Markdown.tsx`, `math.ts`) uses KaTeX `0.18.5` native MathML (`trust: false`, math dimensions capped at 100 em, no KaTeX CSS or remote fonts) and seven pure TypeScript helpers vendored from `@oh-my-pi/pi-utils` `18.18.0` under `upstream/src/vendor/pi-utils/` (licenses in `licenses/pi-utils-marked/LICENSE`).

Links and image sources in settled and streaming blocks pass through browser URL parsing and `http:`/`https:` (plus `mailto:` for links) allowlists, and text stacks fall back to the gateway's self-hosted `"Symbols Nerd Font Mono"` face for Private Use Area glyphs (such as icons printed by `ls` or `eza`) only.

In writable **Control** sessions, `upstream/src/lib/photo-attachment.ts` validates and normalizes photos before `Composer.tsx` and `GuestClient.sendPrompt` (`upstream/src/lib/client.ts`) send them in encrypted `{ t: "prompt", text, images }` relay frames without touching the gateway HTTP server or service worker ([View and Control](../../docs/USAGE.md#view-and-control)).

The browser accepts up to four JPEG, PNG, or WebP attachments (24 MiB max source file, 8,192 px max edge, 20 megapixels) and normalizes each to a metadata-free JPEG within a 2,048 px edge and 1 MiB cap, retaining volatile previews for bounded retry until the host echoes the entry or the user removes or leaves it; **View** capabilities reject every mutating client method.

Composer speech input (`upstream/src/lib/speech-recognition.ts`, `upstream/src/components/shell/SpeechInput.tsx`) pairs keyboard-dictation help with opt-in gesture-started Web Speech (`SpeechRecognition` / `webkitSpeechRecognition` in a secure context when `CollabEmbedOptions.browserRecognitionEnabled` is `true`; [Dictation and speech input](../../docs/USAGE.md#dictation-and-speech-input)).

The recognizer runs with `lang` set to `navigator.language` (falling back to `en-US`), `continuous = true`, `interimResults = true`, one alternative (`maxAlternatives = 1`), and no automatic restart. Capture enforces a 10 s start watchdog, a 120 s (two-minute) recording limit, a 5 s stop watchdog, and review-buffer caps of 128 result segments, 8,000 Unicode code points, and 32 KiB of UTF-8 text; generation, Ask, liveness, or lifecycle changes discard active capture, and no audio is stored or sent to the gateway.

`upstream/UPSTREAM.json` schema version 1 records source paths, versions, commits, helper blob hashes, `excludedEntrypoints`, and `localPatches.active` / `localPatches.retired` (`id`, `purpose`, `files`, `proof`, `upstreamStatus`, `removeWhen`), while `upstream/LICENSE` retains the upstream license. `test/vendor-provenance.test.ts` verifies helper bytes, regression proof test titles, and the production bundle graph offline.
