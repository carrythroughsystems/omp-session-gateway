# Canonical README media

These files are deterministic public fixtures. Every session title, project label, request, and notification shown here is synthetic. Never replace them with a personal or production capture.

This is a synthetic product demonstration, not release-qualification evidence. Its source revision and browser-client provenance are recorded below. The notification toast is capture-only chrome, not a real system notification or proof of background Web Push delivery.

## Regenerate and verify

From the repository root after installing the locked dependencies:

```sh
bun run media:capture
bun run media:check
```

`media:capture` builds the actual PWA and pinned collaboration client before capture. It publishes the canonical set only after staging the complete package. `media:check` verifies the binaries, manifest, public-safety rules, and root README references; it does not regenerate media. Both use `packages/collab-client/upstream/UPSTREAM.json` for browser-client provenance, independently of the OMP host baseline.

Source revision: `ea7b101b61f0afe753e4dbbc4e4e65c366bf57ed`  
Pinned client: `v18.12.6` / `45c35e40c46166dc726ccc52f5d27f40f2449f99` (`@oh-my-pi/collab-web` 16.3.6)

Normalized tool versions:

- Bun 1.4.4
- TypeScript 7.0.2
- Playwright 1.62.1
- Chromium 151.0.7922.34
- FFmpeg 9.0
- ffprobe 9.0.2

The synthetic clock is 2026-08-21T12:10:00.000Z, with locale en-US, timezone UTC, dark color scheme, and reduced motion. Mobile captures use a 390×844 CSS-pixel viewport at DPR 2, producing 780×1688 PNGs.

## Pixel provenance

| Files | Provenance |
| --- | --- |
| `01-all-clear.png`, `02-needs-you.png`, `04-notification-settings.png` | Raw viewport screenshots of the actual built PWA. No frame, caption, marker, toast, crop, or compositor pixels. |
| `03-open-request.png` | Raw viewport screenshot of gateway chrome containing the actual built, pinned OMP collaboration client and its synthetic encrypted ask. |
| GIF, MP4, poster, product-flow board | Offline presentation composites. The embedded phone screens are complete runtime screenshots; the surrounding grid, editorial copy, phone frame, arrows, one tap marker, and Android notification toast are capture-only chrome. |

The capture-only Android toast uses the strict product title “OMP session needs attention” and the default Session-detail body. It is not a product DOM element or a real system notification. The animation’s discovered fifth session comes from a real fixture SSE upsert, and the tap marker is derived from the runtime Open request button bounds.

Runtime requests are restricted to the same-origin loopback fixture. The compositor accepts no requests and embeds local images and the Gate mark as data URLs. The capture records no origin, port, capability, room key, endpoint, hostname, account, or filesystem path.

Security boundary: loopback-only gateway · memory-only capabilities · no transcript storage. Community project; not affiliated with OMP.

## Seeded state

The opening contains four live sessions: Release qualification, Android reconnect soak, and Upstream compatibility working, and Docs & examples idle. Gateway auth hardening then arrives as a fifth working session before becoming the oldest of two waiting asks; Release qualification is second. Open request launches Control for the synthetic “How should ADR-0036 proceed?” ask with two synthetic options.

The canonical directory contains only the eight binaries, this provenance file, and `manifest.json`. The [unposted launch-copy draft](../LAUNCH_COPY.md) lives outside the synthetic-media fixture directory. The checker rejects every unexpected file, including concepts and contact sheets.

When intentionally refreshing media for a changed PWA, pinned client, capture copy, spacing, typography, or responsive layout, regenerate the entire set and update its provenance together. A documentation-only refresh does not recapture or relabel historical assets. Do not hand-edit a binary or reuse a concept image from the desktop media pack.
