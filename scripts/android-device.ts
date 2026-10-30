/**
 * Drive Chrome on a physically attached Android device over adb + the DevTools protocol.
 *
 * Playwright cannot do this for us. `connectOverCDP` never resolves against stock
 * Chrome-for-Android: the WebSocket establishes and both sides exchange CDP frames, but Playwright
 * initializes every target and the tab list contains an undriveable `chrome-native://newtab/`.
 * Playwright's separate `_android` API works around that, but `_android.launchBrowser()` needs
 * `chrome://flags/#enable-command-line-on-non-rooted-devices` toggled by hand first, because
 * release Chrome ignores the command-line file it writes. Raw CDP has neither problem.
 *
 * Two device-specific behaviours are load-bearing and cost hours to find:
 *
 *  - Chrome must be awake. A cached Chrome (`curProcState=19 CACHED_EMPTY`) still accepts TCP on
 *    `@chrome_devtools_remote` and then never replies, which reads exactly like a protocol bug.
 *    {@link wakeAndroidChrome} wakes the display and starts Chrome before opening any socket.
 *  - `Target.createTarget`'s `url` is ignored on Android. The tab opens blank regardless, so the
 *    caller must `Page.navigate` explicitly.
 */
import { runWithRestoration } from "./restoration.ts";

const DEFAULT_BROWSER_PACKAGE = "com.android.chrome";
const DEFAULT_DEVTOOLS_SOCKET = "localabstract:chrome_devtools_remote";
const ANDROID_PACKAGE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/u;
const ANDROID_CLASS_PATTERN = /^\.?[A-Za-z_][A-Za-z0-9_.]*(?:\.[A-Za-z_][A-Za-z0-9_.]*)*$/u;
const DEVTOOLS_SOCKET_PATTERN = /^localabstract:[A-Za-z0-9_.-]+$/u;
const DEFAULT_FORWARD_PORT = 9222;
const CALL_TIMEOUT_MS = 25_000;
const OPEN_TIMEOUT_MS = 10_000;
const LOAD_POLL_MS = 500;
const LOAD_ATTEMPTS = 60;
const DEVTOOLS_ENDPOINT_WAIT_MS = 30_000;

export interface AndroidBrowserTarget {
  readonly packageName: string;
  readonly activity: string;
  readonly devtoolsSocket: string;
}

function environmentOverride(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = environment[name];
  if (value === undefined) return undefined;
  if (value.trim().length === 0) throw new Error(name + " must not be empty");
  return value.trim();
}

