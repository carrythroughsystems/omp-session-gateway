/**
 * Physical-device acceptance matrix: discovery, launch authorization, and resilience.
 *
 * Runs against a real Android phone over USB adb, so CDP control survives every radio change. Two
 * Android behaviours shape the method and are worth knowing before editing this file.
 *
 * Chrome freezes the renderer while the display is off, so `Runtime.evaluate` never resolves on a
 * locked device. Lock/resume is therefore measured after waking, never during.
 *
 * Recovery polling observes the rendered directory and never issues its own fetch. Competing probe
 * requests previously changed the browser connection workload and could consume the first restored
 * request while the PWA remained stale. After polling, a connected VPN and one owned HTTPS health
 * navigation prove the tailnet path independently; device-shell ICMP is only an observation.
 *
 * The radio baseline captured after admission is restored and verified after every phase outcome.
 * Restoration failures are reported with, never instead of, the phase failure. A killed process
 * cannot restore anything; callers must still verify the device afterwards.
 *
 * Usage: `bun scripts/android-acceptance.ts <origin> <session-cwd-label>`
 */
import {
  ANDROID_DIRECTORY_SURFACE_EXPRESSION,
  requireAndroidDevicePreconditions,
  requireAndroidGatewayReachability,
  androidDeviceHttpsReachesOrigin,
  requireSingleDevice,
  androidDeviceReachesHost,
  parseAndroidVpnNetwork,
  runAdb,
  readAndroidRadioBaseline,
  restoreAndroidRadios,
  unlockAndroidKeyguard,
  wakeAndroidDisplay,
  withAndroidChrome,
  type AndroidChromeDriver,
  type AndroidAdbCommand,
  type AndroidGatewayReachabilityEvidence,
} from "./android-device.ts";
import { isProtectedLabel, targetEligibility } from "./acceptance-target.ts";
import { ANDROID_ACCEPTANCE_STAGES, announceAndroidStage } from "./android-stages.ts";
import { measureAndroidRecovery } from "./android-recovery.ts";
import { runWithRestoration } from "./restoration.ts";

const POWER = "26";

let serial = "";

async function adb(...args: readonly string[]): Promise<string> {
  return (await runAdb(serial, args)).trim();
}

/** Recovery reads must not hang beyond the VPN polling window on an unresponsive adb transport. */
async function recoveryAdb(...args: string[]): Promise<string> {
  return runAdb(serial, args, { timeoutMs: 5_000 });
}

async function sleep(milliseconds: number): Promise<void> {
  const settle = Promise.withResolvers<void>();
  setTimeout(settle.resolve, milliseconds);
  await settle.promise;
}

/**
 * Wakes the display and confirms it, rather than firing keyevents and hoping.
 *
 * A run where the display never came back produced `cdp-timeout` on nearly every probe, because
 * Chrome freezes the renderer while the screen is off and `Runtime.evaluate` then never resolves.
 * That is unmeasurable, not a product result, and it silently looked like a stall. Returning the
 * observed wakefulness lets a caller record "the harness could not present a visible page" instead
 * of attributing the timeout to the application.
 */
async function wake(): Promise<string> {
  return wakeAndroidDisplay((...args) => adb(...args), sleep, () => unlockAndroidKeyguard(serial));
}

/**
 * Brings the owned tab to the foreground and confirms the page agrees it is visible.
 *
 * A woken display is not enough: the tab can still be backgrounded, and `document.visibilityState`
 * is what actually governs whether the app's resume path runs. `Page.bringToFront` is the protocol
 * way to do this; keyevents cannot.
 */
async function ensureVisible(driver: AndroidChromeDriver): Promise<string> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await driver.send("Page.bringToFront");
    } catch {
      // Not fatal: a frozen renderer rejects it, and the retry after another wake may succeed.
    }
    try {
      const evaluation = await driver.send("Runtime.evaluate", {
        expression: "document.visibilityState",
        returnByValue: true,
      });
      const { result } = evaluation;
      if (result && typeof result === "object" && "value" in result && result.value === "visible") return "visible";
    } catch {
      // CDP timeout means the renderer is still frozen; wake again and retry.
    }
    await wake();
  }
  return "not-visible";
}

