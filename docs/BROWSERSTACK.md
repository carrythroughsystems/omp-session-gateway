# BrowserStack: synthetic visual review

BrowserStack's open-source sponsorship supplies the products below until **2027-10-20**.
Percy is advisory visual review of authored synthetic fixtures, not functional browser testing or
signed-release device qualification. See [ADR-035](DECISIONS.md#adr-035--advisory-percy-review-of-capability-free-serialized-fixtures).

| Product | Entitlement | Repository role |
| --- | --- | --- |
| Percy Professional | Project-configured renderers and snapshot quota | Advisory visual review of synthetic DOM and first-party assets |
| Automate Mobile | Five parallel real-device mobile-browser sessions over WebDriver | Separate deviceCloud work under ADR-032 |
| Live Desktop & Mobile | One user, manual | Exploratory review of capability-free fixtures only |

## Percy scope

`bun run test:visual` builds the real dashboard and pinned collaboration client, then validates six
states at each of three Chromium source viewports. These are CSS viewport sizes, not emulated or
qualified devices; 810×1080 matches the qualified ninth-generation iPad's CSS viewport without
claiming this lane runs on that iPad.

| Source project | CSS viewport |
| --- | --- |
| `visual-phone-390x844` | 390×844 |
| `visual-tablet-810x1080` | 810×1080 |
| `visual-desktop-1280x800` | 1280×800 |

The states are `directory-empty`, `directory-all-clear`, `directory-needs-you`,
`settings-enabled-session`, `collab-view`, and `collab-control-ask`. Each snapshot is named
`state / project`: **18 distinct snapshots**, each serialized at its own width. The clock and
randomness are fixed; locale is en-US, timezone UTC, theme dark, reduced motion on, DPR 1.
Directory asks contain metadata only. Collaboration prose and code are explicitly authored
synthetic content, never a recorded conversation. The shared fixture preserves README capture
defaults; this lane does not regenerate media.

The installed `@percy/dom` serializer supplies the preflight HTML and resources, using the same
options as `percySnapshot`. Every serialized upload is checked again immediately before the SDK's
POST. The fixture's closure-owned guard rejects full synthetic capabilities, room ID, key and
16-character segments, including escaped forms; capability and identifier scanners run on HTML,
resource strings and decoded resource bytes. Unexpected surfaces or warnings fail, never redact.
Source and script-disabled serialized geometry must agree, including the 560px directory and
900px desktop View transcript, with the header aligned to the session column. Control Ask keeps
the client's existing 880px bounded embedded body and requires exact geometry parity, not a
900px inner transcript. Asset discovery is
restricted to the fixture host, uses Playwright's installed Chromium, and keeps JavaScript off.
No Percy output, trace, screenshot, video, raw SDK diagnostics or error-log upload is retained.

## Set up the Percy project

1. Create a dedicated **web** Percy project for these synthetic fixtures, connected to this
   repository. Do not share a project/token with production captures or real sessions.
2. The maintainer chooses renderers in Percy project settings, not this suite. Recommended:
   **Chrome, Firefox, Safari, and Edge**; add **Safari on iPhone** and **Chrome on Android** if quota
   allows. Confirm the rendering/billing multiplier for 18 snapshots before enabling all browsers.
   Renderer availability and the account's quota remain account configuration, not repository facts.
3. Keep JavaScript rendering disabled. Review access and retention, and record the chosen project,
   renderers, quota, project owner, baseline approver and sponsorship-renewal owner in the
   maintainer-controlled project settings. Never record its token in this repository.
4. Store the project token as the repository Actions secret `PERCY_TOKEN`. The workflow exposes it
   only to the eligible upload step. Do not put it in a command argument, artifact or local file.
5. Run `bun run test:visual` without a token. For a real upload, supply the token through the
   process environment and run `bun run test:visual:percy`. Missing credentials fail with
   `visual upload: PERCY_TOKEN is required`; an unhealthy server, SDK warning, skipped submission,
   fewer than 18 submissions or failed finalization also fails. Upload never falls back to local.
6. Establish the baseline from `main`; confirm all 18 names, widths, commit association, intended
   renderers and resource graph. Then make a temporary CSS perturbation on a disposable branch,
   confirm a reviewable Percy diff, and discard that perturbation. These two real-service proofs
   require the maintainer's token and are not implied by local validation.
7. Exercise a same-repository PR, fork PR and gateway-ci dispatch. Confirm forks/fleet receive no
   token and report **not uploaded**, and a missing token visibly fails eligible uploads.

CI always runs local validation on fixed `ubuntu-24.04`, never the fleet. Uploads run on
same-repository `pull_request`, `main` push and GitHub-hosted manual dispatch. Fork PRs and **all**
gateway-ci dispatches are local-only, even though this job itself is GitHub-hosted. This means
covered PR updates and main changes, not unpublished feature-branch commits. Failure is visible;
the lane has no `continue-on-error`, retry or silent no-op, but is **not a required merge check**.

## Review and baseline policy

- Keep both `visual-review` and Percy statuses advisory, separate from functional supporting lanes.
- Maintainers inspect every changed snapshot; do not auto-approve or auto-update baselines.
- Approve only intentional layout/content changes after the functional checks pass. An unavailable
  vendor is a failed advisory upload, not a functional regression and not a release qualification.
- Review capture-tool/serializer/Chromium changes together with new baselines. Percy and Playwright
  are exact devDependency pins excluded from Dependabot; runtime output stays first-party.
- No real Percy build or deliberate visual-diff proof is claimed until those checks are observed
  in the configured project. No new supported or qualified platform follows from a Percy render.

## Live rule

Live is manual, one-user exploratory review of **capability-free synthetic fixtures only**.
Never connect Live to a production gateway, real OMP process, tailnet service, or a fixture that
can acquire even synthetic View/Control canaries. This change supplies no Live launcher or tunnel;
local fixture availability does not authorize forwarding a gateway. Manual observations are not
functional CI or qualification evidence.

## Automate

Automate is being added as the deviceCloud fallback vendor for the iPad and Samsung Android targets under an [ADR-032 amendment](DECISIONS.md#adr-032--qualify-iphone-ipad-and-android-browsers-on-real-cloud-devices-in-every-stable-campaign).

## Sponsorship renewal

The sponsorship expires **2027-10-20**. The maintainer responsible for the project must review it
on **2027-09-20**: verify entitlement, quota, upload health, access/retention and renewal ownership.
Renew before expiry, or explicitly remove the upload credential and update workflow expectations
and the README BrowserStack claim together. Do not silently leave a green local-only check or
stale attribution implying continuing BrowserStack execution after uploads stop.