/** Browser process selected for physical-device evidence. Every endpoint is independently overrideable. */
export function resolveAndroidBrowserTarget(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AndroidBrowserTarget {
  const packageName = environmentOverride(environment, "OMP_ANDROID_BROWSER_PACKAGE") ?? DEFAULT_BROWSER_PACKAGE;
  if (!ANDROID_PACKAGE_PATTERN.test(packageName)) {
    throw new Error("OMP_ANDROID_BROWSER_PACKAGE must be an Android package name");
  }

  const activity =
    environmentOverride(environment, "OMP_ANDROID_BROWSER_ACTIVITY") ??
    packageName + "/com.google.android.apps.chrome.Main";
  const [activityPackage, activityClass, extraActivityPart] = activity.split("/");
  if (
    extraActivityPart !== undefined ||
    activityPackage !== packageName ||
    activityClass === undefined ||
    !ANDROID_CLASS_PATTERN.test(activityClass)
  ) {
    throw new Error("OMP_ANDROID_BROWSER_ACTIVITY must be a component in the selected package");
  }

  const socketOverride = environmentOverride(environment, "OMP_ANDROID_DEVTOOLS_SOCKET");
  if (packageName !== DEFAULT_BROWSER_PACKAGE && socketOverride === undefined) {
    throw new Error("OMP_ANDROID_DEVTOOLS_SOCKET is required for an alternate browser package");
  }
  const devtoolsSocket = socketOverride ?? DEFAULT_DEVTOOLS_SOCKET;
  if (!DEVTOOLS_SOCKET_PATTERN.test(devtoolsSocket)) {
    throw new Error("OMP_ANDROID_DEVTOOLS_SOCKET must be a localabstract socket name");
  }
  return { packageName, activity, devtoolsSocket };
}

export interface AndroidChromeDriver {
  /** Serial of the attached device, for evidence records. */
  readonly serial: string;
  readonly packageName: string;
  readonly androidPackageVersion: string;
  readonly browserActivity: string;
  readonly devtoolsSocket: string;
  /** Browser.getVersion, which carries the exact Chrome build and Chromium revision. */
  version(): Promise<Record<string, unknown>>;
  /** Opens a tab this process owns, so a run never disturbs the user's existing tabs. */
  openTab(): Promise<void>;
  /** Attach an existing page without taking ownership of the user's WebAPK task. */
  attachTab(targetId: string, existingSessionId?: string): Promise<void>;
  closeTab(): Promise<void>;
  browserSend(method: string, parameters?: Record<string, unknown>): Promise<Record<string, unknown>>;
  sessionSend(session: string, method: string, parameters?: Record<string, unknown>): Promise<Record<string, unknown>>;
  onEvent(listener: (method: string, parameters: Record<string, unknown>) => void): () => void;
  /** Navigates the owned tab and waits for document.readyState to become complete. */
  navigate(url: string): Promise<string>;
  /** Evaluates an expression in the owned tab and returns its value. */
  evaluate<T>(expression: string): Promise<T>;
  /** Raw escape hatch for protocol domains this helper does not wrap. */
  send(method: string, parameters?: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export interface AndroidDirectorySurface {
  readonly online: boolean;
  readonly visibility: string;
  readonly statusHidden: boolean;
  readonly statusKind: string | null;
  readonly statusTitle: string;
  readonly sessionCount: number;
  readonly appAsset: string | null;
  readonly pageTimeOrigin: number;
  readonly directoryReady: boolean;
  readonly outageVisible: boolean;
}

interface DirectoryStatusElement {
  readonly dataset?: { readonly kind?: string };
  hasAttribute(name: string): boolean;
  querySelector(selector: string): { readonly textContent?: string | null } | null;
}

interface DirectorySurfaceDocument {
  readonly visibilityState: string;
  querySelector(selector: string): DirectoryStatusElement | null;
  querySelectorAll(selector: string): { readonly length: number };
}

interface DirectorySurfacePerformance {
  readonly timeOrigin: number;
  getEntriesByType(type: string): readonly { readonly name: string }[];
}

/** Reads the rendered directory only. Recovery probes must not compete with the PWA's own fetches. */
export function captureAndroidDirectorySurface(
  pageDocument: DirectorySurfaceDocument,
  pageNavigator: { readonly onLine: boolean },
  pagePerformance: DirectorySurfacePerformance,
): AndroidDirectorySurface {
  const status = pageDocument.querySelector("#status-banner");
  const statusHidden = status?.hasAttribute("hidden") ?? false;
  const statusKind = status?.dataset?.kind ?? null;
  const sessionCount = pageDocument.querySelectorAll(".working-row, .queue-row").length;
  return {
    online: pageNavigator.onLine,
    visibility: pageDocument.visibilityState,
    statusHidden,
    statusKind,
    statusTitle: status?.querySelector(".status-title")?.textContent?.trim() ?? "",
    sessionCount,
    appAsset:
      pagePerformance
        .getEntriesByType("resource")
        .map(entry => entry.name)
        .find(name => /\/assets\/app[.][0-9a-f]+[.]js$/u.test(name)) ?? null,
    pageTimeOrigin: pagePerformance.timeOrigin,
    directoryReady: pageDocument.visibilityState === "visible" && statusHidden && sessionCount >= 1,
    outageVisible:
      !statusHidden && ["offline", "tailnet", "desktop", "gateway"].includes(statusKind ?? ""),
  };
}

export const ANDROID_DIRECTORY_SURFACE_EXPRESSION =
  `(${captureAndroidDirectorySurface.toString()})(document, navigator, performance)`;


export class AndroidAdbError extends Error {
  constructor(readonly exitCode?: number) {
    super(exitCode === undefined ? "adb command failed; output withheld" : "adb exited " + exitCode + "; output withheld");
  }
}

export type AndroidAdbSpawner = (
  argv: string[],
  options: { stdin: "ignore" | Uint8Array; stdout: "pipe"; stderr: "pipe" },
) => { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill: (signal?: number | NodeJS.Signals) => void };

/** The only adb subprocess owner. Never include argv, device identifiers, output or raw causes in failures. */
/**
 * The value of a `Runtime.evaluate` result. A page-side exception is a failure of the step
 * that evaluated it, never an `undefined` value: the Push lane's replay once evaluated
 * `navigator.serviceWorker.ready` in a WebAPK showing `chrome-error://` and reported only
 * that its notification never appeared (v0.7.2-prealpha.2, 2026-10-02).
 */
export function evaluationValue<T>(result: Record<string, unknown>): T {
  const details = result.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
  if (details !== undefined) {
    throw new Error(`CDP Runtime.evaluate: ${details.exception?.description?.split("\n")[0] ?? details.text ?? "page exception"}`);
  }
  const wrapper = result.result as { value?: T } | undefined;
  return wrapper?.value as T;
}

export async function runAdb(
  serial: string | undefined,
  args: readonly string[],
  options: { readonly input?: Uint8Array; readonly timeoutMs?: number; readonly signal?: AbortSignal; readonly spawn?: AndroidAdbSpawner } = {},
): Promise<string> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    options.signal?.throwIfAborted();
    const argv = serial === undefined ? ["adb", ...args] : ["adb", "-s", serial, ...args];
    const child = (options.spawn ?? ((argv, options) => Bun.spawn(argv, options)))(argv, {
      stdin: options.input ?? "ignore", stdout: "pipe", stderr: "pipe",
    });
    cancel = () => { child.kill("SIGTERM"); grace ??= setTimeout(() => child.kill("SIGKILL"), 2_000); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    if (options.timeoutMs !== undefined) deadline = setTimeout(cancel, options.timeoutMs);
    // A broken stream must not release the owner while its child can still mutate the device.
    const [stdout, stderr, code] = await Promise.allSettled([
      new Response(child.stdout).text().catch(error => { cancel!(); throw error; }),
      new Response(child.stderr).arrayBuffer().catch(error => { cancel!(); throw error; }),
      child.exited,
    ]);
    if (code.status === "rejected" || stdout.status === "rejected" || stderr.status === "rejected") throw new AndroidAdbError();
    if (code.value !== 0) throw new AndroidAdbError(code.value);
    options.signal?.throwIfAborted();
    return stdout.value;
  } catch (error) {
    if (error instanceof AndroidAdbError) throw error;
    throw new AndroidAdbError();
  } finally {
    clearTimeout(deadline);
    clearTimeout(grace);
    if (cancel !== undefined) options.signal?.removeEventListener("abort", cancel);
  }
}

export function parseAndroidPackageVersion(dumpsys: string): string {
  const version = dumpsys.match(/^\s*versionName=(.+)$/mu)?.[1]?.trim();
  if (version === undefined || version.length === 0) {
    throw new Error("Android package metadata is missing versionName");
  }
  return version;
}

export type AndroidAdbCommand = (...args: string[]) => Promise<string>;

export interface AndroidRadioBaseline {
  readonly airplane: boolean;
  readonly wifi: boolean;
  readonly mobile: boolean;
}

export async function readAndroidRadioBaseline(command: AndroidAdbCommand): Promise<AndroidRadioBaseline> {
  const read = async (name: string) => (await command("shell", "settings", "get", "global", name)).trim();
  // Multi-SIM devices keep mobile data per subscription, and `svc data` toggles the default data
  // subscription's key while the global one can stay stale: a Pixel 10 Pro read `mobile_data=1` with
  // data off. An absent per-subscription key falls back to the global key, never to "off".
  const subscription = await read("multi_sim_data_call");
  const perSubscription = /^[1-9][0-9]*$/u.test(subscription) ? await read(`mobile_data${subscription}`) : "null";
  const mobile = perSubscription === "0" || perSubscription === "1" ? perSubscription : await read("mobile_data");
  return { wifi: await read("wifi_on") === "1", mobile: mobile === "1", airplane: await read("airplane_mode_on") === "1" };
}

export async function restoreAndroidRadios(
  state: AndroidRadioBaseline,
  command: AndroidAdbCommand,
  mutate: AndroidAdbCommand = command,
): Promise<void> {
  await mutate("shell", "cmd", "connectivity", "airplane-mode", state.airplane ? "enable" : "disable");
  await mutate("shell", "svc", "wifi", state.wifi ? "enable" : "disable");
  // Leaving Airplane mode with both radios on, mobile data validates before Wi-Fi rejoins. Play
  // Services opens its push socket there, and once Wi-Fi becomes the default network that socket
  // delivers nothing until its next heartbeat (18.6 min on 2026-09-29), holding every push. Mobile
  // data therefore returns only after Wi-Fi validates; a Wi-Fi that never validates is left to the
  // caller's own reachability check.
  if (state.wifi && state.mobile) {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && !parseValidatedWifi(await command("shell", "dumpsys", "connectivity"))) await Bun.sleep(500);
  }
  await mutate("shell", "svc", "data", state.mobile ? "enable" : "disable");
}

/** Remote ping failure is an unreachable observation; failure to run the adb shell is fatal. */
export async function androidDeviceReachesHost(host: string, command: AndroidAdbCommand): Promise<boolean> {
  // The caller supplies URL.hostname. Assert a shell-safe hostname/IP alphabet before embedding
  // it; accepting arbitrary shell operands here would turn a read-only probe into a mutation.
  if (!/^(?:[A-Za-z0-9][A-Za-z0-9._:-]*|\[[A-Fa-f0-9:.]+\])$/u.test(host)) {
    throw new Error("invalid Android reachability host");
  }
  // Toybox uses exit 2 for unknown host during Airplane mode, not just exit 1 for packet loss.
  // Consume ping's status on the device, never adb's status on the controller.
  const output = await command("shell", `ping -c 1 -W 2 '${host}' || true`);
  return output.includes("1 received");
}

export class AndroidReachabilityPreconditionError extends Error {
  readonly name = "AndroidReachabilityPreconditionError";
  constructor(readonly reason: "unreachable" | "adb-transport", options?: ErrorOptions) {
    super(reason === "unreachable"
      ? "Android gateway reachability prerequisite: connect Tailscale on the Pixel and verify DNS/routing to the configured gateway origin before navigation; no device settings were changed"
      : "Android gateway reachability prerequisite: adb transport failed; restore the authorized USB connection before navigation; no device settings were changed", options);
  }
}

export interface AndroidGatewayReachabilityEvidence {
  readonly icmp: "reachable" | "unreachable" | "failed";
  readonly https: "not_run" | "reachable" | "unreachable" | "failed";
  readonly satisfiedBy: "icmp" | "https" | null;
}

/** Qualification preflights stay read-only/ICMP-only; acceptance explicitly owns its HTTPS alternative. */
export async function requireAndroidGatewayReachability(
  origin: string,
  command: AndroidAdbCommand,
  httpsFallback?: {
    readonly probe: (origin: string) => Promise<boolean>;
    readonly record: (evidence: AndroidGatewayReachabilityEvidence) => unknown | Promise<unknown>;
  },
): Promise<void> {
  const host = new URL(origin).hostname;
  let icmp: AndroidGatewayReachabilityEvidence["icmp"] = "failed";
  let https: AndroidGatewayReachabilityEvidence["https"] = "not_run";
  let satisfiedBy: AndroidGatewayReachabilityEvidence["satisfiedBy"] = null;
  return runWithRestoration("Android gateway reachability", async () => {
    try { icmp = await androidDeviceReachesHost(host, command) ? "reachable" : "unreachable"; }
    catch (error) {
      if (error instanceof AndroidAdbError) throw new AndroidReachabilityPreconditionError("adb-transport", { cause: error });
      throw error;
    }
    if (icmp === "reachable") { satisfiedBy = "icmp"; return; }
    if (httpsFallback !== undefined) {
      https = "failed";
      https = await httpsFallback.probe(origin) ? "reachable" : "unreachable";
      if (https === "reachable") { satisfiedBy = "https"; return; }
    }
    throw new AndroidReachabilityPreconditionError("unreachable");
  }, httpsFallback === undefined ? [] : [() => httpsFallback.record({ icmp, https, satisfiedBy })]);
}

/** A TLS health navigation in an owned device tab; no capability fetch or PWA cache effects. */
export async function androidDeviceHttpsReachesOrigin(
  origin: string,
  { chrome = withAndroidChrome, now = () => performance.now() }: {
    readonly chrome?: typeof withAndroidChrome;
    readonly now?: () => number;
  } = {},
): Promise<boolean> {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
    url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("Android HTTPS reachability requires a credential-free HTTPS origin");
  }
  const healthUrl = new URL("/api/v1/health", url).href;
  const expression = `(() => {
    if (document.readyState !== "complete") return null;
    if (location.href !== ${JSON.stringify(healthUrl)}) return false;
    const status = performance.getEntriesByType("navigation")[0]?.responseStatus;
    if (!Number.isInteger(status) || status < 200 || status >= 300) return false;
    try {
      const health = JSON.parse(document.body?.textContent ?? "");
      return health !== null && typeof health === "object" && !Array.isArray(health) &&
        (health.status === "ready" || health.status === "degraded");
    } catch { return false; }
  })()`;
  const controller = new AbortController(), deadline = now() + 15_000;
  const check = () => {
    controller.signal.throwIfAborted();
    if (now() >= deadline) throw new Error("Android HTTPS reachability deadline");
  };
  const timer = setTimeout(() => controller.abort(new Error("Android HTTPS reachability deadline")), 15_000);
  try {
    const reached = await chrome(async driver => {
      await driver.openTab();
      // Local Network Access blocks an opaque document's tailnet fetch, not this top-level navigation.
      const navigation = await driver.send("Page.navigate", { url: healthUrl });
      check();
      if (navigation.errorText !== undefined) return false;
      for (;;) {
        check();
        // A new document can replace the evaluation context while the navigation commits.
        const result = await driver.evaluate<boolean | null>(expression).catch(() => null);
        check();
        if (typeof result === "boolean") return result;
        await Bun.sleep(LOAD_POLL_MS);
      }
    }, { execution: { signal: controller.signal, deadline } });
    check(); // Cleanup cannot turn a late response into timely admission.
    return reached;
  } finally { clearTimeout(timer); }
}

