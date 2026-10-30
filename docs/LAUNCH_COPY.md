# Launch copy — DRAFT, not posted

> **Status: draft only. Nothing in this file has been posted, submitted, or scheduled anywhere.**
> Prepared for published stable [v0.4.0](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.0).
> Immediately before any use, reverify release, setup, and support claims against the
> [release ledger](RELEASE_STATUS.md) and [compatibility policy](COMPATIBILITY.md).

Stable is the published release classification, not a claim of universal support or production
readiness. This is an independent community project, not affiliated with or endorsed by the Oh My Pi
maintainers. Native integration means using the registry and controller shipped in stock OMP
`>= 18.1.20`; it does not mean the gateway ships with OMP or needs no setup.

Existing media is a **synthetic product demo**, not a release-qualification
receipt. Preserve its [recorded provenance](media/README.md). The Android toast is capture-only chrome,
not a real system notification; background Web Push remains unqualified on the mainline matrix.
Do not attach these assets without that context or replace them with personal session captures.

## Pre-publish checklist

- [ ] [v0.4.0](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.0) still matches
      the intended release and the current ledger; all outbound links resolve.
- [ ] Setup still requires the separate gateway, Bun 1.4.4, one-time `collab.autoStart`,
      and TUN-mode Tailscale Serve with an exact allowlist and Funnel disabled.
- [ ] Exact host/client qualification and known limits still match the compatibility policy.
- [ ] Attached media are canonical, unmodified, and explicitly labeled synthetic product demos;
      no real hostname, path, account, capability, or transcript appears.
- [ ] No wording implies guaranteed alerts, production readiness, broader platform qualification,
      personal experience, or upstream affiliation.
- [ ] Every open external report has a maintainer reply; nobody's setup or words are reused
      without their permission.
- [ ] The target subreddit's sidebar and pinned threads were re-read immediately before
      submission; a held or removed post goes to the moderators, never to a reposted variant.

## GitHub repository description

**Live terminal OMP sessions, one private mobile page. Uses stock OMP ≥18.1.20 — no fork or gateway-specific OMP plugin.**

## README one-liner

**Every live OMP session. One private mobile page. Works with stock OMP 18.1.20+.**

## GitHub release summary — published stable v0.4.0

**Leave the terminal. Keep the session.**

OMP Session Gateway is a private mobile directory for running interactive Oh My Pi sessions.
Open View or Control in OMP's existing encrypted collaboration client without copying a link
for each session. The gateway keeps bounded session metadata, not transcripts.

[v0.4.0](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.0) uses the native
registry and controller shipped in stock OMP `>= 18.1.20`: no fork, custom OMP build, or
gateway-specific OMP plugin. Install the separate gateway with Bun 1.4.4, enable
`collab.autoStart` once, and configure TUN-mode Tailscale Serve with an exact user allowlist and
Funnel disabled. Then start participating sessions with plain `omp`.

