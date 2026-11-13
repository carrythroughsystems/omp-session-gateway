# Test plan

This test plan tells contributors and maintainers which automated suites, leak scans, acceptance scenarios, and continuous-integration (CI) lanes prove each contract in OMP Session Gateway, the companion to Oh My Pi (OMP), and how to run them from a checkout.

Automated suites prove **Tested** scope ([Status vocabulary](COMPATIBILITY.md#status-vocabulary)), not physical-device or release qualification. Qualified hardware, the latest release, and lane receipts are recorded in [Current claim](COMPATIBILITY.md#current-claim) and [Release status](RELEASE_STATUS.md); historical fork-era receipts do not transfer.

## How to run the suites

Prerequisites: install Bun `1.4.4` (confirm with `bun --version`) and run `bun install --frozen-lockfile`.

Browser and visual suites also require Playwright browser binaries (`bun install` does not download them): run `bunx playwright install chromium` before `bun run test:browser` or `bun run test:visual`, and `bunx playwright install chromium firefox webkit` before `bun run test:browser:compat` (add `--with-deps` on Linux if Firefox or WebKit system libraries are missing; `bun run test:visual:percy` setup is in [Set up the Percy project](BROWSERSTACK.md#set-up-the-percy-project)).

| Command | Script or target | What it runs and checks |
| --- | --- | --- |
| `bun run check` | Composite contributor gate | `check:repository`, workspace `typecheck`, web `build`, `bun test`, `check:capability-leaks`, and `check:identifier-leaks` |
| `bun run check:portable` | Cross-platform CI gate | Same pipeline as `check`, replacing `bun test` with `scripts/test-portable.ts` |
| `bun run test` | `bun test` | All unit, integration, and script suites (`apps/*/test`, `packages/*/test`, `scripts/*.test.ts`) |
| `bun run test:browser` | `scripts/test-browser.ts` | Builds `apps/web`, runs all Playwright `*.e2e.ts` suites on two mobile Chromium viewports, and writes flake evidence |
| `bun run test:browser:compat` | `scripts/test-browser.ts --compat` | Builds `apps/web` and runs `@core` Playwright suites on desktop Chromium, Firefox, WebKit, and iPhone-class WebKit |
| `bun run test:visual` | `scripts/test-visual.ts local` | Builds `apps/web` and validates 21 synthetic snapshots and source-to-serialized geometry locally without Percy |
| `bun run test:coverage` | `bun test --coverage` | Runs all `bun test` suites with `--parallel=1` and writes LCOV output (`coverage/lcov.info`) |
| `bun run check:capability-leaks` | `scripts/check-capability-leaks.ts` | Scans tracked text files, `LICENSE`, and `readiness-token` paths for capabilities, room/key material, and tokens |
| `bun run check:identifier-leaks` | `scripts/check-identifier-leaks.ts` | Scans tracked text files for workstation names, home paths, tailnet names, and non-placeholder emails |
| `bun run check:repository` | `scripts/check-repository.ts` | Checks required files/schemas, `changelog.d/` fragments, workflow Bun pins, Dependabot ignores, e2e waits, and `adb`/fetch guards |

- `scripts/test-portable.ts` runs every tracked `*.test.ts` file with a 240-second per-file timeout (`2 * HANG_DEADLINE_MS`), excluding only host-OS-bound files listed in `HOST_BOUND_TESTS` with their platform and reason.
- `apps/web/playwright.config.ts` (`test:browser`) tests `411x816` (`DPR 2.625`) and `390x844`; `apps/web/playwright.compat.config.ts` (`test:browser:compat`) tests `1280x800` desktop engines (blocking service workers on desktop WebKit) plus `iphone-webkit`.

## Activity extension scenarios

Activity-stop implementation checks exercise OMP host (one running `omp` process) snapshot transitions, where `generation` is OMP's counter that increments when a session is replaced and a **View** or **Control** link is a bearer secret, called a capability in the contracts:

- Mixed current and legacy OMP host snapshots: `busy` `true`/`false`, missing or `null` unknown, and malformed rejection.
- Known `true`-to-`false` edge only on a continuing instance and generation with neither sample waiting for input.
- No stops from first idle, repeated idle, retained or query gaps, unknown activity, replacements, removal, expiry, or restart; activity changes never extend TTL.
- Ordered internal delivery and reentrancy, queued stop `busy` → `idle` → `busy` (ABA) invalidation, and no internal activity event on browser Server-Sent Events (SSE).
- **View**-only stop eligibility, no history replay on subscribe or renew, and all three server privacy detail levels.
- Shared per-instance tag, no Web Push `Topic`, displayed request priority, and request-specific clears that never close an activity stop.
- Scrubbed routes, same-generation **View**-only launch, changed or gone targets, and no new secret sinks.
- Built browser activity labels, notification navigation, and supported viewport layouts ([Activity-stop notifications](ATTENTION_SPEC.md#activity-stop-notifications)).

These suites are implementation checks, not a physical-device or background-delivery qualification claim.

## 1. Unit tests

### Real-process hang detection

Use `HANG_DEADLINE_MS` (120 seconds) from `apps/gateway/test/test-support.ts` for real subprocess and PTY exits, socket readiness and closure, and I/O helper completion. That bound is nearly four times the longest sampled hosted Compatibility timing (30,045.06 ms) and exceeds two 45-second Windows ACL cold attempts plus teardown.

This value is a hang guard rather than a latency contract: passing steps resolve on exit or readiness without sleeping, and outer test timeouts must exceed all sequential guard windows plus setup and teardown (at least `2 * HANG_DEADLINE_MS`, multiplied for multi-process supervisors).

`check:repository` rejects shorter literal timers in `Promise.race`, process-kill watchdogs, and `AbortSignal.timeout` unless annotated with `// hang-deadline: behavior-under-test -- reason` on the timer line or the line above it.

Product deadlines, fake timers, injected sleeps (such as the six-second child-startup delay in the CLI pruning regression), browser UX timing checks, and poll cadence are not hang budgets. Fixture acknowledgement polling also stops immediately on terminal refusal, including Windows rejection of POSIX-private file modes.

### OMP discovery, queries, and registry

- exact discovery-file and snapshot/reply validation; unknown versions and malformed or oversized data;
  date-range boundaries and per-host projection failure isolation beside a healthy peer;
- private ownership/permission checks, symlink rejection, and reading the published endpoint rather
  than deriving it, including OMP’s relocated long-path socket ([Mainline OMP discovery reader](ARCHITECTURE.md#11-mainline-omp-discovery-reader));
- newline framing, one request per connection, and bounded query time/bytes;
  immediate replies and post-timeout connection callbacks close without late request writes;
- metadata-only snapshots and per-launch links: no prefetch or registry capability retention;
- only `ENOENT`/`ECONNREFUSED` retires a queried host immediately; timeouts, permission/resource
  errors, malformed replies, and all wire errors retain metadata until TTL expiry;
- directory absence, transient unreadability, recovery, and host removal without filesystem writes;
- coalesced concurrent polls and reconciliation of observed/retained hosts;
- monotonic freshness independent of the OMP wall clock;
- generation, role, and request-identity revalidation across an asynchronous link query;
- bounded discovery entries and registry records;
- same-generation false-to-true-to-false attention transitions and stale-generation rejection.

The dedicated behavioral suite is `apps/gateway/test/omp-registry.test.ts`. Repository proof does
not qualify an actual OMP binary, native host, relay, or physical client.

### Opt-in Tern creation and embedded progress

Automated suites below verify opt-in session creation in Tern and embedded connection progress ([ADR-043](DECISIONS.md#adr-043--opt-in-tern-creation-with-omp-native-adoption); behavioral **Tested** coverage, not physical-device qualification):

| Area | Automated suites |
| --- | --- |
| Protocol | `packages/protocol/test/session-creation.test.ts` |
| Configuration | `apps/gateway/test/config.test.ts` |
| CLI adapter | `apps/gateway/test/tern-cli.test.ts` |
| Registry adoption | `apps/gateway/test/omp-registry.test.ts`, `apps/gateway/test/tern-creation.test.ts` |
| Durable service | `apps/gateway/test/tern-creation.test.ts` |
| HTTP and security | `apps/gateway/test/http.test.ts`, `apps/gateway/test/security-mutations.test.ts` |
| Operations and CLI | `apps/gateway/test/doctor.test.ts`, `apps/gateway/test/diagnostics.test.ts`, `apps/gateway/test/cli.test.ts` |
| Web directory and trays | `apps/web/test/fleet.test.ts`, `apps/web/test/app.test.ts`, `apps/web/e2e/session-creation.e2e.ts`, `apps/web/e2e/trays.e2e.ts` |
| Lifecycle and handoff | `apps/web/test/app.test.ts`, `apps/web/e2e/session-creation.e2e.ts` |
| Draft and progress | `packages/collab-client/test/embed.test.ts`, `packages/collab-client/test/initial-prompt-draft.test.ts`, `apps/web/test/app.test.ts`, `apps/web/e2e/embedded-progress.e2e.ts`, `apps/web/e2e/launch.e2e.ts` |

- Protocol: exact keys at every level, duplicate JSON keys, malformed/null/oversized bodies, canonical lowercase UUIDv4, ID/label/count bounds, all options availability reasons, receipt states, status field/error combinations, and parser/schema parity across all three public schemas.
- Configuration (schema and bounds): absent `tern` reports `not_configured` without probing; authored `"tern": {}` is preserved verbatim and reports `configuration_unavailable`, while nonempty partial `tern` objects missing `executable`, `projects`, or `profiles` are rejected; strict nested keys and 32-KiB section / 64-KiB document bounds.
- Configuration (paths, env, and rollback): absolute executables and canonical `realpath` working copies; `argv`/`env` entry and aggregate bounds; required absolute `HOME` and all-absolute non-empty `PATH` with no inherited `process.env`; authored-section preservation, byte-identical no-op reinstall, and `projectPreTernConfig` (`apps/gateway/src/config.ts`) rollback projection.
- CLI adapter: literal `argv` with no shell, labels, or task text; complete explicit `env`; lossless unsafe-number neighbors (`2^53 - 1`, `2^53`, `2^53 + 1`), uint64 edges, and bit-56 remote host tags; duplicate/malformed/trailing/oversized JSON and parser resource bounds; exact 1:1 block/pane equality with no focus/cwd/PID fallback; timeout, overflow, cancellation, and read-error kill/reap/stdout cleanup; one CLI child at a time.
- Registry adoption (polling and races): fresh round starts after request, older round queues one following round, coalesced waiters, cancellation isolation, reconcile-before-publish, and stop suppression; OMP discovery publication arriving before `tern new tab` returns, post-spawn poll before filename metadata, and old poll finishing after spawn.
- Registry adoption (binding and refusals): stale or baseline instance/session reuse, complete-token vs prefix collision, duplicate and ambiguous bindings, timestamp discontinuity, and missing metadata, early exit, **View**-only, and registry-capacity refusals.
- Durable service (state and capacity): every state edge and 110-second deadline; concurrent identical acceptance, changed-payload/revision conflict, current-state replay across revision/availability changes, identity isolation, global busy (`429 creation_busy`), full 64-record unexpired capacity (`503 creation_capacity`), and 24-hour expiry.
- Durable service (persistence and restart): injected failure before/after write, fsync, atomic publish, directory sync, spawn, receipt, and ready; `accepted`/`launching`/`awaiting_omp` restart classification with no automatic re-spawn; corrupt/unsupported/unsafe ledgers preserved; status `GET` never starts Tern.
- HTTP and security: exact routes/methods and no query strings; owner/unknown/expired return identical `404`; closed error codes and `no-store` on success/error; third-key `creation` rate isolation, duplicate-before-rate, and no `OPTIONS` charge; exact-origin, Fetch Metadata, and JSON context checks, authenticated route-specific `GET`/`POST` preflights, forbidden unsupported headers/methods/paths, and no CORS on excluded routes.
- Operations and CLI: no Tern check/probe when `tern` is absent; configured `ternAvailable` remains boolean without launching OMP; ledger, request, `argv`/`env`, and raw CLI excluded from diagnostics; shutdown finalization leaves tabs and OMP running; every managed rollback projects `tern` away with one full private backup, refuses overwrite, composes fleet projection, preserves the ledger, and keeps transactional failure recovery.
- Web directory and trays: local/remote and empty-directory **New session**; options/POST/status bounds and credentials; Host/Working copy skips, logical `onBack`/native cancel/focus/modality/48px controls within the three-panel tray limit; ID-only bounded `omp.sessions.creation-prefs.v1` validated against fresh options.
- Web creation watching: explicit Create UUID, serial 1-second polling and 120-second watch, lost acknowledgement and explicit identical replay, no automatic retry/create/open, and `403`/`404`/revision/busy/unavailable/terminal outcomes.
- Lifecycle and handoff: cancel watching on source/scope/tray/launch/auth/hidden/freeze/pagehide/Close while the daemon continues; at most one memory-only **Check creation** intent; source refresh, exact generation, and **Control** verified before ordinary launch; late/stale/colliding-source `ready` cannot open; background return never auto-opens; never substitute a newer generation.
- Draft and progress: initial `null`, loading, completion, and reconnect counters only (`Joining session… 43%` vs `Reconnecting… 43%`, floor/clamp/invalid totals, failure priority, no duplicate live-region announcements); 8,000-code-point / 32-KiB draft consumed once into empty healthy writable **Control** only while Ask, **View**, existing text, photo, or in-flight send block consumption (no auto-send, no reconnect/rerender reapply, and retry-before-mount or disposal clears the holder).

Creation leak fixtures plant synthetic prompt, label, path, `argv`/`env`, raw CLI, token, and capability sentinels across logs, problem responses, `<stateDir>/session-creations.json`, diagnostics archives, DOM/history, and browser storage/caches.

Execution values stay in private config and CLI memory, first-task text stays in volatile page/composer memory until explicit **Send**, no capabilities enter creation DTOs or the ledger, and creation never opens or modifies session JSONL files or OMP discovery artifacts.

### HTTP/auth

- missing Tailscale identity denied in production mode;
- disallowed login denied;
- allowed login accepted;
- localhost dev mode refuses non-loopback source;
- exact Origin enforcement;
- content-type/body-size enforcement;
- list/SSE browser-metadata schema;
- gateway-created attention identity is stable across repeated true updates and replaced on clear/re-arm or generation replacement;
- list/SSE contain only bounded labels, boolean attention, opaque request ID, and daemon receipt time—never a capability, transcript, answer, or tool output;
- launch generation mismatch returns 409;
- expired/missing returns non-enumerating 404;
- requested access mode unavailable on the OMP host returns `409 mode_unavailable`;
- all API responses no-store;
- CSP and security headers;
- strict push v2 config/subscription/unsubscribe schemas, exact-origin mutation enforcement, private persistence, detail-level migration, subscription bounds, and stale-endpoint removal;
- ordered attention/clear delivery, per-instance deduplication, exact-request clearing, pending-count badges, and generation-safe replacement.

### PWA local triage

- exact-ask Hold persistence, FIFO partitioning, explicit requeue, and garbage collection when the
  authoritative ask changes or clears;
- Hold leaves authoritative pending counts and badges unchanged and closes only the notification
  whose instance tag and request ID match;
- generation-scoped Hide, immediate local hiding, five-second Undo, persistent Show all, and
  zero network mutation when the Undo window expires;
- session removal, generation replacement, and later attention restore a dismissed row
  immediately, while transport failure preserves local routing choices;
- malformed, oversized, excess, or non-canonical local records fail closed within the documented
  bounds, and allowed records contain identifiers and timestamps only.

### Collaboration photo composer

- JPEG, PNG, and WebP inputs at or below an 8,192px edge and 20 megapixels normalize to JPEG no
  larger than a 2,048px edge or 1 MiB;
- the Photo control exposes two 44px choices; **Take photo** targets the environment camera input,
  **Choose existing** targets the no-capture library input, Escape closes the panel and returns
  focus, and cancelling either picker prepares nothing;
- unsupported, empty, over-24-MiB, over-dimension, undecodable, and over-detailed inputs fail
  visibly before decode or relay send;
- at most four volatile previews are retained; remove, host-confirmed send, and unmount drop
  preview data URLs and base64 references;
- text-only, photo-plus-note, and photo-only prompts produce the existing v3 frame shape, with the
  documented neutral text used only when the note is empty;
- an unacknowledged photo prompt retains its exact preview and note, disables editing, and offers
  retry after five seconds only when relay health is current; a matching `collab-prompt` entry
  clears it only after the recorded pre-send transcript baseline;
- a View link remains read-only when an older host omits the optional welcome flag, and direct
  prompt, abort, agent-command, fresh Ask response, and pending-response replay all emit no mutation;
- read-only, disconnected, and preparing states cannot open or submit the photo path;
- a moving status row cannot cancel a pointer-captured Send, Stop, remove, or camera action.

### Mainline OMP

- require stock OMP `>= 18.1.20`, `collab.autoStart` only, and plain `omp` startup;
- exercise the integration contract in [Mainline OMP integration](OMP_INTEGRATION.md) and record qualification evidence and limits in [Release status](RELEASE_STATUS.md);
- keep upstream collaboration controller tests upstream rather than maintaining a downstream OMP patch suite;
- stage the pinned platform native package in `linux-arm64-source-checkout` and run only upstream `registry.test.ts`, `registry-smoke.test.ts`, and `host-registry.test.ts` so gateway CI gates the discovery and query contract rather than unrelated upstream suites;
- cover Windows gateway contracts, ACLs, and service lifecycle in `windows-service-lifecycle`, while daily `canary-windows` exercises real named-pipe discovery as **Tested** evidence rather than qualification.

The daily [upstream OMP canary](../.github/workflows/upstream-canary.yml) installs latest stock OMP into an isolated directory on Linux (`canary`) and Windows (`canary-windows`).

Run it locally with `bun scripts/upstream-canary.ts --omp <binary>` (`--model <provider/id>` overrides the shared fixture model for diagnosis); it uses OMP's public relay, touches no phone, and proves neither model-provider completion nor relay endurance ([Daily upstream canary](LIFECYCLE_BRANCH_RESUME.md#daily-upstream-canary)).

- Ordered stages: `prepare`, `publish`, `snapshot`, `stale-generation`, `view`, `control`, `new-generation`, `fork`, `branch-rewind`, `continue`, and `unregister` (`prepare` resolves the installed manifest version, checks Bun against `engines.bun`, verifies the stock binary, and retains the resolved version if pre-`publish` fails).
- POSIX (`tmux` host, rotation and rewind): `/new` and `/fork` keep `instanceId`, increment `generation`, refuse stale **View**/**Control** queries once the new generation publishes, and issue fresh links (`fork` retains both synthetic prompts in a fresh **View** transcript); `branch-rewind` shows the anchored in-memory terminal status without printing capabilities and keeps `instanceId`/`generation` (replicated sibling entries cannot prove rewind).
- POSIX (`continue`): retires the old instance and links and publishes a new instance at generation 1 whose **View** transcript retains the pre-stop prompt.
- Windows (hidden console, process-tree termination, no keystroke transport): skips `new-generation`, `fork`, and `branch-rewind`, records `platform` in summary JSON, and rejects any other skip set.
- Unregister verdict: after `SIGTERM` (or Windows termination), requires PID exit plus either an absent discovery file or a gateway `gone` reply (never `unavailable`); stock 18.1.20 and 18.3.0 leave their publication on `SIGTERM`, which `discoveryFileRemoved` reports separately before OMP prunes its dead entry.

### Qualification tooling

`bun run check` executes offline fake-runtime suites for the release-qualification scripts without touching real VMs, phones, or cloud vendors (`scripts/stable-qualification.test.ts` and `scripts/testingbot.test.ts` are POSIX-bound in `check:portable`).

| Test suite | Script covered | Offline assertions |
| --- | --- | --- |
| `scripts/provider-read.test.ts` | `scripts/provider-read.ts` | Bounded provider-read retries, cancellation settlement, and zero replay of mutating requests |
| `scripts/android-device.test.ts`, `scripts/restoration.test.ts`, `scripts/android-acceptance.test.ts` | `scripts/android-device.ts`, `scripts/restoration.ts`, `scripts/android-acceptance.ts` | Fake-spawner `adb` redaction and exit handling, Wi-Fi/mobile-data baseline restoration, and Pixel lease poisoning |
| `scripts/stable-qualification.test.ts`, `scripts/release-driver.test.ts` | `scripts/stable-qualification.ts`, `scripts/release-driver.ts` | Campaign boundaries, 1,800-second relay floor, schema-3 receipts, cleanup containment, and hold/resume eligibility |
| `scripts/omp-lifecycle-qualification.test.ts`, `scripts/omp-lifecycle-development.test.ts` | `scripts/omp-lifecycle-qualification.ts`, `scripts/omp-lifecycle-development.ts` | `/new`, `/fork`, and `--continue` generation rotation, `409 generation_mismatch`, and instance replacement |
| `scripts/android-push-qualification.test.ts`, `scripts/android-push-runtime.test.ts`, `scripts/android-push-diagnostics.test.ts` | `scripts/android-push-qualification.ts`, `scripts/android-push-runtime.ts` | Local triage, delayed taps, twelve `fleet_*` phases, badge/clear observers, coordinator restart, and restoration |
| `scripts/qualify-macos-host.test.ts`, `scripts/qualify-rollback.test.ts` | `scripts/qualify-macos-host.sh`, `scripts/qualify-rollback.sh` | SSH/hardware preflights, stock OMP `>= 18.1.20` checks, host reboot guard, and staged Cosign rollback verification |
| `scripts/windows-stable-qualification.test.ts` | `scripts/windows-stable-qualification.ts` | Windows VM phase machine, WinRM/ACL checks, Pixel smoke cancellation restoration, and VM teardown |
| `scripts/device-cloud-qualification.test.ts`, `scripts/browserstack.test.ts` | `scripts/device-cloud-qualification.ts`, `scripts/browserstack.ts` | TestingBot and BrowserStack Automate admission, capability/media record audits, and deletion/absence verification |
| `scripts/testingbot.test.ts` | `scripts/testingbot.ts` | `op` service-account isolation, loopback tunnel and `CONNECT` proxy allowlist, and redacted page-evaluation errors |
| `scripts/android-leak-probe.test.ts` | `scripts/android-leak-probe.ts` | Sink sweeps across browser storage, caches, IndexedDB, and iOS Safari service workers without echoing matches |

Maintainer regression details, orchestration boundaries, and isolated development-step commands are in [9. Qualification tooling tests](#9-qualification-tooling-tests); live campaign procedures are in [Release procedure](RELEASE.md), [Physical background-Push lane](ANDROID.md#physical-background-push-lane), and [Windows qualification](WINDOWS_QUALIFICATION.md).

## 2. Secret-leak test harness

Secret-leak assertions run inside `apps/gateway/test/security-mutations.test.ts`, `apps/web/e2e/*.e2e.ts`, `apps/web/visual/snapshot-safety.ts`, `scripts/check-capability-leaks.ts`, and `scripts/check-identifier-leaks.ts`. Generate distinct per-host query tokens, readiness tokens, and capability canaries in test memory, never record **View** or **Control** links in fixture files or artifacts, and scan after each test:

- daemon stdout/stderr and structured logs;
- temporary/config/data directories;
- browser Local Storage, Session Storage, IndexedDB, cookies, Cache Storage;
- service-worker request cache;
- HTTP access logs/test recorder;
- generated diagnostics bundle;
- unhandled exception and snapshot output.

Fail on any canary or meaningful substring outside its designated source/sink. Per-host query
tokens belong only in private discovery fixtures and live query memory; readiness tokens belong
only in private readiness fixtures and proof memory. Neither enters logs or diagnostics.
View/Control capabilities are permitted only in live OMP/query/launch-response memory and the
collab client’s in-memory parsed value, never a gateway registry or file.

Add distinct prompt, option, prefill, answer, request, title, project, and capability canaries. Prompt,
option, prefill, answer, transcript, and capability canaries must remain absent from IPC logs/errors,
list/SSE, URLs/history, browser storage/caches, screenshots/traces, diagnostics, and repository
artifacts. Opaque synthetic request IDs are allowed only in list/SSE, encrypted push, request routes,
volatile DOM/history routing state, and bounded device-local held-ask records. Bounded instance IDs,
generations, and canonical timestamps are also allowed in the device-local Hold/Dismiss records.
Bounded title/project canaries are allowed in encrypted push and visible notification text only for
`session`/`preview`, never in persisted push or local triage state.
- generate photo-flow fixtures in the browser rather than checking real user media into the
  repository; scan gateway requests, browser storage/caches, diagnostics, logs, and retained test
  artifacts for the synthetic pixel/base64 canary. Its only permitted live sinks are volatile
  collab-client memory, the encrypted relay frame, and the receiving OMP test session;
- scan private push state, intercepted encrypted-payload plaintext, visible notification title/body/data, notification tags, app badges, and request-route history against the selected detail contract;

The Percy harness additionally scans the installed serializer's full HTML and every serialized
resource, including decoded bytes, before submission and again at the SDK POST. The fixture's
closure-owned full/room/key/16-character/escaped-material guard and both repository leak scanners
must fail on hidden attributes, current form values, inline styles, text, textual resources and
unsafe diagnostics without echoing matches. Negative tests reject unreviewed resources and
executable surfaces, SDK warnings/no-ops, unhealthy sessions and failed finalization. The safe
reporter emits only allowlisted state/project/phase names and counts; no trace, screenshot,
recording, raw SDK log or Percy output is retained as a CI artifact.

## 3. Integration tests

Integration scenarios below run under `bun run test` (`apps/gateway/test/omp-registry.test.ts`, `apps/gateway/test/http.test.ts`, `apps/gateway/test/push.test.ts`, `packages/collab-client/test/`) and `bun run test:browser` (`apps/web/e2e/*.e2e.ts`):

- OMP-shaped discovery/query fixture -> poller -> registry -> PWA card -> per-launch link;
- two hosts with the same PID but different instance IDs;
- three simultaneous hosts and changing metadata;
- gateway restart followed by polling/repopulation, without host reconnect;
- OMP starts before the gateway;
- readiness-token rotation has no OMP publication credential to re-provision;
- transient endpoint failure and recovery retain the same card until TTL;
- session generation replacement while phone card is open;
- launch race with process exit;
- SSE reconnect and full snapshot;
- Tailscale identity-header proxy fixture with direct backend spoof attempt;
- collab-web parse/connect against mock relay;
- view client write attempt is rejected;
- control prompt/interrupt against mock/real OMP host.
- explicit camera and existing-photo selection -> metadata-free bounded JPEG preview -> encrypted `prompt.images`
  frame -> real OMP host image prompt, with no gateway HTTP or service-worker media request;
- a pending response operation before any writer exists -> metadata attention -> later Control replay -> exactly one settlement -> authoritative clear;
- concurrent response operations and multiple Control writers preserve one boolean and settle each request once;
- generation replacement clears attention before removal and cannot be mutated by a stale lease;

- browser subscription -> gateway private state -> false-to-true registry transition -> selected-detail push -> service-worker notification;
- true-to-false/removal closes the per-instance notification, updates the badge, and cannot clear a re-armed request; `404`/`410` removes the endpoint;
- notification route revalidates exact current request identity and Control availability before the ordinary generation-bound launch;

### Fleet notifications: two-gateway automated scope

Fleet notifications (alerts from other hosts, where the home gateway sends Web Push alerts for selected remote hosts, called sources) have two-gateway automated coverage in `apps/gateway/test/fleet-two-gateway.test.ts`.

It runs under `bun test` in `implementation-checks` and on Linux, macOS, and Windows in `portable-source` without platform skips, proving **Tested** scope ([ADR-030](DECISIONS.md#adr-030--claim-support-for-ci-tested-platform-families-separately-from-qualification), [Status vocabulary](COMPATIBILITY.md#status-vocabulary)) rather than physical Push or release qualification.

| Scenario | Assertion |
|---|---|
| Browser-direct enrollment and narrow credentials | Two loopback HTTP gateways with separate origins and state directories run pending verifier, source grant, activation, and device selection; grant bearers cannot call other APIs or launches, and machine pulls carry no owner headers. |
| Same instance on local and remote hosts | Parsed v3 envelopes run through the shared worker reducer: distinct source-qualified tags and request IDs coexist with badge `2`; Session/Preview remote bodies carry only configured label and suffix, and Private has no body. |
| Resolution, live stop, revocation | Exact request/generation clears preserve local requests, and only an observed `busy` `true` → `false` edge emits a stop; source revocation closes its feed, returns unauthorized, and clears only that owner's selected devices. |
| Coordinator/source restart and outage | Persisted coordinator epochs advance without repeating stable remote requests or inventing stops, home restarts re-mint pending local requests once ([ADR-048](DECISIONS.md#adr-048--fleet-notifications-through-the-home-gateway-as-coordinator)), cold sources emit heartbeats only, and unreachable sources mark an incomplete badge. |
| Owner/device isolation and leak boundaries | Two owners with distinct device selections and detail levels reject cross-owner mutation and isolate revocations; remote title/cwd/preview canaries and grant secrets stay out of payloads, feeds, logs, and diagnostics, with grant secrets only in coordinator fleet state. |

`scripts/capability-leak-rules.test.ts` tests the fleet grant bearer's UUIDv4 and 43-character base64url shape across bare, JSON, `Authorization`, and URL forms. The capability scanner checks repository files; the identifier scanner covers non-credential personal and infrastructure identifiers.

## 4. End-to-end acceptance scenarios

### A. Automatic discovery

1. Start gateway and open PWA on Android.
2. With stock OMP `>= 18.1.20` and `collab.autoStart: control`, start three plain `omp` processes
   in different repositories.
3. Do not type `/collab`.
4. All three cards appear within the configured discovery poll interval plus bounded query and
   browser delivery time; record the measured latency rather than claiming push-era timing.

### B. View and control

1. Open View for process A; transcript streams and write controls are unavailable/rejected.
2. Open Control for process B; submit a benign prompt and interrupt it.
3. Host tools continue to execute on the desktop process, not the phone.
4. From the Pixel Control composer, open Photo and exercise both **Take photo** and
   **Choose existing**. Take a rear-camera photo, add a note, preview it, and send.
   Repeat without a note. The host receives one bounded JPEG each time and the active model can
   inspect it; View exposes no enabled photo action.
5. Drop one send before host acknowledgement and verify the exact draft remains until Retry is
   acknowledged. Remove a prepared photo, choose an unsupported/over-dimension file, and exceed
   the attachment bound. No rejected media reaches the relay, gateway, OMP transcript, browser
   storage, or test artifacts.

### C. Lifecycle correctness

1. Switch process A to a different OMP session.
2. Old generation becomes unlaunchable before new generation appears.
3. Exit process B normally; card disappears promptly.
4. Kill process C; card disappears no later than TTL.

The mainline canary and retained-Mac lifecycle runner provide executable transition coverage without proving unobserved intervals between samples; see [Lifecycle, branch, and resume](LIFECYCLE_BRANCH_RESUME.md) for invariants and limits.

### D. Phone/background behavior

Phase identifiers ending in `_verified` below are receipt flags in `scripts/android-push-qualification.ts` ([Physical background-Push lane](ANDROID.md#physical-background-push-lane)):

1. Open a live session.
2. Lock phone briefly, unlock, and resume.
3. Client reconnects automatically without leaving or reopening the session.
   Leave the directory in the background for over a minute: once Chrome freezes the page, the gateway sees its event stream close; returning opens a fresh stream from a new snapshot.
4. Switch Wi-Fi and mobile networks while Tailscale stays connected; when the browser process stays responsive, the directory and active **Control**/**View** recover without **Refresh**.
   - If Android has a healthy route while Chrome fails the gateway, an unrelated origin, and browser-control probes together, record a browser-environment failure rather than a PWA pass.
   - The visible directory must keep retrying, name the unreachable path, and open built-in shell help only after 45–60 uninterrupted visible failure seconds (excluding offline or hidden time, with no page-level browser-repair claim).
5. Android Back returns to the directory without leaving a secret-bearing history entry.
6. Enable background alerts explicitly (page load never prompts), select each detail level, and verify permitted title/body text with no session text in private push state.
7. Tap a notification: `/collab/:instanceId?request=:requestId` carries routing metadata only, revalidates current attention, and opens **Control** only for that request; tapping while a session is open switches in place without reload, keeps an open session on same-session taps (an activity stop never downgrades **Control**), and ignores stale taps.
8. Exercise offline, tailnet-unreachable, desktop-unreachable, gateway-unavailable, and relay-unavailable states: brief loss shows `Reconnecting…`, a three-second loss names the path and next retry, recovery confirms `Connected`, and the timestamped last authenticated list reconciles without **Refresh**.
9. Resolve, replace, expire, and `false`-to-`true` re-arm before tapping delayed notifications so each stale tap stays on the directory without requesting a capability.
   - `stale_taps_verified` re-presents metadata-only worker notifications for desktop resolution, same-generation replacement, new-generation replacement, and a gone OMP host, asserting lock-screen URL scrub before API calls, metadata fetch, zero launches, and the expired/changed notice (proving tap handling, not Web Push delay or ordering).
10. Verify one notification per instance, silent duplicate updates, authoritative clear, and `setAppBadge`/`clearAppBadge` pending counts.
    - `clear_verified` and detail phases check delivery and clear, `triage_verified` keeps held requests in the authoritative pending count, and fleet phases wrap `setAppBadge`/`clearAppBadge` in memory (removed on cleanup) to verify aggregate counts and the incomplete zero-count flag during source outages (without reading the Pixel launcher glyph; **Hosts** in **Settings** → **Background alerts** proves coverage separately).
11. Force-stop Chrome or disable notifications and exercise Android battery policy (`force_stop_verified`, `permission_verified`, `doze_verified`, lock/resume, and network phases), recording observed behavior without claiming guaranteed delivery.
12. Install an updated shell while idle (activates without **Refresh**) and during pending or active collaboration (keeps the mounted client until Back or Leave, then loads the updated directory; separate from `triage_verified` and `stale_taps_verified`).
13. Hold the oldest request from the dashboard and from an active collaboration shell. Verify the
    next unheld ask opens in FIFO order, the held ask remains in the authoritative pending/badge
    total, only its matching notification closes, and explicit requeue restores it.
    `triage_verified` exercises the installed directory with two fixture asks, zero non-GET gateway
    requests, and `N waiting · M held`. The active-shell scenario remains separate acceptance.
14. Hold every waiting request. Verify the device reports a clear couch queue without claiming the
    gateway is all clear, then replace one exact request and verify only that stale hold disappears.
    `triage_verified` requires `Queue clear · N on hold` and preserves the other exact hold.
15. Hide a non-attention row, exercise Undo, let a second dismissal expire, and use Show all.
    Verify no network mutation occurs; a new generation or later attention restores visibility
    immediately; live/working totals continue to include the hidden row; and the UI says OMP keeps
    running rather than claiming Close, Exit, or completion.
    `triage_verified` checks Undo within five seconds, expiry after a second Hide, `Live · N`
    retention, later attention restoration, and Show all. New-generation restoration remains a
    separate acceptance scenario, not a result of this physical phase.

### E. Authorization

1. Intended Android identity can access.
2. Public Internet and LAN-only clients cannot reach the service.
3. An unauthorized tailnet identity/device is denied by policy and by app allowlist.
4. Direct access to loopback is impossible remotely; a forged identity header does not bypass the tailnet path.

### F. Persistence

1. Launch and close both view and control sessions.
2. Restart browser and daemon.
3. No previous capability is recoverable from disk/browser history/storage/cache/logs.
4. The gateway rediscovers already-published live OMP hosts and rebuilds metadata-only records.
5. Device-local Hold/Dismiss state contains only the bounded identifier, generation, and timestamp
   fields; no title, path, model, prompt, transcript, or capability survives there.
6. A prepared-but-unsent photo disappears after remove, Back, reload, or client disposal and is
   absent from gateway/browser persistence and service-worker caches. A sent normalized photo may
   remain only through ordinary OMP transcript and model-provider retention; the original file,
   filename, and EXIF/location metadata do not.

### G. Tern, multi-host federation, and speech input acceptance matrix

The table below maps Tern ([ADR-038](DECISIONS.md#adr-038--tern-is-an-execution-environment-not-an-integration)), federated multi-host ([ADR-036](DECISIONS.md#adr-036--federated-dashboard-origins-through-browser-direct-cors)), and speech input ([ADR-037](DECISIONS.md#adr-037--speech-input-keyboard-dictation-baseline-and-opt-in-browser-speech-recognition)) acceptance categories.

In the procedures below, `omp-gateway <command>` denotes `bun apps/gateway/src/cli.js <command>` in an extracted release, or `bun apps/gateway/src/cli.ts <command>` from a repository checkout.

Unit and Playwright suites provide **Tested** evidence, developer-workstation runs provide **Smoke-tested** evidence ([§4.H](#h-tern-qualification-procedure)), and manual physical checks are recorded in [Release status](RELEASE_STATUS.md) when executed.

| Category | Automated coverage | Manual physical check |
| --- | --- | --- |
| Existing default | `packages/protocol/test/protocol.test.ts`, `apps/gateway/test/config.test.ts`, `apps/gateway/test/http.test.ts`, `apps/web/test/`, `apps/web/e2e/` | Standard single-host smoke |
| Actual Tern | `apps/gateway/test/omp-registry.test.ts` | **Smoke-tested on 2026-10-22** on macOS ([§4.H](#h-tern-qualification-procedure)); Tailscale Serve and phone PWA check |
| Lifecycle | `apps/gateway/test/omp-registry.test.ts`, daily `canary`, `scripts/omp-lifecycle-qualification.ts` | Real Tern `/new`, `/fork`, reconnect, and shutdown beyond closing panes |
| Tern isolation | `apps/gateway/test/` (optional creation boundary; no Tern discovery adapter) | Real Tern multi-window and remote-host check over Tailscale Serve |
| Two-host UI | `apps/web/test/` and `apps/web/e2e/` multi-host fixtures | **Smoke-tested on 2026-10-22** on `dev-localhost` in desktop Chrome; real two-host Serve and phone PWA check |
| Collision | `apps/web/test/` and `apps/web/e2e/` colliding-`instanceId` suites | **Smoke-tested on 2026-10-22** with three colliding `instanceId`s across two `dev-localhost` gateways; real two-host Serve check |
| Authorization | `apps/gateway/test/http.test.ts`, `apps/gateway/test/security-mutations.test.ts` | Real two-host check over Tailscale Serve |
| CORS boundaries | `apps/gateway/test/http.test.ts` (`apps/gateway/src/http-policy.ts`) | Real two-host check over Tailscale Serve |
| Failure isolation | `apps/web/test/`, `apps/web/e2e/` | Remote stop/outage **smoke-tested on 2026-10-22** on `dev-localhost`; real two-host Serve check |
| Restart/races | `apps/web/test/`, `apps/web/e2e/` | Real two-host check over Tailscale Serve |
| Recovery | `packages/collab-client/test/`, `apps/web/test/`, `apps/web/e2e/` | Installed Pixel/Chrome PWA and real two-host setup |
| Existing UX | `apps/web/test/`, `apps/web/e2e/` | Installed Pixel/Chrome PWA |
| Push | `apps/web/test/`, `apps/gateway/test/http.test.ts` | Installed Pixel/Chrome PWA and iPhone Home Screen PWA |
| Speech | `apps/gateway/test/http.test.ts`, `packages/collab-client/test/`, `apps/web/e2e/` | UI flow **smoke-tested on 2026-10-22** with fake `SpeechRecognition`; physical check on iPhone Home Screen PWA ([#380](https://github.com/carrythroughsystems/omp-session-gateway/issues/380)) and Pixel/Chrome PWA |
| Speech races | `packages/collab-client/test/`, `apps/web/e2e/` | Installed iPhone Home Screen PWA and Pixel/Chrome PWA |
| Privacy | `apps/gateway/test/http.test.ts`, `apps/web/test/`, `scripts/check-capability-leaks.ts`, `scripts/check-identifier-leaks.ts` | Leak scans on every captured artifact |
| Compatibility | `apps/gateway/test/config.test.ts`, `apps/gateway/test/cli.test.ts` | Rollback lifecycle checks |

- Existing default: empty `fleet.targets` and `http.trustedDashboardOrigins`, `speech.browserRecognition: false`, absent `tern`, `Permissions-Policy: microphone=()`, unchanged `connect-src`, no remote polls or Tern probe, and `404` on `GET /api/v1/client-config` falling back to local-only with speech off.
- Actual Tern and Lifecycle: stock OMP inside a Tern pane with `collab.autoStart` publishes to `~/.omp/run/collab-hosts` for **View**, **Control**, prompts, and requests without `/collab` (2026-10-22 smoke used Tern `0.9.5` `2863c37` and stock OMP `18.12.6`, one patch above `v18.12.5`); `/new`, `/fork`, reconnect, and exit rotate `generation`, reject stale launches with `409`, and remove the card on exit.
- Tern isolation: without authored `tern`, Tern's absence never affects `install`, `doctor`, discovery polling, or launches; configured creation failure leaves ordinary discovery and launch working, mirrored OMP panes produce one row, and remote OMP is discovered on its execution host.
- Two-host UI: `GET /api/v1/client-config` (`fleet.label` defaults to the first DNS label of `http.publicOrigin`, keeping literal host on loopback), **Host** picker (`All hosts`, local label, remote targets in config order), host labels on rows/hero/held/shell, `observed waiting order` across hosts vs single-host `ask.since` FIFO, and `All clear` / `No live sessions` only when all hosts in scope are fresh.
- Collision: equal `instanceId` across two hosts stays distinct via `SourceKey = id + "\0" + origin` and `SessionRef`, so launches, **View**→**Control** upgrades, Hold-to-next, and v2 triage records never cross-bind.
- Authorization: cross-origin requests enforce loopback peer, TUN-mode Serve topology, second-hop refusal, `auth.allowedLogins`, rate limits, and `requestHasTrustedDashboardContext` (`Sec-Fetch-Site` in `{absent, same-site, cross-site}`, `Content-Type: application/json`), with authenticated `OPTIONS` preflights consuming no launch rate-limit tokens.
- CORS boundaries: only the eight cross-origin route and method pairs in [Cross-origin access](PROTOCOL.md#cross-origin-access) and their authenticated `OPTIONS` preflights receive exact-origin CORS (never credentials or wildcards); `events`, `push`, `client-config`, `health`, and static assets stay excluded, and foreign non-admitted `Origin` headers fail before identity checks except loopback `health`.
- Failure isolation: remote polling runs every `10 s` while visible (`5 s` timeout, `35 s` stale grace showing `Cannot reach this host from this app.`); readable `403` clears rows, marks `Access withdrawn.`, stops auto-polling until **Retry** or foreground return, and disposes active shells from that source; invalid or origin-mismatched `200` on `client-config` shows `Fleet configuration unavailable — reload this app` while keeping local rows usable.
- Restart/races and Recovery: per-source epochs and request sequences accept lower revisions after remote restarts, drop stale-epoch responses without mounting capabilities, abort hidden/frozen polls without failure, refresh on `visible`/`pageshow`/`online`, and coalesce `CollabEmbedOptions.probeGateway` (`GET <source>/api/v1/sessions` → `healthy`, `forbidden` setting `gatewayHealth.state = "forbidden"` and `Access withdrawn`, or `unavailable`) across `pagehide`/`pageshow`.
- Existing UX and Push: single-host directory, **View**/**Control**, Photo composer, **Hold**/**Hide**, **Undo**/**Show all**, and service-worker shell upgrades remain unchanged (the worker bypasses cross-origin, `/api/`, non-`GET`, and navigation requests); Web Push subscriptions, VAPID state, tap routes, notifications, and badges stay home-scoped, and remote **Hold** never closes home notifications on colliding `instanceId`s.
- Speech (keyboard baseline and Web Speech): baseline OS keyboard dictation works with `microphone=()` (`"Use your keyboard's microphone key to dictate into this box. iPhone: Settings → General → Keyboard → Enable Dictation. Dictation never sends — tap Send when the text is right."`), while opt-in `speech.browserRecognition: true` sets document `Permissions-Policy: microphone=(self)` (keeping `microphone=()` on API/SSE/problem/asset responses).
- Speech (flow and bounds): **Control**-only Web Speech (`"Your browser or OS may send audio to its speech provider before any OMP prompt is sent."` disclosure → **Start** → **Stop**/**Cancel** → review → **Use text** → **Send**, where **Use text** never sends) uses `navigator.language` falling back to `en-US`, `continuous`, `interimResults`, one alternative, no auto-restart, watchdogs `10 s` start / `120 s` capture / `5 s` stop, and bounds `128` segments / `8,000` code points / `32 KiB`.
- Speech races: downgrading to **View**, disconnecting, hiding the page, cancelling, or unmounting aborts active speech recognition immediately and never leaks a draft into another session or auto-sends.
- Privacy: `GET /api/v1/client-config` projects named fields only (no logins, paths, tokens, or `trustedDashboardOrigins`), `omp.sessions.held-asks.v2` and `omp.sessions.dismissed.v2` store only `sourceId`, `sourceOrigin`, `instanceId`, `requestId`/`generation`, and timestamps, and speech sends no audio to the gateway or relay.
- Compatibility: install preserves authored `http.trustedDashboardOrigins`, `fleet`, `speech`, and `tern`; rollback removes `tern` on every target and removes `fleet`, `speech`, and `http.trustedDashboardOrigins` on targets `< 0.8.0` after saving `config.pre-rollback.json` with overwrite refusal and preserving the creation ledger ([Roll back to a retained predecessor](UPGRADE_ROLLBACK.md#roll-back-to-a-retained-predecessor)).

### H. Tern qualification procedure

To execute the manual Tern verification gate on a gateway workstation:

1. **Record the environment:** capture the Tern version/build identifier, host OS and version, stock `omp --version` and executable path, and the active OMP configuration root (`~/.omp` or `$PI_CONFIG_DIR`) using placeholder hostnames and user paths in any committed notes.
2. **Configure `collab.autoStart`:** run and read back the setting as the desktop user:

   ```sh
   omp config set collab.autoStart control
   omp config get collab.autoStart
   ```

3. **Start a fresh session inside Tern:** open a new Tern pane as the same OS user running `omp-gatewayd` and start plain `omp` (do not run `/collab`). Confirm a `0600` `<entryId>.json` publication and socket appear under `~/.omp/run/collab-hosts` (or `~/.<PI_CONFIG_DIR>/run/collab-hosts`).
4. **Exercise View, Control, prompt, and ask:** open **OMP Sessions**, confirm the session card appears within the discovery poll interval, open **View** (verifying read-only enforcement), switch to **Control**, submit a prompt, and answer a host input request (`ask`). If multiple Tern windows mirror the same `omp` process, confirm only one row is listed.
5. **Exercise replacement, reconnect, and shutdown:** run `/new` or `/fork` inside the Tern pane and verify the generation increments and stale launch requests return `409`; verify client reconnect across a brief network or visibility interruption; exit `omp` inside Tern and confirm the session row disappears without manual cleanup.

**Recorded developer-workstation smoke (2026-10-22 — `Smoke-tested`, not CI, not release qualification):**

- **Environment:** Tern `0.9.5` (build `2863c37`) on macOS (Apple silicon); stock OMP `18.12.6` (Homebrew install, one patch release above the `v18.12.5` engineering host baseline pin); configuration root `~/.omp` (`PI_CONFIG_DIR` unset); discovery directory `~/.omp/run/collab-hosts`; `collab.autoStart = control`.
- **Observed behavior:** two fresh interactive OMP sessions started inside Tern panes via `tern new tab --cwd <dir> -- env OMP_SKIP_SETUP=1 omp …` (one synthetic-key fixture, one with the operator's ordinary model credentials) published native discovery entries within ~13 s; `OmpHostReader` observed all three Tern-hosted hosts (`access: control`, `relayConnected: true`) and ignored ~220 stale publications. Two gateways built from this tree ran in `dev-localhost` mode on loopback ports from private `XDG_CONFIG_HOME` directories reading the same discovery directory (home gateway with `fleet.targets` and `speech.browserRecognition: true`; remote gateway with `http.trustedDashboardOrigins`). In desktop Chrome on the home PWA, the **Host** picker showed `All hosts` / `Home` / `Remote`; the three Tern-hosted `instanceId`s appeared as six independent rows labelled by host; home **View** posted to the home origin; remote **View** and **Control** posted to the remote origin through a real preflight (`OPTIONS …/launch` `204`, then `POST …/launch` `200`) with no credentials, the shell bar named the remote host, and the relay connected; a synthetic prompt sent through remote **Control** was echoed and returned the expected synthetic-key `401`; a real ask raised by the second session surfaced as metadata only (`inputRequired: true`, opaque `ask.requestId`, no preview) and was answered from the embedded ask through remote **Control**, after which OMP replied and both gateways reported `inputRequired: false`; stopping the remote gateway produced `Remote: Cannot reach this host from this app.` with **Retry** and `Host coverage incomplete — Unavailable: Remote` while home rows stayed usable; and the keyboard-dictation help plus opt-in speech flow (`disclosure → Start → listening with interim/final text → Stop → editable review → Use text` filling the draft while **Send** stayed separate) worked in the real bundle with an injected fake `SpeechRecognition` constructor (no microphone used). Full details are in [OMP_INTEGRATION.md](OMP_INTEGRATION.md#running-omp-inside-tern).
- **Still pending (not exercised):** any phone or installed PWA, the HTTPS Tailscale Serve path (identity headers and real CORS over Serve), Wi-Fi/cellular transitions, session replacement (`/new`, `/fork`), reconnect, and shutdown while inside Tern beyond closing the panes, native browser speech recognition on any device, and Pixel or iPhone keyboard dictation. Issue [#380](https://github.com/carrythroughsystems/omp-session-gateway/issues/380)'s installed-iPhone acceptance is therefore not satisfied yet.

### I. Opt-in Tern creation physical acceptance — pending

The [Pixel installed-build inventory](OMP_INTEGRATION.md#pixel-installed-build-inventory-2026-10-24) records the read-only Android native-handoff probe and desktop CLI correlation probe; run the twelve checks below for end-to-end physical verification of [ADR-043](DECISIONS.md#adr-043--opt-in-tern-creation-with-omp-native-adoption):

1. Record sanitized host OS, Tern/OMP/Bun versions, gateway build, and phone/browser versions using synthetic choices, task text, and placeholder origins/paths.
2. Run the gateway through its per-user service (not an interactive shell) with absolute executables and explicit `HOME`/`PATH`; confirm `omp-gateway doctor` reports `"ternAvailable": true` and Tern's pane environment publishes to the directory configured in `omp.discoveryDir` with `collab.autoStart = control`.
3. Capture sanitized `tern new tab --json` output (`{"block": <uint64>}`) and `tern inspect --json` output proving exact local block/pane equality and a stock OMP `omp_session_file` basename matching `OmpHostSnapshot.sessionId`, without capturing session-file contents, capabilities, private paths, or pane text.
4. From the installed Pixel PWA over Tailscale Serve, create a local session from the configured project, working-copy, and profile choices and verify one first-window Tern tab, one new OMP-native directory row, ordinary full-screen **Control**, and an optional **First task** draft appearing once unsent in the empty Control composer.
5. Repeat against a remote execution host through the trusted-dashboard CORS/preflight path, including colliding `instanceId` values across sources, and verify that opening binds only the selected source, `instanceId`, `generation`, and Control while untrusted origins/identities are denied.
6. Close, background, or change scope during startup, then use **Check creation**: confirm the daemon continues, foreground return never auto-opens, and a dropped POST acknowledgement replays the identical `clientOperationId` to recover the same operation.
7. Exercise `failed`, `started_unavailable` (including a `view`-only host), and `outcome_unknown`: confirm accurate status copy, kept-open Tern tab on command failure, no automatic retry, and manual directory refresh.
8. Restart the daemon at `accepted`, `launching`, and `awaiting_omp` checkpoints and verify conservative reclassification (`failed/interrupted`, `outcome_unknown/interrupted`, `started_unavailable/interrupted`) with no resumed adoption or duplicate spawn.
9. Open a large transcript and verify `Joining session… <pct>%` through live, then interrupt connectivity and verify `Reconnecting… <pct>%` through live without duplicate announcements, draft reapplication, or altered forbidden/ended/outage priority.
10. Verify native Back/Close, logical Back, keyboard/visual viewport sizing, focus return, reduced motion, empty-directory **New session**, and non-overwrite when Ask, photo, or existing composer text is present.
11. Remove `tern` and verify ordinary `install`, `doctor` (18 checks), discovery, and launch; re-enable `tern` and run `omp-gateway rollback` to verify `<configDir>/config.pre-rollback.json` backup, overwrite refusal, `tern` removal, preserved ledger, untouched Tern/OMP processes, and explicit restoration.
12. Run capability and identifier leak scans across all captured artifacts. Native **Open in Tern** handoff remains out of scope ([tern-sdk #143](https://github.com/stencil-hq/tern-sdk/issues/143)).

## 5. Relay soak test

For any self-hosted/proxied relay mode:

- run at least a 30-minute continuous transcript stream;
- send periodic bidirectional messages;
- cover Android screen lock/resume;
- record close codes/reconnects without recording payloads or links;
- test path and query preservation required by the relay;
- fail deployment qualification on unexplained periodic disconnects.

## 6. Performance targets

Initial targets, to revise with measurements:

- 50 local OMP hosts without material CPU usage;
- metadata delivery measured from a successful poll to the phone separately from the configured
  discovery interval; do not claim the fork-era push latency for polling;
- launch API p95 < 250 ms excluding relay connection;
- daemon idle memory < 100 MiB including embedded static assets;
- no unbounded event/listener/history growth during 8-hour soak.

### Isolated synthetic endurance measurement

`bun run qualify:endurance` starts the working-tree daemon with private, temporary config/state/
runtime and discovery directories, development loopback identity, and a non-4317 port. It never
installs a service, reads the real OMP discovery directory, contacts a relay, or uses a device.
Build the static assets first; use a **new** output directory and summary filename for each run:

```sh
bun run build
bun run qualify:endurance --hosts 50 --subscribers 4 --duration-seconds 28800 \
  --sample-seconds 15 --poll-seconds 10 --metadata-seconds 30 --churn-seconds 120 \
  --launch-seconds 4 --port 4319 --output /tmp/omp-gateway-endurance-8h \
  > /tmp/omp-gateway-endurance-8h-summary.json
```

The reusable `scripts/synthetic-hosts.ts` also supplies the weekly capacity workflow. Its CLI
accepts 1–50 hosts, private discovery files/sockets, authenticated snapshots,
and unavailable links. The endurance runner uses its opt-in, distinctively synthetic View links.
Title/activity revisions retain their generation and session identity. Churn revokes and withdraws
one host before publishing a new instance at generation 1; this is not a same-instance generation
reset. No capabilities or raw HTTP/SSE bodies are retained in evidence.

The endurance run holds all SSE subscribers open and exercises these independent measurements:

- View launch p50/p95/p99/max/count/failures, distributed across the run and hosts. Launches are at
  least four seconds apart to stay below the real per-identity 20/minute rate limit, without retries.
- Metadata-change-to-SSE-receipt latency **including discovery wait**, and
  `snapshotReplyToReceipt` latency separately. The latter starts immediately before the host writes
  the first matching successful snapshot reply; the matching event proves it was consumed. It
  includes IPC, poll-round reconciliation and loopback delivery, **not** the discovery timer wait.
  This is a host-reply proxy, not instrumentation of the daemon's exact poll-completion instant and
  not phone/browser/Tailscale latency. The configured poll interval is reported independently.
- Daemon RSS (KiB), cumulative CPU seconds and open numeric file descriptors (Linux `/proc`, macOS
  `ps` plus `lsof` when available): start/end/min/max/mean and least-squares slope per elapsed second.
  A separate idle sample precedes host registration. The CSV records actual sample times on a fixed
  cadence, plus an end sample; missed ticks are not fabricated. FD availability is explicit.
- Session membership, every raw list/SSE JSON body's forbidden fields, repository capability leak
  patterns, decoded known secret values, and the synthetic capability canary. Every scheduled
  metadata revision must reach every subscriber. A churn window allows only one missing host and
  must converge on all subscribers within twice the poll interval plus five seconds.

The JSON summary on stdout has numeric leaves only. `samples.csv` is the only file written to
the evidence directory; daemon logs, replies, socket credentials and private state are not copied.
At the above cadence an eight-hour run normally has 1,921 CSV rows: expect roughly 0.2 MiB of CSV
and a few KiB of JSON; reserve 1 MiB for evidence, plus a few MiB of transient private state
(excluding the existing build/dependencies). SIGINT/SIGTERM and correctness failures close the
streams, stop the daemon/hosts and remove the private root while preserving numeric samples.

Bounds: hosts 1–100, subscribers 1–32, duration 30–86,400 seconds, samples 1–300 seconds, polls
2–60 seconds, metadata 6–3,600 seconds, churn 0 (disabled) or 6×poll–3,600 seconds, launches
4–300 seconds, port 1,024–65,535 except 4317. Metadata and duration must span at least three polls;
sample/launch intervals cannot exceed duration. Other defaults are the command above, except a
300-second duration and a freshly named output directory.

Correctness failures exit nonzero, independently of performance targets. `correctness.failureCode`
is 0 on success; 1 arguments, 2 platform/build prerequisite, 3 output/root/port setup, 4 daemon
death/readiness, 5 host/list membership, 6 SSE protocol/leak/disconnect, 7 delivery/churn deadline,
8 launch, 9 resource sampling, 10 signal, or 11 teardown. No caught error or response is echoed.
Percentiles are nearest-rank millisecond upper bounds; maxima retain the measured precision.
Target flags use 1/0 for pass/fail, and -1 for unmeasured or no numerical verdict. Launch p95 and
idle memory use the targets above; CPU uses an explicit provisional <1% of one core comparison
to make “material” inspectable, not a release gate. No numerical metadata budget is invented.
An eight-hour window and RSS/FD slopes are external growth evidence only: internal listener/event/
history counts are not measured, so this tool cannot by itself declare unbounded growth absent.
Performance flags never cause a failing exit. The weekly capacity lane remains the shorter,
static-host, list-only CPU/RSS measurement; it does not become an SSE/launch or endurance claim.

### Measured — 2026-09-30

The first eight-hour measurements come from one Mac16,5 (macOS 27.0, arm64). They are tested
evidence recorded in the [release ledger](RELEASE_STATUS.md), not qualification. The synthetic
endurance command above ran the v0.7.0 runtime source with the exact settings shown. A
default-relay soak ran the installed published runtime, following the
[release guide's procedure](RELEASE.md#default-relay-soak-qualification):

- **50 hosts:** daemon CPU was 0.32% of one core over the synthetic run, so the provisional <1%
  comparison passes. Over the soak, the published runtime used 0.27% while serving the soak and the
  maintainer's own sessions.
- **Metadata delivery:** snapshot reply → SSE receipt was p95 8 ms (max 15 ms), excluding the
  discovery wait. Change → receipt, which includes a 10-second discovery interval, was p95 2,885 ms
  (max 10,008 ms). No numerical budget is set.
- **Launch API:** p95 was 2 ms (max 32 ms) over 7,196 View launches, below the 250 ms target.
- **Idle memory:** the daemon used 54.8 MiB before any host registered, below the 100 MiB target.
  Under the synthetic load it stayed between 43.8 and 81.8 MiB. The published runtime stayed
  between 34.4 and 50.1 MiB during the soak.
- **Growth:** over eight hours neither run showed a rising resident-memory trend (−3,113 KiB/h
  synthetic, −630 KiB/h soak), and descriptors held at 11–12. These are external measurements
  only.

The targets stand. Mainline releases still do not rerun eight-hour endurance: for v0.4.0 the
founder-approved fresh 1,800-second relay gate passed, and prolonged-operation risk was accepted.
Neither the measurements above nor that gate establishes bounded memory growth by itself: internal
listener, event and history counts are not measured.

## 7. Release checklist

- all security acceptance gates pass;
- dependency audit and lockfile review;
- source maps do not contain secrets (they should not) and are not remotely uploaded;
- the Bun-runtime archive is reproducible and has verified release provenance;
- version compatibility matrix recorded;
- install/uninstall tested on every advertised OS;
- no public-listener or Funnel configuration in defaults/examples;
- after stable publication, run `bun run smoke:release` ([Post-release local installation smoke](RELEASE.md#post-release-local-installation-smoke)) against the published digest on the configured
  local Darwin-arm64 Mac and physical Android client; require exact asset/provenance binding,
  config/token preservation, unrelated Serve preservation, View/Control, forbidden-sink,
  same-page recovery, installed-WebAPK (including resumption on `/client/` with a session-specific
  title), revocation, and owned-fixture cleanup evidence;
- documentation tells users how to revoke a lost phone and rotate the gateway-only readiness token;
- record the exact signed-candidate matrix and limitations in [Release status](RELEASE_STATUS.md): the matrix covers the Windows host, background Web Push, real-device cloud, specialized attention triage and delayed-tap, and lifecycle transition lanes on each exact signed candidate, and no fork-era qualification result transfers.

Android recovery milliseconds measure elapsed time from the disruption ending to the first
completed same-page, ready-directory probe, probing immediately and then waiting 250 ms between
completed attempts within the existing 36/160/48-second lock/airplane/Doze windows.

The v0.4.0 published-stable-byte local/Android smoke above **passed on 2026-09-14**, separately
from candidate qualification. Exact source/digest, preserved installation state, existing local
OMP 18.1.21, physical results, and the initial Control-upgrade failure, which matches the update
navigation in the ADR-018 amendment, are recorded in the [release ledger](RELEASE_STATUS.md).

## 8. Continuous integration lanes

Every pull request runs the gating and advisory lanes below from `.github/workflows/ci.yml`, `compatibility.yml`, and `platform-qualification.yml` (`browser-flake-budget` runs separately in `.github/workflows/browser-flake-budget.yml`). Only the lanes marked **gating** are required status checks on `main`; the others publish results without blocking merges.

| Lane | Command or scope | Merge |
| --- | --- | --- |
| `implementation-checks` | `bun run check` on Ubuntu (`ubuntu-24.04` or validated `gateway-ci` dispatch) | gating |
| `portable-source` | `bun run check:portable` matrix on `ubuntu-24.04`, `macos-latest`, and `windows-latest` | gating |
| `browser-notifications` | `bun run test:browser`: full Playwright suite across both mobile Chromium viewports | gating |
| `browser-core` | `bun run test:browser:compat`: `@core` Playwright suite on desktop Chromium/Firefox/WebKit and iPhone WebKit | gating |
| `windows-service-lifecycle` | Windows contracts/ACLs plus elevated and standard-user install, readiness-token isolation/rotation, and uninstall | gating |
| `linux-arm64-source-checkout` | Native `aarch64` typecheck, build, `bun test`, and pinned mainline OMP registry suites | advisory |
| `coverage` | `bun run test:coverage` and Codecov upload (`fail_ci_if_error: false`) | advisory |
| `visual-review` | Fixed `ubuntu-24.04`: `bun run test:visual` (21 synthetic snapshots) plus guarded Percy upload on eligible runs | advisory |
| `browser-flake-budget` | Weekly/manual `bun run check:browser-flakes` (requires `GITHUB_REPOSITORY` and GitHub Actions API auth) | maintenance, not a release/PR gate |

- `coverage` sets `fail_ci_if_error: false` on upload so merges never depend on third-party availability.
- `visual-review` validates all 21 synthetic snapshots (seven states across three CSS viewports in the dark scheme; `apps/web/e2e/theme.e2e.ts` tests light mode and live scheme switches across `browser-core`) and source-to-serialized geometry locally without a token, failing the job if local validation fails ([Percy scope](BROWSERSTACK.md#percy-scope)).
- `visual-review` uploads: same-repository pull requests, `main` pushes, and GitHub-hosted manual dispatches run `bun run test:visual:percy` with `continue-on-error: true` on the upload step; fork pull requests and `gateway-ci` dispatches receive no `PERCY_TOKEN` and report **not uploaded**, and seven-day artifacts under `test-results/visual-diagnostics/` retain only closed-set codes and numeric summary JSON ([Percy data flow](BROWSERSTACK.md#percy-data-flow)).
- `upstream-canary.yml` runs `canary` and `canary-windows` daily, by dispatch, and on pull requests touching its workflow, scripts, fixture, or registry reader, executing the eleven stages under [Mainline OMP](#mainline-omp) ([Lifecycle, branch, and resume](LIFECYCLE_BRANCH_RESUME.md)).
- Browser lanes gate merges because they are the only executable proof across the gateway and vendored-client boundary (for example `apps/web/e2e/software-keyboard.e2e.ts` asserting `--viewport-height` from the collaboration client, and the three `bfcache restore` cases in `apps/web/e2e/launch.e2e.ts` driving `pagehide`/`pageshow` to verify [ADR-029](DECISIONS.md#adr-029--resume-a-backgrounded-session-by-relaunching-it-never-by-retaining-its-capability) second-launch capability re-acquisition).

### Browser retries, evidence, and harness readiness

Both non-visual Playwright configs (`playwright.config.ts` and `playwright.compat.config.ts`) allow one retry only when `CI` is `"true"` or `"1"` and zero retries otherwise, keeping projects, workers, assertions, and timing bounds unchanged.

A pass on retry is **flaky**, exhausted retries fail the job, and every release-preparation (`prepare`) pull request (including version-only bumps) runs required checks on its own checkout. **Never reuse main's green results for a prepare head.** Dependency and browser caches may be reused, not check outcomes.

Per-attempt evidence (`scripts/test-browser.ts`):

- Removes stale output before running Playwright, writes `test-results/browser-flakes/browser-flake-report.json`, preserves Playwright's nonzero exit code, and fails even a green CI run if the report is missing or invalid.
- Appends sanitized per-project counts and flaky or unexpected repository locations to the GitHub job summary and uploads only that JSON artifact with 14-day retention (automatic traces, video, and screenshots are disabled in both configs).
- Uses closed version-2 report fields: run/attempt, tested SHA, lane/project, relative source location, deterministic location/project identity (including parameterized declarations), expected status, attempt ordinals/status/duration, and derived final outcome (empty or all-unexecuted reports fail coverage; titles, errors, stdout/stderr, attachments, source excerpts, URLs, and fixture values are excluded).

Weekly and manual flake budget (`bun run check:browser-flakes`):

- Counts each executed test once per completed workflow attempt regardless of Playwright retries (skipped tests never dilute the denominator), enforcing two limits over seven days: at most `1%` flaky executions **per lane/project**, and at most two flakes for any single test/project.
- Binds reports to GitHub run/attempt and commit metadata (a pull-request merge commit must have two parents with the source head second; a validated `gateway-ci` dispatch may bind `dispatchTargetSha` only when the workflow pins `inputs.target_sha` and both dispatch-validation and checkout-verification steps succeeded in that attempt).
- Selects the cohort via `OMP_BROWSER_REPORT_VERSION: "2"` at the run's source-head workflow revision (historical unmarked/v1 runs are pre-v2, unknown future versions fail closed, and unreadable revisions, malformed/foreign artifacts, or missing reports on completed jobs fail coverage).
- Imposes no report obligation on cancelled or incomplete jobs or selective reruns that did not execute that browser job; executed workflow reruns count as separate attempts while duplicate reads of one attempt count once.

Harness readiness lint (`check:repository` across `apps/web/e2e/`):

- Rejects `.finished` access (including optional/computed forms and static string aliases), request-finished listeners/waits, and `networkidle` navigation/load waits.
- Permits `waitForResponse()` only for an explicit HTTP-contract assertion on that exact response binding in the same lexical scope (including `Promise.all`, destructured, or `await` forms; child-block reassignment invalidates the binding, and response receipt or fixed animation-frame counts never prove UI state updates — observe application state instead, as in the delayed-bfcache remote **Hide** regression).
- Requires **startup-retry** tests to install and freeze the fake clock **before navigation** so freezing cannot abort an already-started setup retry; post-navigation clock advances for mounted timers remain allowed.
- Suite regressions (`scripts/browser-flake-reporter.test.ts`, `scripts/browser-flake-budget.test.ts`, `scripts/check-repository.test.ts`) cover retry/flake accounting, `1%` and two-flake boundaries, field exclusions, missing/duplicate evidence, and `waitForResponse` binding rules.

`capacity-qualification.yml` (schedule or `workflow_dispatch`) and `droplet-qualification.yml` (`workflow_dispatch` only) have no `pull_request` trigger, and `scripts/capacity-workflow.test.ts` validates the capacity config heredoc through the gateway config loader; tag-triggered release publication runs in `signed-release.yml` ([7. Release checklist](#7-release-checklist)).

## 9. Qualification tooling tests

This section is for release maintainers changing the qualification harnesses, device-cloud adapters, or unattended release driver; it specifies the offline regression suites and development runners summarized in [Qualification tooling](#qualification-tooling) (starting with `scripts/provider-read.ts` and `scripts/android-device.ts`; `gh`, `doctl`, `scw`, and `adb` denote the GitHub, DigitalOcean, Scaleway, and Android Debug Bridge CLIs).

Provider-read fault injection covers network recovery, mixed network/HTTP failures, bounded
exhaustion with the last error, and immediate programming-error/cancellation propagation.
Cancellation cases cover an owned read, backoff, and a shared total budget; the helper waits for
transport settlement and never replays a mutating provider request. Cloud outer cancellation must
not enter the journey retry path and must release sessions, tunnels and fixtures with a fresh
cleanup signal while retaining the same epoch and mutation-reconciliation history.
Repository admission requires direct TypeScript harness fetches to use the read helper or an
exact reviewed target exemption. Gateway/session, browser and loopback probes remain single-shot
observations (or keep their own observation deadline); capability POSTs and provider writes must
not replay. Provider CLI operations (gh/doctl/scw), remote shell package/bootstrap downloads and
guest metadata reads are outside this Response-based helper: their command exit/status and
existing polling semantics remain unchanged, not covered by the direct-fetch invariant.

The shared adb runner is tested with fake spawners for non-zero exit propagation and redaction of
device identifiers, stdout/stderr and raw spawn/pipe exceptions. Repository admission forbids adb
argv/spawn construction outside `scripts/android-device.ts`. Host-side subprocess smokes can exercise
stdin, output and exit behavior by injecting a Bun-child spawner, without invoking adb. Reachability
tests run a local shell with synthetic ping exits 1/2: the remote ping status is an unreachable
observation, while an adb transport exit remains fatal. Unsafe host text is refused before dispatch.
Best-effort CDP-forward cleanup remains explicit; device mutations must fail the lane, and
the shared restoration owner attempts every step without replacing the original phase error. Tests
cover its success/failure combinations, primary-error identity and ordering, continued restoration
after a failed step, and nested unrestored-Pixel errors retaining both development and campaign
leases. Acceptance regressions combine phase and restoration failures, round-trip Wi-Fi-on/data-off
baselines, and reject a mismatching radio read-back. The Push and acceptance paths share radio
capture/restoration, including validated Wi-Fi before enabling mobile data; a multi-SIM fake whose
global `mobile_data` key is stale proves the baseline reads the default data subscription's key
(a Pixel 10 Pro read `mobile_data=1` with data off). Repository admission
rejects lexical throw/return statements inside finally blocks in production scripts and app source;
scanner tests distinguish comments, strings, template text and regex literals (including after
`else`, `do` and operand keywords) from executable nested blocks. Real child processes prove a
failed or timed-out acceptance child poisons the campaign Pixel lease.

The stable-qualification suite also covers the 1,800-second relay floor, malformed or inadequate
passed evidence, and resume rejection without new admission or dispatch. A rejected proof must
still clean recorded pending Mac effects and must not reopen already completed cleanup.

| Orchestration boundary | Required offline regression |
| --- | --- |
| Sibling settlement | One consumer fails while another passes; the healthy sibling finishes before tunnel stop and publication lifecycle |
| Pixel ownership | An unrestored holder poisons queued measurements, never restoration; actual readiness/cleanup owners and one allocator preserve collateral references |
| Terminal evidence | Ordinary failure leaves no started lane `running`; failed publication and campaign have completion timestamps |
| Cleanup and retries | Dirty/stale/persistence-failed cleanup blocks eligibility; later cleanup cannot erase historical cleanup roots or poisoning; fresh attempts require zero; consuming exact receipt authority precedes admission |
| Rig readiness | Failure at setup, Windows admission, Mac checks or Push still restores Pixel before Mac; restoration failure remains unresolved and cannot authorize retry |
| Adapter cancellation | Pending health/provider reads and backoff abort; mutating requests never replay; real distinct remote process groups are reaped before cleanup; Windows physical-client ADB/CDP paths receive cancellation and a fresh restoration owner |
| Restart admission | Cloud holds and typed Windows admission errors produce campaign-owned terminal summaries/outcomes without failing passed lanes; restarted publication clears not-started metadata |
| Readiness finality | Passing receipts reject running readiness; failed log preparation does not publish a collectible owner; Windows admission uses the receipt failure allocator |
| Manual compatibility | Historical schema-3 receipts remain readable; manual readiness attempt zero gains no automatic authority; unbound later attempts refuse |
| Terminal owner reconciliation | Pending/passed/running direct failure owners finalize to valid failed receipts; relay-stop failure leaves an authorized preserved publication proof unchanged |
| Execution and artifact binding | Foreign HEAD and later bound preflight ordinals refuse before admission/outcome writes; candidate tag/source/digest mismatch never overwrites receipt identity |
| Remote ownership fence | Successful leader exit with live descendants still settles the group; actual shell-wrapper loss is reaped or fenced; PTY input reaches the foreground group; reboot ownership requires changed boot identity; admission exceptions are bounded/read-only |
| Readiness persistence failure | Baseline, mutation and restoration write failures still run every Pixel restore; only durable sidecars advance the mirror; terminal write failures retain original roots and poisoning and cannot claim restoration |
| Unified containment | Negative cleanup/reconciliation facts, remaining resources, persistence failures and pre-lane unsettled owners forbid proven containment, retry and retirement |
| Fixture dependency retention | Unresolved cloud or Push restoration retains the whole shared Mac fixture/owner directory; independent Windows cleanup does not queue behind it |
| Receiptless Windows admission | An actual bounded GET503 producer yields a private receiptless preflight outcome; post-allocation steps remain forbidden |
| Publication persistence | Initial/terminal write failures leave a failed completed lane; cleanup failure and failed terminal persistence retain independent typed evidence |

The offline gate does not prove byte-identical installation-state restoration by readiness: token
and runtime activation history/current pointer persist across uninstall. Isolation/restoration of
that private state remains an explicit deferred P2, not a live-rig acceptance claim.

The retained-Mac `ompPublication` lane adds the shared
[lifecycle runner](../scripts/omp-lifecycle-qualification.ts) after every live-session consumer
settles and the relay tunnel stops, including after unrelated consumer failures. It writes `/new` and `/fork` (after two
synthetic messages) to the existing `ssh -tt` stdin, then stops/revokes, relaunches with
`--continue`, and stops/revokes again. Each rotation keeps the instance, increments generation by
one, requires stale launch POST `409 generation_mismatch` without a capability, and requires
current View/Control `200 no-store`. Resume requires a new instance at generation 1 with the same
label and working launches. Rewind is not gateway-visible and is covered only by the canary.
Additive `ompPublication.evidence.lifecycle` holds `newGeneration`, `fork`, and `resumed`
boolean/count records; schema 3 is unchanged. An interrupted step cannot pass and reruns in full.
Prove this path before a campaign with
`bun scripts/omp-lifecycle-development.ts --omp <absolute path to stock OMP dist/cli.js>`.
The isolated loopback/PTY runner and dated tested evidence are documented in
[LIFECYCLE_BRANCH_RESUME.md](LIFECYCLE_BRANCH_RESUME.md); local passes do not qualify a candidate.

The Pixel Push lane adds `triage_verified` and `stale_taps_verified` between `clear_verified`
and `force_stop_verified`. It owns a second fixture host for queue order and gone-host taps,
requires no unrelated waiting or hidden directory rows, and cleans both hosts' notifications and
device-local Hold/Hide records. Delayed taps re-present the original metadata-only notification
after clear; `replayed: true` proves handling, not push delivery ordering or delay. Items D.9–15
below distinguish the new physical checks from broader acceptance. Develop with the pinned Bun:
`OMP_PUSH_FIXTURE_BINARY="$PINNED_OMP" bun scripts/android-push-qualification.ts development "$PUBLISHED_ARCHIVE"`.
Restored development progress from another candidate/origin/pin is archived automatically.
For one remaining fleet step instead of a full lane, use:

```sh
OMP_PUSH_FIXTURE_BINARY="$PINNED_OMP" bun scripts/android-push-qualification.ts development-step coordinator-restart "$PUBLISHED_ARCHIVE"
```

The step names are `fleet-identity`, `legacy-head-identity`, `coordinator-restart`, `revocation`,
`fleet-sinks`, `fleet-restoration`, and `legacy-tail`. Each starts from a fresh epoch, captures the
Pixel baseline, starts the local fixture,
subscribes, prepares the same isolated source/config/Serve mapping and grants through PWA enrollment,
and admits the warm worker observer once. `fleet-identity` first runs the legacy delayed-tap phase
to retain its generation change, notification replays and browser lifecycle, then runs fleet Private,
Session and Preview together, sharing their real tags and one held observer. `legacy-head-identity`
is a diagnosis step: it runs every legacy phase through `stale_taps_verified`, then fleet Private,
Session and Preview, the order in which a full lane reaches fleet Session. When one of its deliveries
misses the 60 s bound, it keeps sampling that notification every 5 s for up to 120 s before cleanup
answers the ask, so a late OS post is told apart from one that never arrives; the phase still fails.
Other selections skip the earlier local and fleet checks, not their assertions inside the selected step.
`fleet-sinks` first performs the real remote Control tap and
answer/clear needed to scan that exact live capability; `legacy-tail` first restores the fleet
source and releases the observer, then runs force-stop, permission, lock/resume, network, Doze and
the legacy sink sweep together. Every outcome attempts the existing Pixel and fleet restoration.
Partial runs never set `evidence_complete`; their private `tested-evidence.json` explicitly names
the step and records `development: true, qualified: false`.
Fleet delivery observations read OS records first and reuse only positively matched worker metadata
for that exact key/post time. A negative worker sample is read again within the original delivery
deadline; it cannot turn into a permanent negative cache. Per-sample OS counts/post times, cache-hit
and worker identity-match booleans are retained without notification or request identifiers.
Each fleet attention observation also starts one closed diagnostic sample beside the lane: OS counts
for the WebAPK and Chrome packages, Android's notification rate-limit refusals, cached/frozen process
flags, and the held worker's notification identity and durable shown/tombstone/mark/receipt state.
Every read is bounded at 3 s and a stalled read is recorded as unknown; the verdict never awaits a
sample, samples never overlap, and an unanswered worker read is not repeated on the same observer.
Each arm of the held observer also resets per-arm worker counts: push events as the worker receives
them (with data, decodable, and local/remote attention, clear or other), and `showNotification` calls
and settlements. A miss therefore shows whether Chrome dispatched the push or the worker dropped it.
The listener and wrapper only count and pass through; fleet restoration removes both.
The lane serializes checkpoint callbacks, including concurrent local/remote asks and restoration,
so the campaign, CLI and private runner cannot race a shared progress writer. Each caller still
receives its own persistence failure; a failed write does not prevent later restoration checkpoints.

Both development modes refuse any existing release-host campaign lease row or held Pixel lock.
An unrestored attempt retains ownership: stop and use
`bun scripts/android-push-qualification.ts cleanup "$PUBLISHED_ARCHIVE"` for that same identity;
do not remove either lock or start another iteration. This CLI needs an already installed disposable
gateway matching the archive; it does not install or replace a retained guest's baseline. The Studio
operator's private `fleet-step-runner.ts` (outside this repository) wraps `runAndroidPushDevelopmentStep(input, step)` with the
existing retained-guest backup/install/byte-exact restore proof and supplies qualification logs.
Run that wrapper only after the release campaign closes. Aim for about ten minutes per iteration,
not a timing guarantee: cold delivery, radio recovery and restoration keep their original bounds.
Repeat each remaining step 2–3 times successfully, then run one full acceptance lane. Unit or
step-runner evidence alone does not satisfy the release qualification gate.
Follow [ANDROID.md](ANDROID.md#physical-background-push-lane) before running a stable campaign;
the [specialized checklist](ATTENTION_SPEC.md#specialized-triage-and-delayed-tap-acceptance)
remains unchecked until that exact signed candidate passes.

The same `androidPush` lane requires twelve `fleet_*` phases after the existing delayed-tap
phase; it does not create another release lane or replace any earlier check. The candidate is
the coordinator. An epoch-owned source uses the same candidate bytes, a separate HOME/state and
OMP discovery directory, backend port 14318, and a distinct Tailscale Serve HTTPS origin on port
10443. Setup refuses existing fleet enrollment state, occupied ports, or another Serve owner.
This is a representative isolated server identity, not evidence of a second physical computer.
Enrollment uses the installed Pixel PWA's Settings → Hosts switch. The phases require concurrent
local/remote asks, all three detail levels (fleet Preview falls back to Session), exact-source
Control taps, resolved/replaced/expired remote taps without a launch, clear-before-rearm races,
source stale/last-known recovery, coordinator restart with one local replacement, grant revocation,
replacement/deduplication, foreground reconciliation, and privacy sink scans on both identities.
Clear proof requires both OS records and worker notifications to be absent on the session's tag,
independent of request ID; delivery still matches the exact request. The clear observer caches
only a proven positive clear. If Android removes the OS row before the worker's
notification enumeration catches up, a negative worker sample retains the observed-presence
evidence and must be re-observed; it cannot become a permanent negative cache. Closed
`android-fleet-clear:` diagnostics record phase, remote/local role, OS count and worker/cache
booleans only, never notification or request identities.
The restart clear wait additionally samples elapsed milliseconds since coordinator-up, exact remote
outstanding membership, baseline membership, stable recipient/grant counts and the advanced epoch,
plus Chrome GCM receive age and connection/Wi-Fi booleans. The ledger is projected on the host;
no private ledger or GCM dump is exported. Removal after accepted baseline membership, with an
advanced epoch and unchanged counts, is clear-acceptance evidence in this isolated, non-mutating
window. GCM receipts are Chrome-wide, not request-specific: a fresh receipt alone cannot distinguish
this clear from the local replacement. An OS-present sample deliberately does not wake/read the
worker and reports `workerObserved=false`, not proof that the worker received no clear. Failed
diagnostic reads stay explicitly unavailable and never change the original verdict or 60-second
wait. The product does not persist its volatile restart gate or source-feed knowledge, so these
cannot be reconstructed from ledger state; no product instrumentation is added.
Restart answers the remote
ask while the coordinator is down, then proves its old alert closed. The memory-only home registry
re-mints the still-pending local ask (#605): the lane requires its old exact-request tombstone in
the worker's existing IndexedDB state, exactly one newly posted OS record, and matching new worker
request/source/instance with the same authoritative generation. That replacement's OS key and
post timestamp are pinned immediately, before delivery re-observation. The new request and exact
pinned OS post must stay unchanged for 35 seconds, beyond the coordinator's 30-second failed-send
retry boundary as well as its next reconciliation, and the resolved remote alert must remain absent,
before arming a new remote ask. No re-alert, a missing old clear, concurrent duplicates, a second
local re-alert, or a remote repeat fail. Pending-remote identity across a home restart is
unit-proven in `apps/gateway/test/fleet-coordinator.test.ts`, not physically proven by this resolved-remote scenario.
While that proof is withheld, closed `android-fleet-restart-replacement:` lines record each change
in the first withholding check: verified prior post, OS record count and repost, then the worker's
old-request tombstone, notice count and replacement source/instance/request booleans. Each
withheld check also takes one non-verdict `android-fleet-attention-diagnostic:` sample of the
re-minted request. Neither changes the verdict or the 60-second wait.
`apps/gateway/test/fleet-two-gateway.test.ts` opens PushService before discovery and coordination, matching the daemon,
and proves subscription reload, healthy/corrupt startup, cold discovery, hanging/rejected feed
connections, and clear retries with the real 30/45-second timers under a fake clock. Warm restart
clears immediately; one hung connect clears at 46 seconds, two at 93 seconds, six immediate
disconnects at 63 seconds, and one failed clear retries after 30 seconds. These fault-injection
timings explain possible delays, not historical physical failures or a stronger delivery guarantee.
The expired-host replay must close before re-baselining.
The remote sink sweep runs while the remote session launched by the PWA's real Control tap is
still alive, using that same generation's Control capability and the detectable positive control;
two identical-generation Control launches must return equal capability bytes in page memory
before scanning. An unstable capability is typed invalid evidence; no value leaves the page.
`fleet_sinks_verified` records those closed observations after the other fleet checks.
Remote notification ownership includes the origin-bound fleet binding; local tags stay unchanged.
Private alerts intentionally look identical: concurrent ownership, privacy and deduplication use
the OS records and worker metadata, then each source's lock-screen row is observed alone after
authoritatively resolving its peer. The lane never guesses between indistinguishable Private rows.
The source supervisor detaches from the remote SSH session using the existing fixture's Python
session-leader pattern. Its TERM/EXIT trap precedes spawning the daemon, and atomic PID files
identify both processes. Stop proves the supervisor, child and backend listener gone within the
30-second bound before removing their PID files. The restoration owner is fsynced and atomically
published (including its parent directory) before any coordinator config/service/Serve mutation.
The supervisor signals its own unreaped child even before exec, but never signals a child after
its normal wait reaped it; external cleanup still verifies PID/command ownership before signalling.
Pre-owner recovery removes only `owner.json.tmp`, then
requires the epoch directory to be empty.
DevTools admission bounds both pending HTTP reads and retries. A worker-only observation may
reconnect once after contained transport loss, but never wakes/navigates the cold PWA, re-arms
lost observer state, or replays an evaluated mutation. Missing workers and product assertions
remain failures. Exhaustion records `androidPush / invalid_evidence` with the transport flag;
private diagnostics retain the underlying error and stack. Host-helper restoration failures
record `androidPushCleanup / fleet / containment_unproven`, preserving the helper exception
privately without exporting its text in the receipt.
The fleet observer is admitted while warm and keeps one browser/worker attachment (no page
target) for at most 30 minutes, bounded further by the lane deadline. Fleet result rows mark
`devtoolsObserver`: these cold-PWA phases prove real delivery, rendering, identity, ordering
and taps with instrumentation attached, **not process-cold wake semantics**. Loss of the held
connection fails typed; it is never silently reconnected.
Notification observation reads Android `dumpsys notification` first. The same phase reuses the
worker's metadata for an unchanged OS key/post timestamp, still comparing the exact source,
instance, request, version and type; a verified generation cannot silently change. Even mismatched
metadata is cached until the OS record changes, so a pending replacement cannot repeatedly evaluate
a frozen worker. Missing records report missing and invalidate delivery metadata; changed/new
records query freshly after the observed delivery, and reposts still fail deduplication. A clear
queries the worker only after observed OS presence becomes absence, retaining both the zero-OS
and zero-worker assertion; unchanged absence reuses that verdict. Initial absence without a
delivery/clear transition cannot prove fleet clearance. No freezer setting or worker wake changes.
Android can refreeze the closed app's cached browser within seconds of a push, so a badge check
that follows an ask, clear or coordinator restart while the page is closed is armed before that
action. Its worker-side wait is already in flight when the push thaws Chrome and answers inside
that thaw; it counts only ticks the worker runs, so a frozen process cannot spend its budget. An
unmatched answer falls back to the ordinary read and its diagnostics (`v0.10.1-prealpha.2` lost
`fleet_restart_verified` when that later read found all six Chrome processes frozen).
The restart phase carries its verified badge across the closed-page quiet window only when a
complete, healthy coordinator telemetry window records zero sends, acknowledgements and failures
globally; any push activity or unavailable telemetry requires a fresh worker evaluation.
Worker-evaluation timeouts retain closed lifecycle, inventory, responsiveness and frozen-process
count diagnostics without changing device freezer settings, waking the page, or retrying a mutation.
Fleet cleanup retains its owner and
prepared state until badge unpatch is proven (or the worker is proven restarted), then removes
host ownership. It releases the observer only after the unpatch attempt, on success or failure.
Resumed cleanup treats a hidden Hosts section with alerts off as deselected; coordinator grant
removal remains required by host restoration. The unchanged legacy force-stop and Doze
phases run after release, without this observer, and retain the process-cold observations.
After signalling a verified source supervisor once, cleanup tolerates transient loss of its
command line only while awaiting proven absence/zombie within the existing 30-second bound;
it never signals an unverified PID or treats a changed command as proof of exit.
Tap accounting records browser-generated CORS `OPTIONS` preflights separately from launch
attempts. Every non-OPTIONS request to any launch route still counts, so duplicate POSTs and
wrong-source/malformed launch attempts cannot be hidden by the cross-origin admission step.
The outage phase observes its pending remote row in the open PWA before taking the source down,
and asserts that the row is still present once the source is stale.
Coverage polls preserve that page instead of reloading away its last-known directory. Wait
timeouts retain the phase/step and last badge count/completeness plus the forwarded platform
badge call in private diagnostics, never in receipt fields. Both omitted and explicit `undefined`
`setAppBadge` arguments mean an incomplete zero-count marker, not a complete empty badge.
Paths sent to the retained macOS fixture executor use POSIX separators on every runner OS;
runner-local file reads keep native paths.

Fleet progress adds only an ownership boolean and a remote notification-topic SHA-256 digest.
Closed boolean/count results remain additive to receipt schema 3; no source, session, request,
grant secret, endpoint, or capability enters the receipt. Cleanup restores the exact coordinator
configuration and Serve baseline, removes only the source mapping it owns, revokes enrollment,
stops the source fixture/daemon, and restores badge observers before the existing notification,
subscription/preference, browser, radio and device cleanup. An interrupted setup or unsuccessful
restoration retains `cleanupRequired`; it cannot produce `restored`. Development results remain
**Tested**, never **Qualified**, and must name any scratch candidate and incomplete phases.
The development target must be disposable and home-only; never run these host mutations against
the founder's gateway. A foreign live notification overlap is partial evidence, not a fleet pass.
The existing home-only retry still requires its exact outbound-clear proof; fleet transactions
fail closed on the first overlap because they cannot safely reuse that home-registry alias proof.

Configured-Mac regressions require an explicit SSH destination and expected hardware model, reject
unsafe password-file ownership/mode/type, and prove that an omitted password file reaches
`sudo -n` through SSH stdin. Read-only admission rejects a measured hardware mismatch before
staging; lifecycle receipts persist the measured hardware and OS, retain schema 3, and resume
passed evidence for both the original and replacement models. The SSH exposure probe names the
configured SSH destination, which may resolve to the same tailnet address as the other probe; it
does not imply that the host has a separate public interface.

Mac ownership regressions persist the configured host before the first effect, reject mismatched
hosts and unbound legacy effects before target resolution or remote commands, leave refused
receipts unchanged, and preserve same-host cleanup after a failed admission. A model refusal
with no recorded effects cannot trigger cleanup, including when an external lane cannot parse
absent progress. Schema 3 accepts the additive `macHost` binding without reclassifying historical
evidence. Darwin shell proofs plant `sysctl`, `uname`, and `sw_vers` in the account's Bun directory
and require the actual system hardware measurement through both admission and host evidence.
Rollback verification also exercises its explicit staged Cosign outside PATH.

Both Mac preflights reject absent stock OMP, releases below 18.1.20, prereleases, and malformed
version banners before lane effects. Refusals identify the coding-agent install command from
`UPSTREAM.lock.json`; admission creates no receipt and invokes no lane or cleanup, and shell
preflight never reaches sudo. The exact compatibility minimum passes. Additional probe output
is rejected without exposing its raw diagnostic.

Optional host-owned reboot-guard regressions execute the remote shell and admission probe in
isolated local homes: preflight never invokes an executable guard that records its invocation;
a non-regular or non-owner-executable guard names its exact path and refuses preflight. A busy
guard runs only at the owned pre-reboot gate, prevents shutdown, and fails the persistence lane
with only the first 400 diagnostic bytes. Absent and allowing guards preserve the exact
passwordless shutdown command. Admission keeps a fixed four-line protocol with only absent,
present, or hex-framed invalid-path guard state, rejecting malformed or extra output without receipts.
These local proofs do not reboot or qualify a real shared host.

It also covers the three resource-owning lanes (ADR-031, ADR-032), with injected lane modules so no
test reaches a VM, a phone, or a device cloud:

- a lane passes only with a cleanup lane bound to the attempt epoch it recorded; a failed attempt is
  released, and never converted into a pass, before a new one starts, and a failed release blocks it;
- a crashed attempt resumes from its last checkpoint, and a cleanup that leaves recorded resources
  fails;
- a resumed campaign that fails admission still destroys the Windows VM it recorded;
- typed Windows cleanup transport failures project to non-retryable containment failures with
  their private cause retained, and a second successful cleanup preserves `cleanupFailed`;
- a real Pixel lease retains its Windows cleanup restoration-failure origin, so later refused
  Android work stays `collateral/dependency_failed` with the matching `originIds`;
- a cancelled Windows Pixel primary restores under a fresh ten-minute owner before classification,
  using the same failure allocator and leaving healthy dependent Pixel work admissible;
- the production Windows Pixel runtime uses an isolated HOME, synthetic vault and fake adb
  executable to prove restoration precedes classification after smoke cancellation; the test
  fails independently when either the restoration context or its ADB owner is rebound to primary;
- the Pixel lease runs one device action at a time and refuses later measurements, but not restoration, after a lane reports
  the phone unrestored;
- fake hotspot, USB/Bluetooth tethering, pending-upstream, malformed and failed adb probes refuse
  at orchestrator admission before provider lookup, lane admission or receipt creation;
- active, invalid or unreadable DND state also refuses before provider/lane admission for stable
  campaigns; post-release smoke permits `zen_mode=1` but still refuses tethering;
- from 0.6.0, stable approval requires passed Windows and background Push evidence, and from 0.6.2
  passed real-device cloud evidence; a schema 2 receipt cannot resume;
- the retained-Mac Push fixture stages exactly its import closure, as shell operands the remote shell
  never interprets, and the gateway's two log streams are observed separately.

The Windows lane (`scripts/windows-stable-qualification.test.ts`) and the background Push lane
(`scripts/android-push-qualification.test.ts`) test their phase machines, ownership and
protection rules, failure paths, and restoration against fake providers, transports, and devices;
[WINDOWS_QUALIFICATION.md](WINDOWS_QUALIFICATION.md) and [ANDROID.md](ANDROID.md) list what each
real run exercises.

The device-cloud lane (`scripts/device-cloud-qualification.test.ts`) runs against a fake runtime:

- catalog/free admission uses identical explicit model and OS floors, refuses malformed catalogs,
  obsolete iPads and unproved A55 hardware, and a free-empty snapshot is a zero-write hold;
- injected allocation time proves busy-to-free recovery, admission races and exactly ten minutes'
  exhaustion; authentication, transport and malformed inventory never become holds;
- an iPhone-only partial attempt is ended, audited and released before an iPad hold propagates;
  an audit or cleanup failure combined with availability remains diagnostic;
- a fake vendor refusing a third concurrent session passes because each target ends before
  allocating the next, and a failed release blocks an already-queued Android lane through the
  existing `pixelUnrestored` restoration guard, including nested aggregate failures;
- duplicate keys at top level, nested inventories and JSON logs are rejected before reference
  discovery, including escaped-equivalent keys; a parse-site meta-test forbids lenient vendor
  record parsers. Escaped JSON values cannot disappear from retained audits; the
  test detail, asset inventory and declared logs are inspected, and missing/unreviewed surfaces
  fail without forwarding account credentials to log storage;
- expected application assets are compared in-page with boolean-only results, and a mismatch
  fails before View/Control; page-controlled pathnames never become vendor-logged results;
- every WebDriver session reaches a checkpoint before it is driven, and every effect, the release of
  its sessions, tunnel, fixture, and workspace included, runs in one Pixel lease turn that no queued
  lane can enter, after a failure too;
- a vendor record holding either session's live link, or a 16-character segment of one, fails the
  lane, including interior and delimiter-crossing contiguous windows, and neither the error nor
  the saved progress repeats it;
- a generation change of either session before the audit fails the lane, and so do records that kept
  video or screenshots;
- an attempt interrupted before its release is released rather than resumed, a release that cannot
  finish leaves the attempt dirty for cleanup, which retries every step, and progress from another
  candidate is refused;
- progress refuses unknown fields, secret-named observations, and any text outside its fixed
  grammars, and device text outside them fails the attempt before it is saved;
- a device that reports another kind of device, model, browser, or OS release than the one requested
  is refused, using the capability shapes TestingBot returned for real allocations.

`scripts/testingbot.test.ts` covers the vendor boundary:

- the service-account token reaches only the `op` child's environment, and no account selection
  applies;
- a loose, symlinked, or malformed token file, or a non-service or foreign `op whoami`, stops before
  any read;
- the tunnel is stopped only by its own identifier; a real process listening beyond loopback is
  refused as a tunnel and left stopped, while a loopback-only one is accepted;
- the tunnel's proxy relays only a CONNECT to an allowed host and port, and refuses every other
  target, name, and plain HTTP without opening a connection;
- a page evaluation that fails returns only its error's name, never message text or a crafted name.

`scripts/android-leak-probe.test.ts` runs the shared sink scan against an iOS Safari tab's
service-worker registration, which has no `getNotifications`, and against cache and database names
holding the needle. It also runs the sweep that a vendor-logged driver uses, which reports sink
names and counts, never the page text that held the link.

BrowserStack and shared transport tests add:

- fallback only for an empty eligible iPad/Android pool, never for iPhone or after a primary write;
  lazy fallback prerequisites, the exact Mobile/five-parallel plan and the 2027-10-20 cutoff;
- exact iPad alias and Safari attestation, Samsung-only Chrome with matching model/OS/browser;
  refusal of HTTP-200 schema errors, bounded responses and unreviewed retained surfaces;
- equal IDs at different vendors remain distinct; unknown creation stays dirty; every vendor's
  partial record audit runs even when another record fails, and deletion failure blocks the lease;
- duplicate JSON keys are refused before reference discovery, and raw plus strict canonical
  escaped values are scanned; candidate-origin
  navigation text passes because default-relay capabilities are compact `room.key` strings,
  while a capability's interior 16-character window fails without being persisted;
- missing required logs, retained media (including opaque failed-command screenshots) and
  unverified deletion fail; even clean identical signed artifacts must become absent;
- private durable inventories include initially-404 references and survive DELETE/process loss;
  late content is audited, unresolved references keep cleanup dirty, and returned evidence has no URLs;
- property-style full-JSON discovery at varied object/array paths, pinned disjoint storage/dashboard
  origins, top-level dashboard references counted without fetching, and unknown origins refused;
- raw/canonical post-audit API bodies are scanned before absence; post-DELETE retries preserve
  monotonic audited/deleted/absent milestones rather than inventing unaudited deletions;
- a lost BrowserStack DELETE response leaves a durable started claim; a new API instance sends
  no further DELETE and exhausts the existing absence bound if the record remains;
- crash cleanup re-audits unchanged generations, counts unaudited deletions if links cannot be
  reconstructed, and persists link/media incidents instead of manufacturing a clean audit;
- key-free lane argv, exact two-host argv, canonical ownership through symlinked ancestors,
  shared loopback-only listener refusal and the existing
  plain-HTTP/alternate-host/port/loopback/LAN/tailnet denial matrix;
- retitled descendants/orphans and PID reuse, a real retitled macOS child, proved not-started
  idempotent cleanup, preparation failure before tunnel ownership, a later TestingBot-only attempt,
  and fixture/workspace preservation after each record/tunnel/fixture release failure;
- release summaries preserve historical golden bytes, attribute mixed targets individually,
  and refuse BrowserStack iPhone or non-Samsung/mismatched Android evidence.

A real run exercises the selected vendors' iPhone, iPad, and Android devices through the tunnels against the
candidate gateway, the iPhone's Home Screen alert, and the vendor-record audit; ADR-032 lists what
it proves and what stays Pixel-only.
`bun scripts/device-cloud-attestation.ts --admission` is a read-only free-inventory probe.
`--attest-public` permits at most four sequential allocation sessions (the three added iPhones
and A55), navigates only to `https://example.com`, ends each known session and inspects its retained
record. It never opens View/Control, contacts the retained Mac or Pixel, or qualifies a release.
Unavailable hardware remains disabled until its bounded attestation is proven.
The separate `scripts/device-cloud-development.ts` runner accepts an isolated candidate identity,
Mac host, HTTPS origin and session label. It runs at most three journey sessions, stops admitting
new allocations after 40 minutes, and always attempts production audit/release; provider command
and session-duration bounds still apply to in-flight work. `--hold-after-iphone` injects a marked
development-only iPad hold for partial-attempt audit testing. Its private results are explicitly
Tested and cannot approve a release. Equipment availability must be confirmed before running it.
`--mixed-vendors` selects TestingBot iPhone plus BrowserStack iPad/Samsung only in this isolated
runner; it cannot be combined with `--hold-after-iphone` and is not a production policy override.
The [release contract matrix](RELEASE.md#browserstack-device-cloud-fallback) records the bounded
public-page and crash-cleanup proofs. The capability-opening mixed journey remains a separately
scheduled development check, never an automatic extension of those probes.

Same-receipt hold/resume tests (`scripts/stable-qualification.test.ts` and
`scripts/release-driver.test.ts`) prove:

- availability-only live failures await publication lifecycle completion; lifecycle/cleanup
  failures make the result diagnostic, while cloud-only resume preserves passed publication
  evidence and attempt counts;
- explicit resumption refuses dirty, foreign, ordinary, incomplete and stale-cleanup receipts
  before admission or receipt writes, and reuses other expensive lanes' passed proof;
- closed worker outcomes bind candidate, source, digest, policy, Mac host and job ordinal; malformed
  outcomes and ordinary/missing workers never authorize an infrastructure retry;
- noisy earlier lane stdout cannot corrupt the dedicated atomically written per-phase outcome
  file; two and three free-admission hold leaves survive CLI/receipt/driver validation as one set;
- resume consumes old eligibility durably before setup; injected fixture/publication-readiness/
  launch/tunnel failures and teardown/protected-file errors after a hold leave it ineligible;
- receipt-scoped authorization preserves the worker's immutable host despite different operator
  CLI environment, and refuses scope, snapshot, host, source/policy and outcome-leaf mismatches;
- `infrastructure-held` never auto-retries or clears from later passing observations;
- one guarded authorization creates one immutable ordinal job, refuses duplicate authorization
  and changed identities/policy/lease, and preserves attempt-zero results and logs. A tmux failure
  after spec write replays into the same job once without another ordinal or immutable-file change;
  a worker start claim prevents relaunch even after its session disappears.

Before stable activation, the lead must confirm equipment availability and run the bounded
isolated full journey plus controlled hold/resume development proof at the final tree. Unit
fixtures are Tested state-machine evidence, not a live campaign or release qualification.