export const ANDROID_QUALIFICATION_PIN_KEYCHAIN_SERVICE =
  "omp-session-gateway.android-qualification-pin";
const ANDROID_PIN_MIN_LENGTH = 4;
const ANDROID_PIN_MAX_LENGTH = 16;
const ANDROID_KEYGUARD_FAILURE = "Android keyguard authentication failed";

export interface AndroidExecution { readonly signal: AbortSignal; readonly deadline: number }
type AndroidKeychainReader = (account: string, service: string, execution?: AndroidExecution) => Promise<Uint8Array>;
export type AndroidInteractiveAdbShell = (serial: string, input: Uint8Array) => Promise<number>;
export type AndroidKeyguardUnlock = () => Promise<void>;

async function readMacOsKeychainItem(account: string, service: string, execution?: AndroidExecution): Promise<Uint8Array> {
  if (process.platform !== "darwin") throw new Error(ANDROID_KEYGUARD_FAILURE);
  execution?.signal.throwIfAborted();
  if (execution !== undefined && performance.now() >= execution.deadline) throw new Error(ANDROID_KEYGUARD_FAILURE);
  const child = Bun.spawn(
    ["security", "find-generic-password", "-a", account, "-s", service, "-w"],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  let grace: ReturnType<typeof setTimeout> | undefined, cancelled = false;
  const cancel = () => { cancelled = true; child.kill("SIGTERM"); grace ??= setTimeout(() => child.kill("SIGKILL"), 2_000); };
  execution?.signal.addEventListener("abort", cancel, { once: true });
  const timer = execution === undefined ? undefined : setTimeout(cancel, Math.max(1, execution.deadline - performance.now()));
  if (execution?.signal.aborted) cancel();
  try {
    const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
      new Response(child.stdout).arrayBuffer().catch(error => { cancel(); throw error; }),
      new Response(child.stderr).arrayBuffer().catch(error => { cancel(); throw error; }),
      child.exited,
    ]);
    const stdout = stdoutResult.status === "fulfilled" ? new Uint8Array(stdoutResult.value) : new Uint8Array();
    if (stderrResult.status === "fulfilled") new Uint8Array(stderrResult.value).fill(0);
    if (cancelled || exitResult.status !== "fulfilled" || exitResult.value !== 0 ||
      stdoutResult.status !== "fulfilled" || stderrResult.status !== "fulfilled") {
      stdout.fill(0); throw new Error(ANDROID_KEYGUARD_FAILURE);
    }
    return stdout;
  } finally {
    clearTimeout(timer); clearTimeout(grace);
    execution?.signal.removeEventListener("abort", cancel);
  }
}