The exact signed-candidate matrix used OMP 18.1.20 and Bun 1.4.0 on Debian 13 x86-64 and
macOS 26.6.1 arm64, with a physical Pixel 10 Pro running Android 17 and Chrome 152.0.7977.82.
The relay check passed for **1,800 seconds**, not eight hours. A separate published-byte
local/Pixel smoke passed with the existing OMP 18.1.21; that does not expand the exact matrix.
Its initial Control-upgrade failure matches a since-diagnosed PWA update navigation.
Windows, background Web Push, specialized attention, branch/resume, and broader host/browser
combinations remain unqualified. See the
[release ledger](https://github.com/alphastorm/omp-session-gateway/blob/main/docs/RELEASE_STATUS.md)
and [compatibility policy](https://github.com/alphastorm/omp-session-gateway/blob/main/docs/COMPATIBILITY.md)
for evidence and limits.

Community project; not affiliated with or endorsed by the Oh My Pi maintainers.

*Optional media: `omp-session-gateway-product-flow.png`, labeled “Synthetic product demo;
not release-qualification evidence.” Preserve the media provenance above.*

## X post — product-first

Your live OMP sessions. One private page on your phone.

OMP Session Gateway v0.4.0 uses stock OMP ≥18.1.20 — no fork or gateway-specific OMP plugin.
One-time setup; then plain omp.

https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.0

## X post — tighter

Leave the terminal. Keep the session.

OMP Session Gateway v0.4.0 brings View/Control for running terminal sessions to a private mobile
page using stock OMP ≥18.1.20. Separate gateway + Tailscale setup required.

https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.0

*For either post, link-only is sufficient. If attaching existing media, include the
synthetic-demo caption and notification caveat above; do not imply fresh release qualification.*

## Reddit — r/PiCodingAgent (first gateway launch)

One relevant resource/demo post. Name Oh My Pi explicitly: the gateway targets OMP, not vanilla
pi. Publish when the first discussion window can be monitored, spaced apart from other
promotional posts; the subreddit's promotion rules take precedence over any schedule.

**Title:** A private phone dashboard for live Oh My Pi sessions—now works with stock OMP

**Body:**

i built a small companion for people running several Oh My Pi sessions: one private page on your
phone showing what's running and what needs your input.

it discovers collaboration-enabled sessions automatically, surfaces the ones waiting for you, and
opens the right session in OMP's existing encrypted View/Control client. the agent keeps running
in your terminal.

v0.4.0 now works with stock OMP 18.1.20+, so there's no gateway-specific OMP fork to install.
enable collaboration once; no copying a fresh link or scanning a QR code for each session.

it uses Tailscale Serve on your private tailnet, not a public dashboard. it works in any modern
browser, and CI tests Linux, macOS, and Windows hosts with Chrome, Edge, Firefox, and Safari. the
Android/Chrome path is qualified on real hardware; background notifications aren't a stable
support claim. the README has the exact matrix.

repo and setup: https://github.com/alphastorm/omp-session-gateway

would love a few existing OMP users to try opening one of their own sessions from their phone and
tell me what felt clunky.

**Asset:** the existing `omp-session-gateway-demo.mp4`/`.gif` — directory → Needs you → the exact
OMP request. **Caption:** "Synthetic demo data: session directory → Needs you → the exact OMP
request."

## X post — clip reuse

which of your coding agents is waiting for you?

omp-session-gateway puts live Oh My Pi sessions on one private phone page. open the exact request
through OMP's existing encrypted client.

now works with stock OMP; no custom fork.

[synthetic-demo-labelled clip + repo link]

## OMP Discord — tester request

Use the one durable gateway thread. Post only for a real change or a new tester task; keep
ongoing support in the thread. Ask maintainers whether a resource link or pin is appropriate.
Never ask for upvotes on external posts.

small update: [one material change]. i'm looking for 2–3 people on [supported setup] to try
[opening one of their own live sessions from their phone with View or Control]. demo + exact
setup: https://github.com/alphastorm/omp-session-gateway. please reply in this thread with your
environment and the first step that gets stuck—no private logs or prompts needed.

## Moderator query — when promotion eligibility is unclear

hi—i maintain omp-session-gateway and have shared a few relevant replies here. i'd like to make
one dedicated post showing [specific workflow], with a short demo, the supported setup and an
explicit author disclosure. would that be appropriate under the current promotion rules, or
should i use a designated thread?

For r/LocalLLaMA, separately describe the actual AI involvement in development and ask how its
rule on LLM-generated content applies; do not paste these drafts there. r/selfhosted requires
the New Project Megathread for projects younger than three months by creation date.

## Show HN title — deferred

Deferred until an independent clean install and a clear demonstration exist; Show HN expects
something readers can try with a low trial barrier.

**Show HN: OMP Session Gateway – live terminal sessions, one private mobile page**

## Show HN body

OMP Session Gateway is for keeping work in the terminal while reaching a running OMP session
from a phone. It discovers participating interactive sessions through stock OMP's native local
registry, then opens View or Control in OMP's existing encrypted collaboration client.

Stock OMP `>= 18.1.20` supplies the registry and controller. No OMP fork, custom build, or
gateway-specific OMP plugin is needed. The gateway is still a separate install: use Bun 1.4.4,
enable `collab.autoStart` once, and set up TUN-mode Tailscale Serve with an exact user allowlist
and Funnel disabled. After that, start sessions with plain `omp`; no per-session link copying.

The gateway is a directory and launch broker, not a replacement chat client or a public dashboard.
It keeps bounded metadata rather than transcripts. Published stable
[v0.4.0](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.0) is qualified on the
exact Debian/macOS/Pixel combination in the
[compatibility policy](https://github.com/alphastorm/omp-session-gateway/blob/main/docs/COMPATIBILITY.md),
not every device or later OMP version. The fresh relay check was 30 minutes, not eight hours;
background Web Push and the other excluded workflows are not part of that claim. The
[release ledger](https://github.com/alphastorm/omp-session-gateway/blob/main/docs/RELEASE_STATUS.md)
also retains an initial Control-upgrade failure that matches a since-diagnosed PWA update
navigation. Feedback on setup friction and real phone workflows is welcome.

Independent community project; not affiliated with or endorsed by the Oh My Pi maintainers.

## Launch ledger

A user outcome is someone outside the maintainer's machines seeing their own live OMP session
from their phone, opening the correct session, and using View or Control. Repeat use a week later
is a separate observation. Ask for host OS, phone/browser, OMP version, the first failed setup
step, and whether the workflow was useful; never for prompts, capabilities, tokens, or logs.
Star changes after a post are temporal association, not attribution; clone counts include
automation. GitHub traffic snapshots stay out of this public file.

Baseline, 2026-09-18 (GitHub API): **21 stars**, 2 forks, repository created 2026-07-19.

| Date | Channel/post | Stars before | Stars +72h | Stars +7d | Post views +72h | Qualified attempts | First successes | Returned after 7d | Minutes spent |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| | | | | | | | | | |

| Handle | Self-reported source | Host/phone/OMP | Tried install | First success | Return use | Main blocker | Permission to share |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

Decision rules: few views → recheck eligibility, title, audience, distribution; views and stars
but few attempts → clarify eligibility and the first step; attempts but few successes → fix the
observed blockers before more promotion; successes but no return use → investigate the recurring
use case; repeat users in one community → spend the next month's effort there.

## Phrases to avoid

- “Zero setup” or “zero-touch install.” The gateway, OMP setting, and tailnet need one-time setup.
- “Manage all your agents from anywhere.” Too broad; implies a replacement client and public reachability.
- “Your AI command center.” Generic and incorrectly expands the product boundary.
- “Never miss anything” or “reliable background alerts.” Background Web Push is not qualified here.
- “Military-grade security.” Meaningless and unsupported.
- “Works on every device” or “all OMP versions supported.” Contrary to the exact qualification model.
- “Production-ready” or transferred eight-hour endurance claims. Published stable does not establish either.
- Invented first-person origin stories, usage reports, or testimonials.
- Anything implying Oh My Pi affiliation, endorsement, or an official gateway product.