/** Rendered PWA state only: the recovery tracer must not become another network client. */
const ATTEMPT = ANDROID_DIRECTORY_SURFACE_EXPRESSION;

function readValue(evaluation: Record<string, unknown>): Record<string, unknown> | undefined {
  const { result } = evaluation;
  if (!result || typeof result !== "object" || !("value" in result)) return undefined;
  const value = result.value;
  if (!value || typeof value !== "object") return undefined;
  return { ...value };
}

/** Never throws: a frozen renderer is an observation, not a harness failure. */
async function attempt(driver: AndroidChromeDriver, step: string): Promise<Record<string, unknown>> {
  try {
    const evaluation = await driver.send("Runtime.evaluate", { expression: ATTEMPT, awaitPromise: true, returnByValue: true });
    return { step, ...(readValue(evaluation) ?? { probe: "no-value" }) };
  } catch {
    return { step, probe: "cdp-timeout" };
  }
}

const timeline: Record<string, unknown>[] = [];
function record(entry: Record<string, unknown>): void {
  timeline.push(entry);
  console.error(`  ${JSON.stringify(entry)}`);
}

interface PageContinuity {
  reloaded: boolean;
}

type AndroidAcceptanceCycle = "lock" | "airplane" | "Doze" | "restoration";

export class AndroidTailnetRecoveryError extends Error {
  readonly name = "AndroidTailnetRecoveryError";
  constructor(readonly cycle: AndroidAcceptanceCycle, options?: ErrorOptions) {
    super(`Pixel tailnet path did not recover after the ${cycle} cycle; reconnect Tailscale on the device (no device settings were changed)`, options);
  }
}

interface AndroidAcceptanceTailnetEvidence {
  readonly vpnPresent: boolean;
  readonly vpnRecoveredMs: number | null;
  readonly httpsProbed: boolean;
  readonly httpsReachable: boolean;
  readonly httpsProbeMs: number | null;
  readonly recoveredMs: number | null;
}

interface AndroidAcceptanceTailnetRecoveryOptions {
  readonly httpsProbe?: (origin: string) => Promise<boolean>;
  readonly now?: () => number;
  readonly pause?: (milliseconds: number) => Promise<void>;
  readonly recordEvidence?: (evidence: AndroidAcceptanceTailnetEvidence) => unknown | Promise<unknown>;
}

/** Observe VPN recovery for at most a minute, then navigate once; never reconnect or change policy. */
export async function requireAndroidAcceptanceTailnetRecovery(
  origin: string,
  cycle: AndroidAcceptanceCycle,
  command: AndroidAdbCommand,
  {
    httpsProbe = androidDeviceHttpsReachesOrigin,
    now = () => performance.now(),
    pause = sleep,
    recordEvidence = evidence => record({ step: `${cycle}-tailnet-recovery`, ...evidence }),
  }: AndroidAcceptanceTailnetRecoveryOptions = {},
): Promise<void> {
  const since = now(), deadline = since + 60_000;
  let vpnPresent = false, httpsProbed = false, httpsReachable = false;
  let vpnRecoveredMs: number | null = null, httpsProbeMs: number | null = null, recoveredMs: number | null = null;
  return runWithRestoration("Android tailnet recovery evidence", async () => {
    try {
      while (now() < deadline) {
        vpnPresent = parseAndroidVpnNetwork(await command("shell", "dumpsys", "connectivity"));
        const completedAt = now();
        if (completedAt > deadline) break;
        if (vpnPresent) { vpnRecoveredMs = Math.round(completedAt - since); break; }
        const remaining = deadline - now();
        if (remaining > 0) await pause(Math.min(1_000, remaining));
      }
      if (vpnRecoveredMs === null) throw new AndroidTailnetRecoveryError(cycle);
      const probedAt = now();
      httpsProbed = true;
      try { httpsReachable = await httpsProbe(origin); }
      finally { httpsProbeMs = Math.round(now() - probedAt); }
      if (!httpsReachable) throw new AndroidTailnetRecoveryError(cycle);
      recoveredMs = Math.round(now() - since);
    } catch (error) {
      if (error instanceof AndroidTailnetRecoveryError) throw error;
      throw new AndroidTailnetRecoveryError(cycle, { cause: error });
    }
  }, [() => recordEvidence({ vpnPresent, vpnRecoveredMs, httpsProbed, httpsReachable, httpsProbeMs, recoveredMs })]);
}