/** Reads the device-scoped qualification PIN without placing it in argv, env, or logs. */
export async function readAndroidQualificationPin(
  serial: string,
  readKeychain: AndroidKeychainReader = readMacOsKeychainItem,
  execution?: AndroidExecution,
): Promise<Uint8Array> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(serial)) throw new Error(ANDROID_KEYGUARD_FAILURE);
  let bytes: Uint8Array;
  try {
    bytes = await readKeychain(serial, ANDROID_QUALIFICATION_PIN_KEYCHAIN_SERVICE, execution);
  } catch {
    throw new Error(ANDROID_KEYGUARD_FAILURE);
  }
  let length = bytes.length;
  while (length > 0 && (bytes[length - 1] === 10 || bytes[length - 1] === 13)) length -= 1;
  const valid =
    length >= ANDROID_PIN_MIN_LENGTH &&
    length <= ANDROID_PIN_MAX_LENGTH &&
    bytes.subarray(0, length).every(value => value >= 48 && value <= 57);
  if (!valid) {
    bytes.fill(0);
    throw new Error(ANDROID_KEYGUARD_FAILURE);
  }
  const pin = bytes.slice(0, length);
  bytes.fill(0);
  return pin;
}

function androidPinKeyeventStream(pin: Uint8Array): Uint8Array {
  if (
    pin.length < ANDROID_PIN_MIN_LENGTH ||
    pin.length > ANDROID_PIN_MAX_LENGTH ||
    !pin.every(value => value >= 48 && value <= 57)
  ) {
    throw new Error(ANDROID_KEYGUARD_FAILURE);
  }
  const commands = Array.from(
    pin,
    value => `input keyevent KEYCODE_${String.fromCharCode(value)}\n`,
  );
  commands.push("input keyevent KEYCODE_ENTER\nexit\n");
  return new TextEncoder().encode(commands.join(""));
}

async function runAndroidInteractiveAdbShell(serial: string, input: Uint8Array, execution?: AndroidExecution): Promise<number> {
  if (execution !== undefined && performance.now() >= execution.deadline) throw new Error(ANDROID_KEYGUARD_FAILURE);
  await runAdb(serial, ["shell"], { input, ...(execution === undefined ? {} :
    { signal: execution.signal, timeoutMs: Math.max(1, execution.deadline - performance.now()) }) });
  return 0;
}

/** Authenticates once through one interactive adb shell; every failure is deliberately redacted. */
export async function unlockAndroidKeyguard(
  serial: string,
  readPin?: (serial: string) => Promise<Uint8Array>,
  runShell?: AndroidInteractiveAdbShell,
  execution?: AndroidExecution,
): Promise<void> {
  let pin: Uint8Array;
  try {
    pin = await (readPin === undefined ? readAndroidQualificationPin(serial, undefined, execution) : readPin(serial));
  } catch {
    throw new Error(ANDROID_KEYGUARD_FAILURE);
  }
  try {
    const input = androidPinKeyeventStream(pin);
    try {
      const code = await (runShell === undefined ? runAndroidInteractiveAdbShell(serial, input, execution) : runShell(serial, input));
      if (code !== 0) throw new Error(ANDROID_KEYGUARD_FAILURE);
    } catch {
      throw new Error(ANDROID_KEYGUARD_FAILURE);
    } finally {
      input.fill(0);
    }
  } finally {
    pin.fill(0);
  }
}

function parseWakefulness(output: string): string {
  return output.match(/mWakefulness=(\w+)/u)?.[1] ?? "unknown";
}

export function parseKeyguardShowing(output: string): boolean {
  const value = output.match(/^\s*isKeyguardShowing=(true|false)$/mu)?.[1];
  if (value === undefined) throw new Error("Android window state is missing isKeyguardShowing");
  return value === "true";
}

/**
 * Whether the Pixel shares its connection through a hotspot, USB or Bluetooth tethering.
 * `dumpsys tethering` reports `Upstream wanted: true` while any downstream is tethered.
 */
export function parseAndroidTethering(output: string): boolean {
  const wanted = output.match(/^\s*Upstream wanted: (true|false)\r?$/mu)?.[1];
  if (wanted === undefined) throw new Error("Android tethering state is missing Upstream wanted");
  return wanted === "true" || /^\s*\S+ - TetheredState - lastError = -?\d+\r?$/mu.test(output);
}

/** Read-only admission: require the Tailscale Doze exemption, then the lane-selected prerequisites. */
export async function requireAndroidDevicePreconditions(
  command: AndroidAdbCommand,
  requirements: { readonly switchesRadios: boolean; readonly needsNotifications: boolean },
): Promise<void> {
  let allowlist: string;
  try {
    allowlist = await command("shell", "dumpsys", "deviceidle", "whitelist");
  } catch {
    throw new Error("cannot verify the Pixel's Tailscale (com.tailscale.ipn) Doze allowlist; restore adb access and retry; no device settings were changed");
  }
  if (!/^(?:user|system),com\.tailscale\.ipn,[0-9]+\r?$/mu.test(allowlist)) {
    throw new Error("Tailscale (com.tailscale.ipn) must be on the Pixel's Doze allowlist before qualification or smoke: set Settings → Apps → Tailscale → Battery → Unrestricted, or run adb shell dumpsys deviceidle whitelist +com.tailscale.ipn; no device settings were changed");
  }
  if (requirements.switchesRadios) {
    let tethering: boolean;
    try {
      tethering = parseAndroidTethering(await command("shell", "dumpsys", "tethering"));
    } catch {
      throw new Error("cannot verify Android tethering state; refuse radio-switching qualification");
    }
    if (tethering) {
      throw new Error("turn off hotspot, USB and Bluetooth tethering on the Pixel: qualification switches its radios, which disconnects every tethered client, including this controller");
    }
  }
  if (requirements.needsNotifications) {
    let zenMode: string;
    try {
      zenMode = (await command("shell", "settings", "get", "global", "zen_mode")).trim();
    } catch {
      throw new Error("cannot verify Android Do Not Disturb state; refuse notification qualification");
    }
    if (!/^[0-3]$/u.test(zenMode)) throw new Error("cannot verify Android Do Not Disturb state; refuse notification qualification");
    if (zenMode !== "0") throw new Error("turn Do Not Disturb off on the Pixel for the qualification window");
  }
}

/**
 * Whether a live Wi-Fi network is connected and validated, read only from the `Current Networks:`
 * section of `dumpsys connectivity`: requests and histories elsewhere also name Wi-Fi.
 */
export function parseValidatedWifi(output: string): boolean {
  const lines = output.split(/\r?\n/u);
  const start = lines.findIndex(line => /^Current Networks:\s*$/u.test(line));
  if (start < 0) throw new Error("Android connectivity state is missing Current Networks");
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break;
    if (/^\s+NetworkAgentInfo\{/u.test(line) && /\bni\{WIFI CONNECTED\b/u.test(line) && /\blastValidated\b/u.test(line)) return true;
  }
  return false;
}

/** A connected VPN must be in the live network list, not a request or historical entry. */
export function parseAndroidVpnNetwork(output: string): boolean {
  const lines = output.split(/\r?\n/u);
  const start = lines.findIndex(line => /^Current Networks:\s*$/u.test(line));
  if (start < 0) throw new Error("Android connectivity state is missing Current Networks");
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break;
    if (/^\s+NetworkAgentInfo\{/u.test(line) && /\bni\{VPN CONNECTED\b/u.test(line)) return true;
  }
  return false;
}

/** Pixel SystemUI's standalone fingerprint (alternate) bouncer window holds input focus. */
export function parseAlternateBouncerFocused(output: string): boolean {
  return /^\s*mCurrentFocus=Window\{\S+ u\d+ AlternateBouncerView\}$/mu.test(output);
}
function parseAndroidDisplaySize(output: string): { readonly width: number; readonly height: number } {
  const match = [...output.matchAll(/(\d{3,5})x(\d{3,5})/gu)].at(-1);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 320 || height < 640 || width >= height) {
    throw new Error(ANDROID_KEYGUARD_FAILURE);
  }
  return { width, height };
}


/** Reveals the PIN bouncer without replacing a notification's pending dismiss action. */
export async function showAndroidPinBouncer(
  command: AndroidAdbCommand,
  pause: (milliseconds: number) => Promise<void> = milliseconds => Bun.sleep(milliseconds),
): Promise<void> {
  try {
    const { width, height } = parseAndroidDisplaySize(await command("shell", "wm", "size"));
    const centerX = Math.floor(width / 2);
    if (parseAlternateBouncerFocused(await command("shell", "dumpsys", "window"))) {
      // The standalone fingerprint bouncer ignores the swipe. A tap on its scrim, well above the
      // in-display sensor, hands over to the PIN bouncer and keeps the pending action.
      await command("shell", "input", "tap", String(centerX), String(Math.floor(height / 4)));
    } else {
      await command("shell", "input", "swipe", String(centerX), String(Math.floor((height * 91) / 100)), String(centerX), String(Math.floor(height / 4)), "600");
    }
  } catch { throw new Error(ANDROID_KEYGUARD_FAILURE); }
  await pause(1_200);
}

/** Wakes and unlocks the display before an Activity launch that may otherwise wait forever. */
export async function wakeAndroidDisplay(
  command: AndroidAdbCommand,
  pause: (milliseconds: number) => Promise<void> = milliseconds => Bun.sleep(milliseconds),
  unlockKeyguard?: AndroidKeyguardUnlock,
): Promise<string> {
  let wakefulness = "unknown";
  let keyguardShowing = true;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await command("shell", "input", "keyevent", "224");
    await pause(1_200);
    wakefulness = parseWakefulness(await command("shell", "dumpsys", "power"));
    if (wakefulness !== "Awake") continue;
    keyguardShowing = parseKeyguardShowing(await command("shell", "dumpsys", "window"));
    if (!keyguardShowing) return wakefulness;
    // MENU opens an application popup on an already unlocked phone. Use it only for keyguard.
    await command("shell", "input", "keyevent", "82");
    await command("shell", "wm", "dismiss-keyguard");
    await pause(1_200);
    keyguardShowing = parseKeyguardShowing(await command("shell", "dumpsys", "window"));
    if (!keyguardShowing) return wakefulness;
    if (unlockKeyguard !== undefined) {
      await showAndroidPinBouncer(command, pause);
      await unlockKeyguard();
      // Pixel SystemUI can accept the credential several seconds before window state drops the
      // secure bouncer. Poll without injecting another keyevent or a second credential attempt.
      for (let dismissalAttempt = 0; dismissalAttempt < 40; dismissalAttempt += 1) {
        await pause(500);
        keyguardShowing = parseKeyguardShowing(await command("shell", "dumpsys", "window"));
        if (!keyguardShowing) return wakefulness;
      }
      return "Keyguard";
    }
  }
  return wakefulness === "Awake" && keyguardShowing ? "Keyguard" : wakefulness;
}
export function assertBrowserVersionMatchesPackage(
  packageName: string,
  androidPackageVersion: string,
  browserVersion: Readonly<Record<string, unknown>>,
): void {
  const product = browserVersion.product;
  const cdpVersion = typeof product === "string" ? product.match(/^Chrome\/(.+)$/u)?.[1] : undefined;
  if (cdpVersion !== androidPackageVersion) {
    throw new Error(
      "DevTools browser version does not match " + packageName + ": " +
        JSON.stringify(product) + " != " + JSON.stringify(androidPackageVersion),
    );
  }
}