function isSamePage(
  probe: Readonly<Record<string, unknown>>,
  expectedTimeOrigin: number,
  continuity: PageContinuity,
): boolean {
  const observed = probe.pageTimeOrigin;
  if (typeof observed !== "number" || !Number.isFinite(observed)) return false;
  const same = Object.is(observed, expectedTimeOrigin);
  if (!same && Number.isFinite(expectedTimeOrigin)) continuity.reloaded = true;
  return same;
}

/**
 * Polls until the directory is reachable, returning milliseconds since the disruption ended.
 *
 * Each attempt also pings the host from the device shell, but a host dropping ICMP makes loss
 * inconclusive. Only after measurement do VPN state and an owned health navigation prove the path.
 */
async function awaitRecovery(
  driver: AndroidChromeDriver,
  cycle: Exclude<AndroidAcceptanceCycle, "restoration">,
  since: number,
  timeoutMs: number,
  origin: string,
  expectedTimeOrigin: number,
  continuity: PageContinuity,
): Promise<{ recoveredMs: number | null; deviceReachableFirstMs: number | null }> {
  const host = new URL(origin).hostname;
  const label = cycle === "lock" ? "lock-resume" : `${cycle.toLowerCase()}-recovery`;
  let deviceReachableFirstMs: number | null = null;
  const recoveredMs = await measureAndroidRecovery(since, timeoutMs, async index => {
    // The app's resume path is driven by visibilityState, so a probe against a hidden or frozen page
    // measures nothing. Record the presentation state alongside the result so an unmeasurable run is
    // visibly unmeasurable rather than looking like an application stall.
    const presentation = await ensureVisible(driver);
    const deviceReachable = await androidDeviceReachesHost(host, adb);
    const probe = await attempt(driver, `${label}-${index}`);
    const samePage = isSamePage(probe, expectedTimeOrigin, continuity);
    const sinceMs = Math.round(performance.now() - since);
    if (deviceReachable && deviceReachableFirstMs === null) deviceReachableFirstMs = sinceMs;
    record({ ...probe, samePage, presentation, deviceReachable, sinceMs });
    return probe.directoryReady === true && samePage;
  });
  await requireAndroidAcceptanceTailnetRecovery(origin, cycle, recoveryAdb, {
    // The PWA still owns port 9222: the disposable health tab needs a separate forward and must not
    // relaunch Chrome or navigate the measured page. Its execution and cleanup bounds are unchanged.
    httpsProbe: origin => androidDeviceHttpsReachesOrigin(origin, {
      chrome: (run, options) => withAndroidChrome(run, { ...options, port: 9223, launchBrowser: false }),
    }),
  });
  return { recoveredMs, deviceReachableFirstMs };
}
async function awaitOutage(
  driver: AndroidChromeDriver,
  since: number,
  host: string,
  expectedTimeOrigin: number,
  continuity: PageContinuity,
): Promise<boolean> {
  for (let index = 1; index <= 12; index++) {
    await sleep(5_000);
    const presentation = await ensureVisible(driver);
    const deviceReachable = await androidDeviceReachesHost(host, adb);
    const probe = await attempt(driver, `airplane-outage-${index}`);
    const samePage = isSamePage(probe, expectedTimeOrigin, continuity);
    record({ ...probe, samePage, presentation, deviceReachable, sinceMs: Math.round(performance.now() - since) });
    if (probe.outageVisible === true && samePage) return true;
  }
  return false;
}

/** Discovery plus the full launch-authorization matrix, evaluated from the device. */
async function authorizationMatrix(driver: AndroidChromeDriver, label: string): Promise<Record<string, unknown>> {
  const script = `(async () => {
    const launch = async (id, generation, mode) => {
      const response = await fetch("/api/v1/sessions/" + id + "/launch", {
        method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ generation, mode }),
      });
      const text = await response.text();
      let code;
      try {
        const parsed = JSON.parse(text);
        code = parsed.code ?? parsed.error ?? (typeof parsed.capability === "string" ? "capability" : undefined);
      } catch { code = text.slice(0, 40); }
      return { status: response.status, code, noStore: (response.headers.get("cache-control") ?? "").includes("no-store") };
    };
    const list = await (await fetch("/api/v1/sessions", { cache: "no-store" })).json();
    const target = list.sessions.find(session => session.cwdLabel === ${JSON.stringify(label)});
    if (!target) return { error: "target not published", published: list.sessions.map(s => s.cwdLabel) };
    return {
      revision: list.revision,
      published: list.sessions.length,
      discovered: { generation: target.generation, canView: target.canView, canControl: target.canControl },
      view: await launch(target.instanceId, target.generation, "view"),
      control: await launch(target.instanceId, target.generation, "control"),
      staleView: await launch(target.instanceId, target.generation + 5, "view"),
      staleControl: await launch(target.instanceId, target.generation + 5, "control"),
      invalidGeneration: await launch(target.instanceId, 0, "view"),
      unknownSession: await launch("00000000-0000-4000-8000-000000000000", 1, "view"),
    };
  })()`;
  const evaluation = await driver.send("Runtime.evaluate", { expression: script, awaitPromise: true, returnByValue: true });
  const value = readValue(evaluation);
  if (!value) throw new Error("authorization matrix returned no value");
  return value;
}