export function assertDevtoolsEndpointMatchesPackage(
  packageName: string,
  androidPackageVersion: string,
  metadata: unknown,
  expectedPort: number,
): string {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error("DevTools endpoint metadata is invalid");
  }
  const endpoint = metadata as Record<string, unknown>;
  if (endpoint["Android-Package"] !== packageName) {
    throw new Error("DevTools socket is not owned by " + packageName);
  }
  const product = endpoint.Browser;
  const endpointVersion = typeof product === "string" ? product.match(/^Chrome\/(.+)$/u)?.[1] : undefined;
  if (endpointVersion !== androidPackageVersion) {
    throw new Error("DevTools endpoint version does not match " + packageName);
  }
  if (typeof endpoint.webSocketDebuggerUrl !== "string") {
    throw new Error("DevTools endpoint has no browser WebSocket URL");
  }
  const debuggerUrl = new URL(endpoint.webSocketDebuggerUrl);
  if (
    debuggerUrl.protocol !== "ws:" ||
    debuggerUrl.hostname !== "127.0.0.1" ||
    debuggerUrl.port !== String(expectedPort) ||
    debuggerUrl.hash !== "" ||
    debuggerUrl.username !== "" || debuggerUrl.password !== "" ||
    !debuggerUrl.pathname.startsWith("/devtools/browser")
  ) {
    throw new Error("DevTools endpoint WebSocket escaped the local ADB forward");
  }
  return debuggerUrl.href;
}

/** The single authorized device; failure messages never expose device identifiers. */
export async function requireSingleDevice(
  command: AndroidAdbCommand = (...args) => runAdb(undefined, args),
): Promise<string> {
  const listed = await command("devices");
  const serials = listed
    .split("\n")
    .slice(1)
    .map(line => line.trim().split(/\s+/u))
    .filter(parts => parts[1] === "device")
    .map(parts => parts[0] ?? "");
  const serial = serials[0];
  if (serial === undefined) throw new Error("no authorized adb device; check the USB debugging prompt on the phone");
  if (serials.length > 1) throw new Error(`expected one authorized adb device, found ${serials.length}`);
  return serial;
}

/**
 * Starts Chrome and waits for it to leave a cached process state. A cached Chrome accepts the
 * DevTools socket and never answers, so skipping this turns every later call into a timeout.
 */
export async function wakeAndroidChrome(
  serial: string,
  target: AndroidBrowserTarget,
  command: AndroidAdbCommand = (...args) => runAdb(serial, args),
  pause: (milliseconds: number) => Promise<void> = milliseconds => Bun.sleep(milliseconds),
  unlockKeyguard: AndroidKeyguardUnlock = () => unlockAndroidKeyguard(serial),
): Promise<void> {
  const wakefulness = await wakeAndroidDisplay(command, pause, unlockKeyguard);
  if (wakefulness !== "Awake") throw new Error(`Android display did not wake (observed ${wakefulness})`);
  await command("shell", "am", "start", "-W", "-n", target.activity, "-a", "android.intent.action.MAIN");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await command(
      "shell",
      "dumpsys",
      "activity",
      "processes",
      "|",
      "grep",
      target.packageName,
    ).catch(() => "");
    if (!state.includes("CACHED_EMPTY")) return;
    await pause(250);
  }
}

/**
 * Waits for the forwarded DevTools endpoint to answer, not for the browser process to exist.
 * `adb forward` binds the local port whether or not the device-side socket answers: a cold browser
 * reset its first requests (2026-09-22), and one the cached-apps freezer had just released stayed
 * silent for over nine seconds while in the foreground (2026-09-29). The wait is a deadline rather
 * than an attempt count, and its failure names the last connection error's code.
 */
export async function waitForDevtoolsEndpoint(
  url: string,
  request: (url: string) => Promise<Response> = fetch,
  clock: { readonly now: () => number; readonly sleep: (milliseconds: number) => Promise<void> } = {
    now: Date.now,
    sleep: Bun.sleep,
  },
  waitMs = DEVTOOLS_ENDPOINT_WAIT_MS,
): Promise<Response> {
  const deadline = clock.now() + waitMs;
  let lastError: unknown;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request(url);
    } catch (error) {
      lastError = error;
    }
    if (clock.now() >= deadline) break;
    await clock.sleep(Math.min(attempt * 250, 2_000));
  }
  const code = lastError instanceof Error && "code" in lastError && typeof lastError.code === "string" ? ` (${lastError.code})` : "";
  throw new Error(`DevTools endpoint never accepted a connection${code}`, { cause: lastError });
}

/** Resource ownership that could not be discharged, without device identities in its evidence. */
export class AndroidBrowserCleanupError extends AggregateError {
  readonly pixelUnrestored = true;
  constructor(errors: readonly unknown[], readonly remainingResources: number) {
    super(errors, "Android browser containment unproven");
  }
}

/** Drive real Android Chrome; unproven target/forward cleanup poisons device containment. */
export async function withAndroidChrome<T>(
  run: (driver: AndroidChromeDriver) => Promise<T>,
  options: { readonly port?: number; readonly launchBrowser?: boolean;
    readonly execution?: { readonly signal: AbortSignal; readonly deadline: number } } = {},
): Promise<T> {
  const execution = options.execution;
  const check = () => {
    execution?.signal.throwIfAborted();
    if (execution !== undefined && performance.now() >= execution.deadline) throw new Error("Android browser execution deadline");
  };
  check();
  const port = options.port ?? DEFAULT_FORWARD_PORT;
  const target = resolveAndroidBrowserTarget();
  const adb = (serial: string | undefined, args: readonly string[]) => {
    check();
    return runAdb(serial, args, execution === undefined ? {} : { signal: execution.signal, timeoutMs: Math.max(1, execution.deadline - performance.now()) });
  };
  const serial = await requireSingleDevice((...args) => adb(undefined, args));
  const packageVersion = parseAndroidPackageVersion(await adb(serial, ["shell", "dumpsys", "package", target.packageName]));
  if (options.launchBrowser !== false) await wakeAndroidChrome(serial, target, (...args) => adb(serial, args),
    async milliseconds => { check(); await Bun.sleep(milliseconds); check(); },
    () => unlockAndroidKeyguard(serial, undefined, undefined, execution));

  let socket: WebSocket;
  try {
    // Acquisition can succeed remotely before cancellation rejects its local acknowledgement.
    await adb(serial, ["forward", "tcp:" + port, target.devtoolsSocket]);
    const endpointResponse = await waitForDevtoolsEndpoint("http://127.0.0.1:" + port + "/json/version",
      () => { check(); return fetch("http://127.0.0.1:" + port + "/json/version", execution === undefined ? {} : {
        signal: AbortSignal.any([execution.signal, AbortSignal.timeout(Math.max(1, execution.deadline - performance.now()))]) }); },
      { now: () => performance.now(), sleep: async milliseconds => { check(); await Bun.sleep(milliseconds); check(); } });
    if (!endpointResponse.ok) throw new Error("DevTools endpoint metadata request failed");
    // Deliberately outside the retry: a well-formed reply from the wrong browser is a hard failure,
    // never a transient. Desktop Chrome on this workstation answers remote-debugging ports too.
    const webSocketDebuggerUrl = assertDevtoolsEndpointMatchesPackage(
      target.packageName,
      packageVersion,
      await endpointResponse.json(),
      port,
    );
    socket = new WebSocket(webSocketDebuggerUrl);
  } catch (error) {
    try { await runAdb(serial, ["forward", "--remove", "tcp:" + port], execution === undefined ? {} : { timeoutMs: 10_000 }); }
    catch (cleanup) { throw new AndroidBrowserCleanupError([error, cleanup], 1); }
    throw error;
  }
  const pending = new Map<
    number,
    { readonly method: string; readonly cleanup: boolean; cancel(): void; resolve(value: Record<string, unknown>): void; reject(error: Error): void }
  >();
  let nextId = 0;
  let sessionId: string | undefined;
  let targetId: string | undefined;
  let ownsTarget = false;
  let unresolvedTarget = false;
  const eventListeners = new Set<(method: string, parameters: Record<string, unknown>) => void>();
  let cleaning = false;
  let rejectOpening: ((error: Error) => void) | undefined;
  const cancelled = () => {
    rejectOpening?.(new Error("Android browser execution cancelled"));
    for (const [id, entry] of pending) if (!entry.cleanup) {
      // A mutating create may already own a target. Keep its response route alive for the
      // bounded cleanup window so a late targetId is closed, not orphaned.
      if (entry.method === "Target.createTarget") entry.cancel();
      else { pending.delete(id); entry.reject(new Error("Android browser execution cancelled")); }
    }
  };
  execution?.signal.addEventListener("abort", cancelled, { once: true });
  const deadline = execution === undefined ? undefined : setTimeout(cancelled, Math.max(1, execution.deadline - performance.now()));

  socket.onmessage = (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      error?: { message: string };
      result?: Record<string, unknown>;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (message.id === undefined) {
      if (message.method !== undefined) for (const listener of eventListeners) listener(message.method, message.params ?? {});
      return;
    }
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(`CDP ${entry.method}: ${message.error.message}`));
    else entry.resolve(message.result ?? {});
  };

  const send = (method: string, parameters: Record<string, unknown> = {}, useSession = true, explicitSession?: string, cleanup = cleaning) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (!cleanup) check();
      const id = (nextId += 1);
      const timeout = () => {
        if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      };
      let timer = setTimeout(timeout, cleanup ? 10_000 : CALL_TIMEOUT_MS), cancelled = false;
      pending.set(id, { method, cleanup,
        cancel() { if (!cancelled) { cancelled = true; clearTimeout(timer); timer = setTimeout(timeout, 10_000); } },
        resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      const frame: Record<string, unknown> = { id, method, params: parameters };
      const destination = explicitSession ?? (useSession ? sessionId : undefined);
      if (destination !== undefined) frame.sessionId = destination;
      // A lost create acknowledgement is an unresolved mutation, even after its bounded
      // response route expires. Never pretend that deleting the route removed the target.
      if (method === "Target.createTarget") unresolvedTarget = true;
      try { socket.send(JSON.stringify(frame)); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });

  const closeTarget = async (cleanup = cleaning) => {
    if (targetId === undefined) return;
    const result = await send("Target.closeTarget", { targetId }, false, undefined, cleanup);
    if (result.success !== true) throw new Error("Android browser target closure refused");
    targetId = undefined; sessionId = undefined; ownsTarget = false;
  };
  let primaryFailure: unknown, cleanupFailure: unknown, failed = false;
  const cleanupFailures: unknown[] = [];
  let remainingResources = 0;
  let result!: T;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("DevTools WebSocket open timeout")),
        execution === undefined ? OPEN_TIMEOUT_MS : Math.max(1, Math.min(OPEN_TIMEOUT_MS, execution.deadline - performance.now())));
      const finish = (error?: Error) => {
        clearTimeout(timer); rejectOpening = undefined;
        if (error === undefined) resolve(); else reject(error);
      };
      rejectOpening = finish;
      socket.onopen = () => finish();
      socket.onerror = () => finish(new Error("DevTools WebSocket failed; is Chrome awake and adb forwarding?"));
      try { check(); } catch { finish(new Error("Android browser execution cancelled")); }
    });

    const browserVersion = await send("Browser.getVersion", {}, false);
    assertBrowserVersionMatchesPackage(target.packageName, packageVersion, browserVersion);

    const driver: AndroidChromeDriver = {
      serial,
      packageName: target.packageName,
      androidPackageVersion: packageVersion,
      browserActivity: target.activity,
      devtoolsSocket: target.devtoolsSocket,
      version: () => Promise.resolve(browserVersion),
      async openTab() {
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const created = await send("Target.createTarget", { url: "about:blank" }, false);
          if (typeof created.targetId !== "string" || created.targetId === "") {
            throw new Error("CDP Target.createTarget returned no target id");
          }
          targetId = created.targetId;
          ownsTarget = true;
          unresolvedTarget = false;
          try {
            const attached = await send("Target.attachToTarget", { targetId, flatten: true }, false);
            if (typeof attached.sessionId !== "string" || attached.sessionId === "") {
              throw new Error("CDP Target.attachToTarget returned no session id");
            }
            sessionId = attached.sessionId;
            await send("Page.enable");
            await send("Runtime.enable");
            return;
          } catch (error) {
            lastError = error;
            sessionId = undefined;
            // Retain ownership through the cleanup attempt; cancellation cannot suppress closure.
            await closeTarget(true);
            const retryable =
              error instanceof Error && error.message.includes("Session with given id not found");
            if (!retryable || attempt === 3) throw error;
            await Bun.sleep(250);
          }
        }
        throw lastError instanceof Error ? lastError : new Error("could not attach to Android Chrome tab");
      },
      async attachTab(existingTargetId, existingSessionId) {
        const attached = existingSessionId === undefined ? await send("Target.attachToTarget", { targetId: existingTargetId, flatten: true }, false) : { sessionId: existingSessionId };
        if (typeof attached.sessionId !== "string") throw new Error("could not attach to Android page");
        targetId = existingTargetId;
        ownsTarget = false;
        sessionId = attached.sessionId;
        await send("Page.enable");
        await send("Runtime.enable");
      },
      async closeTab() {
        await closeTarget();
      },
      browserSend: (method, parameters) => send(method, parameters, false),
      sessionSend: (session, method, parameters) => send(method, parameters, false, session),
      onEvent(listener) {
        eventListeners.add(listener);
        return () => { eventListeners.delete(listener); };
      },
      async navigate(url: string) {
        let result: Record<string, unknown> = {};
        try {
          result = await send("Page.navigate", { url });
        } catch (error) {
          // Chrome can execute a navigation and lose only the CDP response while its network process
          // is recovering. The document-ready poll below distinguishes that from a failed navigation.
          if (!(error instanceof Error) || error.message !== "CDP timeout: Page.navigate") throw error;
        }
        if (typeof result.errorText === "string") throw new Error(`navigation failed: ${result.errorText}`);
        for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt += 1) {
          check();
          await Bun.sleep(LOAD_POLL_MS);
          const state = await driver
            .evaluate<[string, string]>("[document.readyState, location.href]")
            .catch(() => undefined);
          if (state?.[0] === "complete" && !state[1].startsWith("about:")) return state[1];
        }
        throw new Error(`page did not finish loading: ${url}`);
      },
      async evaluate<T>(expression: string) {
        return evaluationValue<T>(await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }));
      },
      send: (method, parameters) => send(method, parameters),
    };

    result = await run(driver);
  } catch (error) {
    primaryFailure = error; failed = true;
  } finally {
    cleaning = true;
    clearTimeout(deadline);
    execution?.signal.removeEventListener("abort", cancelled);
    for (let attempt = 0; attempt < 2 && targetId !== undefined && ownsTarget; attempt++) {
      try { await closeTarget(true); cleanupFailure = undefined; }
      catch (error) { cleanupFailure = error; }
    }
    if (cleanupFailure !== undefined) { cleanupFailures.push(cleanupFailure); remainingResources++; }
    if (unresolvedTarget) { cleanupFailures.push(new Error("Android target creation outcome unresolved")); remainingResources++; }
    try { socket.close(); }
    catch (error) { cleanupFailures.push(error); remainingResources++; }
    try { await runAdb(serial, ["forward", "--remove", `tcp:${port}`], execution === undefined ? {} : { timeoutMs: 10_000 }); }
    catch (error) { cleanupFailures.push(error); remainingResources++; }
  }
  if (cleanupFailures.length > 0) throw new AndroidBrowserCleanupError(
    failed ? [primaryFailure, ...cleanupFailures] : cleanupFailures, remainingResources);
  if (failed) throw primaryFailure;
  return result;
}

/** Device identity for an evidence record. */
export async function deviceIdentity(serial: string): Promise<Record<string, string>> {
  const property = async (name: string) => (await runAdb(serial, ["shell", "getprop", name])).trim();
  return {
    serial,
    androidRelease: await property("ro.build.version.release"),
    buildId: await property("ro.build.id"),
    sdk: await property("ro.build.version.sdk"),
    model: await property("ro.product.model"),
  };
}