/** Admit ICMP or an owned HTTPS probe before the acceptance journey and its radio mutations. */
export async function withAndroidAcceptanceRestoration<T>(
  command: AndroidAdbCommand,
  body: () => Promise<T>,
  origin: string,
  { httpsProbe = androidDeviceHttpsReachesOrigin, recordEvidence = evidence =>
    console.error(`android-reachability: ${JSON.stringify(evidence)}`), tailnetRecovery = {} }: {
    readonly httpsProbe?: (origin: string) => Promise<boolean>;
    readonly recordEvidence?: (evidence: AndroidGatewayReachabilityEvidence) => unknown | Promise<unknown>;
    readonly tailnetRecovery?: Omit<AndroidAcceptanceTailnetRecoveryOptions, "httpsProbe"> & { readonly command?: AndroidAdbCommand };
  } = {},
): Promise<T> {
  await requireAndroidGatewayReachability(origin, command, { probe: httpsProbe, record: recordEvidence });
  const baseline = await readAndroidRadioBaseline(command);
  const { command: recoveryCommand = command, ...recoveryOptions } = tailnetRecovery;
  return runWithRestoration("Android acceptance", body, [
    () => restoreAndroidRadios(baseline, command),
    async () => {
      const after = await readAndroidRadioBaseline(command);
      if (after.airplane !== baseline.airplane || after.wifi !== baseline.wifi || after.mobile !== baseline.mobile) {
        throw new Error("radio baseline was not restored");
      }
    },
    () => command("shell", "dumpsys", "deviceidle", "unforce"),
    () => command("shell", "dumpsys", "battery", "reset"),
    () => requireAndroidAcceptanceTailnetRecovery(origin, "restoration", recoveryCommand, { ...recoveryOptions, httpsProbe }),
  ]);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const acknowledgedDisposable = args.includes("--disposable-target");
  const [origin, label] = args.filter(value => !value.startsWith("--"));
  if (!origin || !label) {
    console.error("usage: bun scripts/android-acceptance.ts <origin> <session-cwd-label> [--disposable-target]");
    process.exit(2);
  }

  // Refused before any network call, so the refusal cannot depend on whether the protected session
  // happens to be published at this instant.
  if (isProtectedLabel(label)) {
    console.error(`REFUSED: "${label}" matches a protected pattern and can never be a target.`);
    console.error("this harness fires real view, control, and stale-generation launches at the target.");
    console.error("create a disposable session instead; a relay soak host lost 7h40m to exactly this.");
    process.exit(2);
  }

  const host = new URL(origin).hostname;

  // Refuse an ineligible target before touching the device or the session. This runs against the
  // gateway rather than the phone precisely so an ineligible target costs nothing and cannot be
  // discovered halfway through a run that has already fired launches at it.
  announceAndroidStage(ANDROID_ACCEPTANCE_STAGES, "target preflight");
  const listResponse = await fetch(new URL("/api/v1/sessions", origin), { headers: { accept: "application/json" } });
  if (!listResponse.ok) {
    console.error(`could not read the session list to validate the target: HTTP ${listResponse.status}`);
    process.exit(2);
  }
  const listed: unknown = await listResponse.json();
  const sessions =
    listed && typeof listed === "object" && "sessions" in listed && Array.isArray(listed.sessions) ? listed.sessions : [];
  const match = sessions.find(
    (session): session is { cwdLabel: string; startedAt?: string } =>
      session !== null && typeof session === "object" && "cwdLabel" in session && session.cwdLabel === label,
  );
  if (!match) {
    console.error(`target "${label}" is not published; nothing was touched`);
    process.exit(2);
  }
  const eligibility = targetEligibility(label, match.startedAt, Date.now(), acknowledgedDisposable);
  if (!eligibility.eligible) {
    console.error(`REFUSED: ${eligibility.reason}`);
    console.error("this harness fires real view, control, and stale-generation launches at the target.");
    process.exit(2);
  }

  announceAndroidStage(ANDROID_ACCEPTANCE_STAGES, "Android Chrome");
  serial = await requireSingleDevice();
  await requireAndroidDevicePreconditions(adb, { switchesRadios: true, needsNotifications: false });
  const summary = await withAndroidAcceptanceRestoration(adb, () => withAndroidChrome(async driver => {
    serial = driver.serial;
    const browserVersion = await driver.version();
    await wake();
    await driver.openTab();
    await driver.navigate(`${origin}/`);
    await sleep(8000);

    announceAndroidStage(ANDROID_ACCEPTANCE_STAGES, "authorization matrix");
    const authorization = await authorizationMatrix(driver, label);
    console.error(`  authorization: ${JSON.stringify(authorization)}`);
    const baseline = await attempt(driver, "baseline");
    record(baseline);
    const baselineTimeOrigin =
      typeof baseline.pageTimeOrigin === "number" && Number.isFinite(baseline.pageTimeOrigin)
        ? baseline.pageTimeOrigin
        : Number.NaN;
    const continuity: PageContinuity = { reloaded: false };

    let unlockMs: number | null = null;
    let airplane: { recoveredMs: number | null; deviceReachableFirstMs: number | null } = { recoveredMs: null, deviceReachableFirstMs: null };
    let doze: { recoveredMs: number | null; deviceReachableFirstMs: number | null } = { recoveredMs: null, deviceReachableFirstMs: null };
    let outageBanner = false;

    // Lock and resume. Poll the PWA's rendered state instead of failing at one arbitrary instant.
    announceAndroidStage(ANDROID_ACCEPTANCE_STAGES, "lock resume");
    await adb("shell", "input", "keyevent", POWER);
    await sleep(20_000);
    const wokeAt = performance.now();
    const wakefulness = await wake();
    const presentation = await ensureVisible(driver);
    const lock = await awaitRecovery(driver, "lock", wokeAt, 36_000, origin, baselineTimeOrigin, continuity);
    unlockMs = lock.recoveredMs;
    record({ step: "lock-resume-summary", wakefulness, presentation, recoveredMs: unlockMs });

    // Total network loss and automatic same-page recovery, with no reload and no competing fetch.
    announceAndroidStage(ANDROID_ACCEPTANCE_STAGES, "airplane recovery");
    await adb("shell", "cmd", "connectivity", "airplane-mode", "enable");
    outageBanner = await awaitOutage(driver, performance.now(), host, baselineTimeOrigin, continuity);
    await adb("shell", "cmd", "connectivity", "airplane-mode", "disable");
    airplane = await awaitRecovery(driver, "airplane", performance.now(), 160_000, origin, baselineTimeOrigin, continuity);
    if (airplane.recoveredMs !== null) {
      await sleep(10_000);
      const settled = await attempt(driver, "airplane-settled");
      const samePage = isSamePage(settled, baselineTimeOrigin, continuity);
      record({ ...settled, samePage });
      if (settled.directoryReady !== true || !samePage) airplane = { ...airplane, recoveredMs: null };
    }

    // Forced deep Doze.
    announceAndroidStage(ANDROID_ACCEPTANCE_STAGES, "doze recovery");
    await adb("shell", "dumpsys", "battery", "unplug");
    await adb("shell", "dumpsys", "deviceidle", "force-idle");
    await sleep(20_000);
    record({ step: "doze-state", idle: await adb("shell", "dumpsys", "deviceidle", "get", "deep") });
    await adb("shell", "dumpsys", "deviceidle", "unforce");
    await adb("shell", "dumpsys", "battery", "reset");
    doze = await awaitRecovery(driver, "Doze", performance.now(), 48_000, origin, baselineTimeOrigin, continuity);

    return {
      serial: driver.serial,
      packageName: driver.packageName,
      androidPackageVersion: driver.androidPackageVersion,
      browserVersion,
      devtoolsSocket: driver.devtoolsSocket,
      browserActivity: driver.browserActivity,
      authorization,
      baselineReady: baseline.directoryReady === true && Number.isFinite(baselineTimeOrigin),
      appAsset: typeof baseline.appAsset === "string" ? baseline.appAsset : null,
      samePage: Number.isFinite(baselineTimeOrigin) && !continuity.reloaded,
      unlockMs,
      outageBanner,
      airplaneRecoveredMs: airplane.recoveredMs,
      airplaneDeviceReachableMs: airplane.deviceReachableFirstMs,
      dozeRecoveredMs: doze.recoveredMs,
    };
  }), origin, { tailnetRecovery: { command: recoveryAdb } });

  console.log(JSON.stringify(summary, null, 1));

  announceAndroidStage(ANDROID_ACCEPTANCE_STAGES, "verdict");
  const authorization = summary.authorization;
  const failures: string[] = [];
  const expect = (name: string, actual: unknown, wanted: unknown): void => {
    if (actual !== wanted) failures.push(`${name}: expected ${String(wanted)}, got ${String(actual)}`);
  };
  const status = (key: string): unknown => {
    const entry = authorization[key];
    return entry && typeof entry === "object" && "status" in entry ? entry.status : undefined;
  };
  expect("view launch", status("view"), 200);
  expect("control launch", status("control"), 200);
  expect("stale view rejected", status("staleView"), 409);
  expect("stale control rejected", status("staleControl"), 409);
  expect("unknown session rejected", status("unknownSession"), 404);
  if (!summary.baselineReady) failures.push("baseline directory was not rendered ready");
  if (!summary.samePage) failures.push("PWA reloaded during recovery");
  if (summary.unlockMs === null) failures.push("lock/resume did not recover");
  // VPN plus HTTPS already proved the path; a host dropping ICMP cannot explain an app failure.
  if (summary.airplaneRecoveredMs === null) {
    failures.push("airplane mode: the tailnet path recovered but the app did not recover within the polling window");
  }
  if (summary.dozeRecoveredMs === null) failures.push("Doze did not recover within the polling window");
  if (summary.outageBanner !== true) failures.push("no recovery status during the outage");

  if (failures.length > 0) {
    console.error(`FAILED:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.error("all device acceptance checks passed");
}
