import { describe, expect, spyOn, test, setDefaultTimeout } from "bun:test";
import {
  ANDROID_DIRECTORY_SURFACE_EXPRESSION,
  ANDROID_QUALIFICATION_PIN_KEYCHAIN_SERVICE,
  AndroidAdbError,
  AndroidBrowserCleanupError,
  androidDeviceReachesHost,
  androidDeviceHttpsReachesOrigin,
  requireAndroidGatewayReachability,
  withAndroidChrome,
  type AndroidChromeDriver,
  type AndroidGatewayReachabilityEvidence,
  runAdb,
  type AndroidAdbSpawner,
  type AndroidRadioBaseline,
  assertDevtoolsEndpointMatchesPackage,
  evaluationValue,
  assertBrowserVersionMatchesPackage,
  parseAndroidPackageVersion,
  parseAndroidTethering,
  parseKeyguardShowing,
  parseValidatedWifi,
  readAndroidQualificationPin,
  readAndroidRadioBaseline,
  requireSingleDevice,
  requireAndroidDevicePreconditions,
  unlockAndroidKeyguard,
  wakeAndroidDisplay,
  resolveAndroidBrowserTarget,
  restoreAndroidRadios,
  wakeAndroidChrome,
  waitForDevtoolsEndpoint,
} from "./android-device.ts";
import { HANG_DEADLINE_MS } from "./test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);
describe("Android network reachability", () => {
  test("unsafe host text is rejected before it reaches the device shell", async () => {
    let commands = 0;
    await expect(androidDeviceReachesHost("synthetic.invalid'; echo injected", async () => {
      commands += 1;
      return "1 received";
    })).rejects.toBeInstanceOf(Error);
    expect(commands).toBe(0);
  });

  test.skipIf(process.platform === "win32")("remote ping loss and DNS errors are unreachable observations, not adb failures", async () => {
    for (const pingExit of [1, 2]) {
      const reached = await androidDeviceReachesHost("synthetic-ping.invalid", async (...args) => {
        // Model adb's remote-shell boundary with a real shell, never adb or a real ping.
        if (args[0] !== "shell") throw new Error("unexpected device invocation");
        const child = Bun.spawn(["/bin/sh", "-c", "ping() { printf 'synthetic no-route or DNS failure\\n' >&2; return " + pingExit + "; }; " + args.slice(1).join(" ")], {
          stdin: "ignore", stdout: "pipe", stderr: "pipe",
        });
        const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        if (code !== 0) throw new AndroidAdbError(code);
        return output;
      });
      expect(reached).toBe(false);
    }
  });

  test("an adb transport failure remains fatal even when its exit code resembles ping loss", async () => {
    const error = new AndroidAdbError(1);
    await expect(androidDeviceReachesHost("synthetic-ping.invalid", async () => { throw error; })).rejects.toBe(error);
  });

  test("read-only qualification admission never acquires a browser after ICMP loss", async () => {
    await expect(requireAndroidGatewayReachability("https://gateway-fixture.invalid", async () => "0 received"))
      .rejects.toMatchObject({ reason: "unreachable" });
  });

  test("ICMP success records admission without invoking HTTPS", async () => {
    const evidence: AndroidGatewayReachabilityEvidence[] = [];
    await requireAndroidGatewayReachability("https://gateway-fixture.invalid", async () => "1 received", {
      probe: async () => { throw new Error("HTTPS must not run"); }, record: value => { evidence.push(value); },
    });
    expect(evidence).toEqual([{ icmp: "reachable", https: "not_run", satisfiedBy: "icmp" }]);
  });

  test("a failed HTTPS probe and failed evidence write both retain their original error", async () => {
    const probe = new Error("probe failed"), recording = new Error("recording failed");
    const error = await requireAndroidGatewayReachability("https://gateway-fixture.invalid", async () => "0 received", {
      probe: async () => { throw probe; }, record: value => {
        expect(value).toEqual({ icmp: "unreachable", https: "failed", satisfiedBy: null });
        throw recording;
      },
    }).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([probe, recording]);
  });
});

describe("device-origin HTTPS reachability", () => {
  function fixture(page: {
    readonly finalUrl?: string;
    readonly responseStatus?: unknown;
    readonly body?: string | null;
    readonly errorText?: string;
  } = {}) {
    const calls: { method: string; parameters?: Record<string, unknown> }[] = [];
    let clock = 100, cleaned = false, cleanupDelay = 0, resultDelay = 0;
    let currentUrl = "about:blank", readyStates: string[] = [];
    let containmentError: Error | undefined;
    let execution: { readonly signal: AbortSignal; readonly deadline: number } | undefined;
    // Only the operations this probe uses are implemented; no device, sockets, or host fetches.
    const driver = {
      async openTab() { calls.push({ method: "openTab" }); },
      async evaluate<T>(expression: string): Promise<T> {
        calls.push({ method: "evaluate", parameters: { expression } });
        clock += resultDelay;
        const body = page.body === undefined ? '{"status":"ready"}' : page.body;
        return new Function("document", "location", "performance", `return ${expression};`)(
          { readyState: readyStates.shift() ?? "complete", body: body === null ? null : { textContent: body } },
          { href: page.finalUrl ?? currentUrl },
          { getEntriesByType(type: string) {
            expect(type).toBe("navigation");
            return [{ responseStatus: "responseStatus" in page ? page.responseStatus : 200 }];
          } },
        ) as T;
      },
      async send(method: string, parameters?: Record<string, unknown>): Promise<Record<string, unknown>> {
        calls.push({ method, ...(parameters === undefined ? {} : { parameters }) });
        if (method === "Page.navigate") {
          currentUrl = String(parameters?.url);
          return { frameId: "owned-frame", ...(page.errorText === undefined ? {} : { errorText: page.errorText }) };
        }
        throw new Error("unexpected HTTPS probe operation");
      },
    };
    const chrome = (async (run: (driver: AndroidChromeDriver) => Promise<unknown>, options?: Parameters<typeof withAndroidChrome>[1]) => {
      execution = options?.execution;
      let result: unknown, failure: unknown, failed = false;
      try {
        result = await run(driver as AndroidChromeDriver);
      } catch (error) {
        failed = true; failure = error;
      } finally { cleaned = true; clock += cleanupDelay; }
      if (containmentError !== undefined) throw new AndroidBrowserCleanupError(
        failed ? [failure, containmentError] : [containmentError], 1);
      if (failed) throw failure;
      return result;
    }) as typeof withAndroidChrome;
    return {
      calls, chrome, now: () => clock, cleaned: () => cleaned, execution: () => execution,
      loading: (...states: string[]) => { readyStates = states; },
      delay: (value: number, cleanup = false) => { if (cleanup) cleanupDelay = value; else resultDelay = value; },
      containmentFailure: (error: Error) => { containmentError = error; },
    };
  }

  test("navigates only an owned tab to the exact TLS health URL and validates its committed response", async () => {
    const browser = fixture();
    expect(await androidDeviceHttpsReachesOrigin("https://gateway-fixture.invalid:9443", browser)).toBe(true);
    expect(browser.calls.map(call => call.method)).toEqual(["openTab", "Page.navigate", "evaluate"]);
    expect(browser.calls[1]!.parameters).toEqual({ url: "https://gateway-fixture.invalid:9443/api/v1/health" });
    expect(browser.execution()!.deadline).toBe(15_100);
    expect(browser.execution()!.signal).toBeInstanceOf(AbortSignal);
    expect(browser.cleaned()).toBe(true);
  });

  test.each(["net::ERR_CERT_AUTHORITY_INVALID", "net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS", ""])(
    "a navigation error cannot admit HTTPS: %s", async errorText => {
      const browser = fixture({ errorText });
      expect(await androidDeviceHttpsReachesOrigin("https://gateway-fixture.invalid", browser)).toBe(false);
      expect(browser.calls.map(call => call.method)).toEqual(["openTab", "Page.navigate"]);
      expect(browser.cleaned()).toBe(true);
    },
  );

  test.each(["https://foreign.invalid/api/v1/health", "https://gateway-fixture.invalid/",
    "https://gateway-fixture.invalid/api/v1/health?redirected", "http://gateway-fixture.invalid/api/v1/health",
    "chrome-error://chromewebdata/", "about:blank"])("refuses a redirected or interstitial final URL: %s", async finalUrl => {
    const browser = fixture({ finalUrl });
    expect(await androidDeviceHttpsReachesOrigin("https://gateway-fixture.invalid", browser)).toBe(false);
    expect(browser.cleaned()).toBe(true);
  });

  test.each([0, 199, 300, 301, 403, 500, "200", 200.5, undefined, null])(
    "refuses an unsuccessful or missing navigation response status: %j", async responseStatus => {
      const browser = fixture({ responseStatus });
      expect(await androidDeviceHttpsReachesOrigin("https://gateway-fixture.invalid", browser)).toBe(false);
      expect(browser.cleaned()).toBe(true);
    },
  );

  test.each([200, 204, 299])("a 2xx gateway health response proves reachability: %s", async responseStatus => {
    const browser = fixture({ responseStatus });
    expect(await androidDeviceHttpsReachesOrigin("https://gateway-fixture.invalid", browser)).toBe(true);
    expect(browser.cleaned()).toBe(true);
  });

  test.each(["ready", "degraded"])("gateway readiness %s still proves reachability", async status => {
    const browser = fixture({ body: JSON.stringify({ status }) });
    expect(await androidDeviceHttpsReachesOrigin("https://gateway-fixture.invalid", browser)).toBe(true);
  });

  test.each(["not JSON", "", "<html>interstitial</html>", "null", "[]", '"ready"', "true",
    '{"status":"unknown"}', '{"status":true}', '{"ready":true}', null])(
    "refuses malformed or non-gateway health bodies: %j", async body => {
      const browser = fixture({ body });
      expect(await androidDeviceHttpsReachesOrigin("https://gateway-fixture.invalid", browser)).toBe(false);
      expect(browser.cleaned()).toBe(true);
    },
  );

  test("waits for the health navigation to finish loading before examining its body", async () => {
    const browser = fixture();
    browser.loading("loading", "interactive");
    expect(await androidDeviceHttpsReachesOrigin("https://gateway-fixture.invalid", browser)).toBe(true);
    expect(browser.calls.map(call => call.method)).toEqual(["openTab", "Page.navigate", "evaluate", "evaluate", "evaluate"]);
    expect(browser.cleaned()).toBe(true);
  });

  test("a pending health navigation cannot outlive the deadline", async () => {
    const browser = fixture();
    browser.loading("loading");
    browser.delay(15_000);
    await expect(androidDeviceHttpsReachesOrigin("https://gateway-fixture.invalid", browser))
      .rejects.toThrow("Android HTTPS reachability deadline");
    expect(browser.cleaned()).toBe(true);
  });

  test("an unsuccessful response still closes the owned browser resources", async () => {
    const browser = fixture({ responseStatus: 503 });
    expect(await androidDeviceHttpsReachesOrigin("https://gateway-fixture.invalid", browser)).toBe(false);
    expect(browser.cleaned()).toBe(true);
  });

  test.each(["http://gateway-fixture.invalid", "file:///tmp/probe", "https://user:secret@gateway-fixture.invalid",
    "https://gateway-fixture.invalid/path", "https://gateway-fixture.invalid/?token=synthetic", "https://gateway-fixture.invalid/#synthetic"])(
    "refuses non-origin or credential-bearing input before Chrome effects: %s", async origin => {
      const browser = fixture();
      await expect(androidDeviceHttpsReachesOrigin(origin, browser)).rejects.toThrow("credential-free HTTPS origin");
      expect(browser.calls).toEqual([]);
    },
  );

  test.each([false, true])("late response/cleanup cannot satisfy the deadline (cleanup=%s)", async cleanup => {
    const browser = fixture(); browser.delay(15_000, cleanup);
    await expect(androidDeviceHttpsReachesOrigin("https://gateway-fixture.invalid", browser)).rejects.toThrow("HTTPS reachability deadline");
    expect(browser.cleaned()).toBe(true);
  });

  test("browser containment failures cannot become successful reachability", async () => {
    const browser = fixture(), containment = new Error("target closure refused");
    browser.containmentFailure(containment);
    const failure = await androidDeviceHttpsReachesOrigin("https://gateway-fixture.invalid", browser).catch(error => error);
    expect(failure).toBeInstanceOf(AndroidBrowserCleanupError);
    expect(failure.errors).toEqual([containment]);
    expect(browser.cleaned()).toBe(true);
  });

  test("deadline and browser cleanup failures retain both errors in order", async () => {
    const browser = fixture(), containment = new Error("forward removal refused");
    browser.delay(15_000); browser.containmentFailure(containment);
    const failure = await androidDeviceHttpsReachesOrigin("https://gateway-fixture.invalid", browser).catch(error => error);
    expect(failure).toBeInstanceOf(AndroidBrowserCleanupError);
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0].message).toBe("Android HTTPS reachability deadline");
    expect(failure.errors[1]).toBe(containment);
    expect(browser.cleaned()).toBe(true);
  });
});

describe("Android radio restoration", () => {
  /** `dataSubscription` models a multi-SIM device whose global `mobile_data` key is stale at 1. */
  function radioDevice(initial: AndroidRadioBaseline, connectivity?: () => string, dataSubscription?: number) {
    const state = { ...initial };
    const settings: Record<string, keyof AndroidRadioBaseline> = {
      airplane_mode_on: "airplane", wifi_on: "wifi",
      ...(dataSubscription === undefined ? { mobile_data: "mobile" } : { [`mobile_data${dataSubscription}`]: "mobile" }),
    };
    const spawn: AndroidAdbSpawner = argv => {
      const args = argv.slice(3);
      let stdout = "";
      const key = args[4] ?? "";
      const setting = settings[key];
      if (args.slice(0, 4).join(" ") === "shell settings get global" && setting !== undefined) {
        stdout = state[setting] ? "1\n" : "0\n";
      } else if (args.slice(0, 4).join(" ") === "shell settings get global" && key === "multi_sim_data_call") {
        stdout = `${dataSubscription ?? "null"}\n`;
      } else if (args.slice(0, 4).join(" ") === "shell settings get global" && key === "mobile_data") {
        stdout = "1\n";
      } else if (args.slice(0, 4).join(" ") === "shell cmd connectivity airplane-mode") {
        state.airplane = args[4] === "enable";
      } else if (args.slice(0, 3).join(" ") === "shell svc wifi") {
        state.wifi = args[3] === "enable";
      } else if (args.slice(0, 3).join(" ") === "shell svc data") {
        state.mobile = args[3] === "enable";
      } else if (args.join(" ") === "shell dumpsys connectivity" && connectivity !== undefined) {
        stdout = connectivity();
      } else {
        throw new Error("unexpected synthetic radio command");
      }
      return { stdout: new Response(stdout).body!, stderr: new Response("").body!, exited: Promise.resolve(0), kill: () => {} };
    };
    return { state, command: (...args: string[]) => runAdb("synthetic-radio-device", args, { spawn }) };
  }

  test("Wi-Fi on with mobile data off survives an airplane and cellular round trip", async () => {
    const device = radioDevice({ airplane: false, wifi: true, mobile: false });
    const baseline = await readAndroidRadioBaseline(device.command);
    expect(baseline).toEqual({ airplane: false, wifi: true, mobile: false });
    await restoreAndroidRadios({ airplane: true, wifi: false, mobile: false }, device.command);
    expect(device.state).toEqual({ airplane: true, wifi: false, mobile: false });
    await restoreAndroidRadios({ airplane: false, wifi: false, mobile: true }, device.command);
    expect(device.state).toEqual({ airplane: false, wifi: false, mobile: true });
    await restoreAndroidRadios(baseline, device.command);
    expect(device.state).toEqual({ airplane: false, wifi: true, mobile: false });
    expect(await readAndroidRadioBaseline(device.command)).toEqual(baseline);
  });

  test("a multi-SIM baseline reads the default data subscription, not the stale global key", async () => {
    const device = radioDevice({ airplane: false, wifi: true, mobile: false }, undefined, 3);
    const baseline = await readAndroidRadioBaseline(device.command);
    expect(baseline).toEqual({ airplane: false, wifi: true, mobile: false });
    await restoreAndroidRadios({ airplane: false, wifi: false, mobile: true }, device.command);
    expect(device.state).toEqual({ airplane: false, wifi: false, mobile: true });
    await restoreAndroidRadios(baseline, device.command);
    expect(device.state).toEqual({ airplane: false, wifi: true, mobile: false });
    expect(await readAndroidRadioBaseline(device.command)).toEqual(baseline);
  });

  test("mobile data stays off until the restored Wi-Fi is connected and validated", async () => {
    const waitingStates: AndroidRadioBaseline[] = [];
    let validated = false;
    const device = radioDevice({ airplane: true, wifi: false, mobile: false }, () => {
      waitingStates.push({ ...device.state });
      validated = waitingStates.length === 2;
      return "Current Networks:\n" +
        "  NetworkAgentInfo{network{436} ni{WIFI CONNECTED extra: } " + (validated ? "lastValidated" : "") + "}\n" +
        "Network Requests:\n  NetworkAgentInfo{network{431} ni{WIFI CONNECTED extra: } lastValidated}\n";
    });
    let mobileRestoredAfterValidation = false;
    await restoreAndroidRadios({ airplane: false, wifi: true, mobile: true }, device.command, async (...args) => {
      if (args.join(" ") === "shell svc data enable") mobileRestoredAfterValidation = validated;
      return device.command(...args);
    });
    expect(waitingStates).toEqual([
      { airplane: false, wifi: true, mobile: false },
      { airplane: false, wifi: true, mobile: false },
    ]);
    expect(mobileRestoredAfterValidation).toBe(true);
    expect(device.state).toEqual({ airplane: false, wifi: true, mobile: true });
  });
});

describe("authorized Android selection", () => {
  test("untethered admission allows independent networking and redacts an unavailable probe", async () => {
    await requireAndroidDevicePreconditions(async (...args) =>
      args.join(" ") === "shell dumpsys deviceidle whitelist"
        ? "user,com.tailscale.ipn,10123\n" : "    Upstream wanted: false\n",
    { switchesRadios: true, needsNotifications: false });
    let failure: unknown;
    try {
      await requireAndroidDevicePreconditions(async (...args) => {
        if (args.join(" ") === "shell dumpsys deviceidle whitelist") return "user,com.tailscale.ipn,10123\n";
        throw new Error("synthetic-private-device");
      }, { switchesRadios: true, needsNotifications: false });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("synthetic-private-device");
    expect((failure as Error).cause).toBeUndefined();
  });
  test("failed adb device discovery withholds identifiers and subprocess output", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({
      stdout: new Response("List of devices attached\nSYNTHETIC-ADB-DEVICE device\n").body!,
      stderr: new Response("error: SYNTHETIC-ADB-DEVICE disconnected").body!,
      exited: Promise.resolve(1),
    })) as unknown as typeof Bun.spawn);
    let failure: unknown;
    try { await requireSingleDevice(); }
    catch (error) { failure = error; }
    finally { spawn.mockRestore(); }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("SYNTHETIC-ADB-DEVICE");
    expect((failure as Error).message).not.toContain("disconnected");
    expect((failure as Error).cause).toBeUndefined();
    expect(failure).toBeInstanceOf(AndroidAdbError);
    expect((failure as AndroidAdbError).exitCode).toBe(1);
  });
  test("spawn and pipe failures cannot expose raw adb exceptions", async () => {
    const privateError = new Error("SYNTHETIC-ADB-DEVICE private subprocess failure");
    const spawners: AndroidAdbSpawner[] = [
      () => { throw privateError; },
      () => ({
        stdout: new ReadableStream({ start(controller) { controller.error(privateError); } }),
        stderr: new Response("SYNTHETIC-ADB-DEVICE stderr").body!,
        exited: Promise.resolve(0),
        kill: () => {},
      }),
    ];
    for (const spawn of spawners) {
      let failure: unknown;
      try { await runAdb("SYNTHETIC-ADB-DEVICE", ["shell", "getprop"], { spawn }); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AndroidAdbError);
      expect((failure as AndroidAdbError).exitCode).toBeUndefined();
      expect((failure as Error).message).not.toContain("SYNTHETIC-ADB-DEVICE");
      expect((failure as Error).message).not.toContain("private subprocess failure");
      expect((failure as Error).cause).toBeUndefined();
    }
  });
  test("selects the sole authorized device without accepting offline or unauthorized devices", async () => {
    const listed = "List of devices attached\noffline-private offline\nselected-device device\nunauthorized-private unauthorized\n";
    expect(await requireSingleDevice(async () => listed)).toBe("selected-device");
    await expect(requireSingleDevice(async () => listed.replace("selected-device device\n", ""))).rejects.toThrow("no authorized adb device");
  });

  test("refuses ambiguous devices without disclosing their identifiers", async () => {
    let message = "";
    try {
      await requireSingleDevice(async () => "List of devices attached\nfirst-private device\nsecond-private device\n");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("expected one authorized adb device");
    expect(message).not.toContain("private");
  });
});

describe("Android Tailscale Doze admission", () => {
  const remedy = "Tailscale (com.tailscale.ipn) must be on the Pixel's Doze allowlist before qualification or smoke: " +
    "set Settings → Apps → Tailscale → Battery → Unrestricted, or run " +
    "adb shell dumpsys deviceidle whitelist +com.tailscale.ipn; no device settings were changed";

  function device(allowlist: string) {
    const calls: string[][] = [];
    const state = { allowlist, mutations: 0 };
    const command = async (...args: string[]) => {
      calls.push(args);
      switch (args.join(" ")) {
        case "shell dumpsys deviceidle whitelist": return state.allowlist;
        case "shell dumpsys tethering": return "Upstream wanted: false\n";
        case "shell settings get global zen_mode": return "0\n";
        default: state.mutations += 1; return "";
      }
    };
    return { calls, state, command };
  }

  test.each(["user", "system"])("a strict %s allowlist entry admits qualification and smoke read-only", async kind => {
    for (const needsNotifications of [true, false]) {
      const pixel = device(`system,com.example.other,10001\r\n${kind},com.tailscale.ipn,10123\r\nuser,com.example.last,10124\r\n`);
      await requireAndroidDevicePreconditions(pixel.command, { switchesRadios: true, needsNotifications });
      expect(pixel.calls).toEqual([
        ["shell", "dumpsys", "deviceidle", "whitelist"],
        ["shell", "dumpsys", "tethering"],
        ...(needsNotifications ? [["shell", "settings", "get", "global", "zen_mode"]] : []),
      ]);
      expect(pixel.state.mutations).toBe(0);
    }
  });

  test("a non-exempt Pixel refuses before mutations until the operator adds the exemption", async () => {
    const pixel = device("system,com.example.other,10001\n");
    const journey = async () => {
      await requireAndroidDevicePreconditions(pixel.command, { switchesRadios: true, needsNotifications: true });
      await pixel.command("shell", "dumpsys", "deviceidle", "force-idle");
    };
    await expect(journey()).rejects.toThrow(remedy);
    expect(pixel.calls).toEqual([["shell", "dumpsys", "deviceidle", "whitelist"]]);
    expect(pixel.state.mutations).toBe(0);
    expect(pixel.state.allowlist).toBe("system,com.example.other,10001\n");

    // A separate, explicit operator setup changes the representative pre-existing state.
    pixel.state.allowlist += "user,com.tailscale.ipn,10123\n";
    await requireAndroidDevicePreconditions(pixel.command, { switchesRadios: true, needsNotifications: true });
    expect(pixel.state.mutations).toBe(0);
  });

  test.each([
    "",
    "user,com.tailscale.ipn.debug,10123",
    "system,com.tailscale.ipn.debug,10123",
    "user,other.com.tailscale.ipn,10123",
    "system-excidle,com.tailscale.ipn,10123",
    "User,com.tailscale.ipn,10123",
    "user,com.tailscale.ipn",
    "user,com.tailscale.ipn,",
    "user,com.tailscale.ipn,not-a-uid",
    "user,com.tailscale.ipn,-10123",
    "user,com.tailscale.ipn,10123.5",
    "user,com.tailscale.ipn,10123,extra",
    " user,com.tailscale.ipn,10123",
    "user, com.tailscale.ipn,10123",
    "user,com.tailscale.ipn,10123 trailing",
  ])("malformed or lookalike allowlist evidence does not admit the Pixel: %j", async entry => {
    const pixel = device(`system,com.example.other,10001\n${entry}\n`);
    await expect(requireAndroidDevicePreconditions(pixel.command, { switchesRadios: true, needsNotifications: false }))
      .rejects.toThrow(remedy);
    expect(pixel.calls).toEqual([["shell", "dumpsys", "deviceidle", "whitelist"]]);
    expect(pixel.state.mutations).toBe(0);
  });

  test("an unavailable allowlist probe fails closed with adb details in its private cause only", async () => {
    const calls: string[][] = [];
    const transportFailure = new Error("synthetic-private-device");
    let failure: unknown;
    try {
      await requireAndroidDevicePreconditions(async (...args) => {
        calls.push(args);
        throw transportFailure;
      }, { switchesRadios: true, needsNotifications: false });
    } catch (error) { failure = error; }
    expect((failure as Error).message).toBe(
      "cannot verify the Pixel's Tailscale (com.tailscale.ipn) Doze allowlist; restore adb access and retry; no device settings were changed",
    );
    expect((failure as Error).cause).toBe(transportFailure);
    expect(calls).toEqual([["shell", "dumpsys", "deviceidle", "whitelist"]]);
  });
});

describe("Android directory recovery observation", () => {
  test("accepts a rendered target alongside unrelated sessions without issuing a competing fetch", () => {
    let fetchCalls = 0;
    const evaluate = new Function(
      "document",
      "navigator",
      "performance",
      "fetch",
      `return ${ANDROID_DIRECTORY_SURFACE_EXPRESSION};`,
    ) as (
      document: unknown,
      navigator: unknown,
      performance: unknown,
      fetch: () => never,
    ) => Record<string, unknown>;
    const status = {
      dataset: { kind: "ready" },
      hasAttribute: (name: string) => name === "hidden",
      querySelector: () => ({ textContent: "" }),
    };
    const observed = evaluate(
      {
        visibilityState: "visible",
        querySelector: () => status,
        querySelectorAll: () => ({ length: 3 }),
      },
      { onLine: false },
      { timeOrigin: 123_456, getEntriesByType: () => [{ name: "https://sessions.example/assets/app.abc123.js" }] },
      () => {
        fetchCalls += 1;
        throw new Error("recovery observer must not fetch");
      },
    );

    expect(fetchCalls).toBe(0);
    expect(observed).toMatchObject({
      online: false,
      visibility: "visible",
      statusHidden: true,
      statusKind: "ready",
      sessionCount: 3,
      appAsset: "https://sessions.example/assets/app.abc123.js",
      pageTimeOrigin: 123_456,
      directoryReady: true,
      outageVisible: false,
    });
  });
});


describe("Android browser target", () => {
  test("defaults to stable Chrome and its ordinary DevTools socket", () => {
    expect(resolveAndroidBrowserTarget({})).toEqual({
      packageName: "com.android.chrome",
      activity: "com.android.chrome/com.google.android.apps.chrome.Main",
      devtoolsSocket: "localabstract:chrome_devtools_remote",
    });
  });

  test("requires an explicit socket for an alternate package and keeps every endpoint overrideable", () => {
    expect(() => resolveAndroidBrowserTarget({ OMP_ANDROID_BROWSER_PACKAGE: "com.chrome.canary" })).toThrow(
      "OMP_ANDROID_DEVTOOLS_SOCKET is required for an alternate browser package",
    );
    expect(
      resolveAndroidBrowserTarget({
        OMP_ANDROID_BROWSER_PACKAGE: " org.chromium.chrome ",
        OMP_ANDROID_BROWSER_ACTIVITY: " org.chromium.chrome/org.chromium.chrome.browser.Main ",
        OMP_ANDROID_DEVTOOLS_SOCKET: " localabstract:canary_devtools_remote ",
      }),
    ).toEqual({
      packageName: "org.chromium.chrome",
      activity: "org.chromium.chrome/org.chromium.chrome.browser.Main",
      devtoolsSocket: "localabstract:canary_devtools_remote",
    });
  });

  test("rejects empty overrides instead of silently selecting the wrong browser", () => {
    for (const name of [
      "OMP_ANDROID_BROWSER_PACKAGE",
      "OMP_ANDROID_BROWSER_ACTIVITY",
      "OMP_ANDROID_DEVTOOLS_SOCKET",
    ]) {
      expect(() => resolveAndroidBrowserTarget({ [name]: "  " })).toThrow(`${name} must not be empty`);
    }
  });

  test("rejects selectors that can be interpreted by the Android shell", () => {
    expect(() =>
      resolveAndroidBrowserTarget({ OMP_ANDROID_BROWSER_PACKAGE: "com.chrome.canary;id" }),
    ).toThrow("OMP_ANDROID_BROWSER_PACKAGE must be an Android package name");
    expect(() =>
      resolveAndroidBrowserTarget({
        OMP_ANDROID_BROWSER_ACTIVITY: "com.other.chrome/com.google.android.apps.chrome.Main",
      }),
    ).toThrow("OMP_ANDROID_BROWSER_ACTIVITY must be a component in the selected package");
    expect(() =>
      resolveAndroidBrowserTarget({ OMP_ANDROID_DEVTOOLS_SOCKET: "localabstract:chrome;id" }),
    ).toThrow("OMP_ANDROID_DEVTOOLS_SOCKET must be a localabstract socket name");
  });
});
describe("Android display bootstrap", () => {
  const target = {
    packageName: "com.android.chrome",
    activity: "com.android.chrome/com.google.android.apps.chrome.Main",
    devtoolsSocket: "localabstract:chrome_devtools_remote",
  };

  test("wakes a dreaming display before the blocking Chrome Activity launch", async () => {
    let wakefulness = "Dreaming";
    let wakes = 0;
    let launchedAwake = false;
    await wakeAndroidChrome(
      "serial",
      target,
      async (...args) => {
        if (args.join(" ") === "shell input keyevent 224" && ++wakes > 1) wakefulness = "Awake";
        if (args[1] === "dumpsys" && args[2] === "power") {
          return `mWakefulness=${wakefulness}`;
        }
        if (args[1] === "dumpsys" && args[2] === "window") return "isKeyguardShowing=false";
        if (args[1] === "am" && args[2] === "start") {
          if (wakefulness !== "Awake") throw new Error("Activity launch would block behind the sleeping display");
          launchedAwake = true;
        }
        return "";
      },
      async () => {},
    );

    expect(launchedAwake).toBe(true);
  });
  test("refuses to launch Chrome when the display never wakes", async () => {
    const calls: string[][] = [];
    const failure: unknown = await wakeAndroidChrome(
      "serial",
      target,
      async (...args) => {
        calls.push(args);
        return args[1] === "dumpsys" && args[2] === "power" ? "mWakefulness=Dreaming" : "";
      },
      async () => {},
    ).then(
      () => undefined,
      error => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Android display did not wake (observed Dreaming)");
    expect(calls.some(args => args[1] === "am" && args[2] === "start")).toBe(false);
  });

  test("parses keyguard state and rejects missing state", () => {
    expect(parseKeyguardShowing("  isKeyguardShowing=true\n")).toBe(true);
    expect(parseKeyguardShowing("isKeyguardShowing=false\n")).toBe(false);
    expect(() => parseKeyguardShowing("mWakefulness=Awake")).toThrow(
      "Android window state is missing isKeyguardShowing",
    );
  });

  test("detects hotspot, USB and Bluetooth tethering and rejects a missing tethering state", () => {
    const state = (lines: string) => `Tethering:\n  Tether state:\n${lines}    Upstream wanted: %s\n    Current upstream interface(s): null\n`;
    expect(parseAndroidTethering(state("").replace("%s", "false"))).toBe(false);
    expect(parseAndroidTethering(state("    wlan1 - AvailableState - lastError = 0\n").replace("%s", "false"))).toBe(false);
    for (const iface of ["wlan1", "ncm0", "bt-pan"]) {
      expect(parseAndroidTethering(state(`    ${iface} - TetheredState - lastError = 0\n`).replace("%s", "false"))).toBe(true);
    }
    expect(parseAndroidTethering(state("").replace("%s", "true"))).toBe(true);
    expect(() => parseAndroidTethering("Tethering:\n  Configuration:\n")).toThrow("Android tethering state is missing Upstream wanted");
  });

  test("reads validated Wi-Fi only from the live network list", () => {
    const network = (id: number, kind: string, state: string, flags: string) =>
      `  NetworkAgentInfo{network{${id}}  handle{${id}000}  ni{${kind} ${state} extra: } created=2026-09-29T10:17:33.969Z Score(Policies : ) ${flags}\n`;
    const dump = (current: string, later = "") => `Active default network: 436\n\nCurrent Networks:\n${current}\n${later}Status for known UIDs:\n`;
    const cellular = network(434, "MOBILE[LTE]", "CONNECTED", "firstValidated lastValidated");
    expect(parseValidatedWifi(dump(cellular + network(436, "WIFI", "CONNECTED", "firstValidated lastValidated")))).toBe(true);
    expect(parseValidatedWifi(dump(cellular + network(436, "WIFI", "CONNECTED", "")))).toBe(false);
    expect(parseValidatedWifi(dump(cellular + network(436, "WIFI", "CONNECTING", "")))).toBe(false);
    // A Wi-Fi from before Airplane mode survives in later sections, never in the live list.
    expect(parseValidatedWifi(dump(cellular, `Network Requests:\n${network(431, "WIFI", "CONNECTED", "firstValidated lastValidated")}`))).toBe(false);
    expect(() => parseValidatedWifi("Active default network: none\n")).toThrow("Android connectivity state is missing Current Networks");
  });

  test("waking an unlocked phone preserves the page instead of opening its menu", async () => {
    for (const initiallyLocked of [false, true]) {
      let locked = initiallyLocked;
      let surface = locked ? "keyguard" : "page";
      const state = await wakeAndroidDisplay(async (...args) => {
        const command = args.join(" ");
        if (command === "shell dumpsys power") return "mWakefulness=Awake";
        if (command === "shell dumpsys window") return "isKeyguardShowing=" + locked;
        if (command === "shell input keyevent 82" && !locked) surface = "menu";
        if (command === "shell wm dismiss-keyguard" && locked) { locked = false; surface = "page"; }
        return "";
      }, async () => {});
      expect(state).toBe("Awake");
      expect(surface).toBe("page");
      expect(locked).toBe(false);
    }
  });

  test("reveals the PIN keypad and authenticates once before reporting the display awake", async () => {
    let locked = true;
    let keypad = false;
    let applicationMenuOpened = false;
    let unlocks = 0;
    const state = await wakeAndroidDisplay(
      async (...args) => {
        if (["shell input keyevent 82", "shell wm dismiss-keyguard"].includes(args.join(" ")) && !locked) applicationMenuOpened = true;
        if (args[1] === "input" && args[2] === "swipe") keypad = true;
        if (args.join(" ") === "shell dumpsys power") return "mWakefulness=Awake";
        if (args.join(" ") === "shell wm size") return "Physical size: 1080x2424";
        if (args.join(" ") === "shell dumpsys window") {
          return `isKeyguardShowing=${locked}`;
        }
        return "";
      },
      async () => {},
      async () => {
        if (!keypad) throw new Error("authentication requires the keypad");
        unlocks += 1;
        locked = false;
      },
    );
    expect(state).toBe("Awake");
    expect(unlocks).toBe(1);
    expect(locked).toBe(false);
    expect(applicationMenuOpened).toBe(false);
  });

  test("reaches the PIN keypad through Pixel's standalone fingerprint bouncer, clear of its sensor", async () => {
    // Compose SystemUI answers MENU with a fingerprint bouncer window that ignores the PIN swipe.
    let locked = true, alternate = false, keypad = false, unlocks = 0;
    const gestures: string[][] = [];
    const state = await wakeAndroidDisplay(
      async (...args) => {
        const command = args.join(" ");
        if (command === "shell dumpsys power") return "mWakefulness=Awake";
        if (command === "shell wm size") return "Physical size: 1080x2410";
        if (command === "shell dumpsys window") {
          return `  mCurrentFocus=Window{9878c1f u0 ${alternate ? "AlternateBouncerView" : "NotificationShade"}}\n    isKeyguardShowing=${locked}`;
        }
        if (command === "shell input keyevent 82" && locked && !keypad) alternate = true;
        if (args[1] === "input" && (args[2] === "swipe" || args[2] === "tap")) {
          gestures.push(args.slice(2));
          if (alternate ? args[2] === "tap" : args[2] === "swipe") { alternate = false; keypad = true; }
        }
        return "";
      },
      async () => {},
      async () => {
        if (!keypad) throw new Error("authentication requires the keypad");
        unlocks += 1;
        locked = false;
      },
    );
    expect(state).toBe("Awake");
    expect(unlocks).toBe(1);
    expect(gestures.map(gesture => gesture[0])).toEqual(["tap"]);
    expect(Number(gestures[0]![2])).toBeLessThan(2410 / 2);
  });

  test("fails closed when one authentication attempt leaves the keyguard visible", async () => {
    let unlocks = 0;
    const state = await wakeAndroidDisplay(
      async (...args) => {
        if (args.join(" ") === "shell dumpsys power") return "mWakefulness=Awake";
        if (args.join(" ") === "shell wm size") return "Physical size: 1080x2424";
        if (args.join(" ") === "shell dumpsys window") return "isKeyguardShowing=true";
        return "";
      },
      async () => {},
      async () => {
        unlocks += 1;
      },
    );
    expect(state).toBe("Keyguard");
    expect(unlocks).toBe(1);
  });

  test("rejects an unbounded display gesture before reading the credential", async () => {
    let unlocks = 0;
    const failure = await wakeAndroidDisplay(
      async (...args) => {
        if (args.join(" ") === "shell dumpsys power") return "mWakefulness=Awake";
        if (args.join(" ") === "shell dumpsys window") return "isKeyguardShowing=true";
        if (args.join(" ") === "shell wm size") return "Physical size: 2424x1080";
        return "";
      },
      async () => {},
      async () => {
        unlocks += 1;
      },
    ).then(
      () => undefined,
      error => error as Error,
    );
    expect(failure?.message).toBe("Android keyguard authentication failed");
    expect(unlocks).toBe(0);
  });
});

describe("Android secure keyguard unlock", () => {
  test("retrieves a device-scoped numeric PIN and clears the Keychain buffer", async () => {
    const keychainBytes = new TextEncoder().encode("9071\n");
    const pin = await readAndroidQualificationPin("pixel-serial", async (account, service) => {
      expect(account).toBe("pixel-serial");
      expect(service).toBe(ANDROID_QUALIFICATION_PIN_KEYCHAIN_SERVICE);
      return keychainBytes;
    });
    expect(new TextDecoder().decode(pin)).toBe("9071");
    expect([...keychainBytes]).toEqual([0, 0, 0, 0, 0]);
    pin.fill(0);
  });

  test("sends PIN digits through one interactive adb shell stream and clears memory", async () => {
    const pin = new TextEncoder().encode("9071");
    let observedSerial = "";
    let observedInput = new Uint8Array();
    await unlockAndroidKeyguard(
      "pixel-serial",
      async () => pin,
      async (serial, input) => {
        observedSerial = serial;
        observedInput = input.slice();
        return 0;
      },
    );
    expect(observedSerial).toBe("pixel-serial");
    expect(new TextDecoder().decode(observedInput)).toBe(
      "input keyevent KEYCODE_9\n" +
        "input keyevent KEYCODE_0\n" +
        "input keyevent KEYCODE_7\n" +
        "input keyevent KEYCODE_1\n" +
        "input keyevent KEYCODE_ENTER\n" +
        "exit\n",
    );
    expect([...pin]).toEqual([0, 0, 0, 0]);
    observedInput.fill(0);
  });

  test("redacts invalid credentials and adb transport failures", async () => {
    const invalidBytes = new TextEncoder().encode("12x4");
    const invalidFailure = await readAndroidQualificationPin("pixel-serial", async () => invalidBytes).then(
      () => undefined,
      error => error as Error,
    );
    expect(invalidFailure?.message).toBe("Android keyguard authentication failed");
    expect([...invalidBytes]).toEqual([0, 0, 0, 0]);

    const pin = new TextEncoder().encode("8675309");
    const transportFailure = await unlockAndroidKeyguard(
      "pixel-serial",
      async () => pin,
      async () => {
        throw new Error("transport exposed 8675309");
      },
    ).then(
      () => undefined,
      error => error as Error,
    );
    expect(transportFailure?.message).toBe("Android keyguard authentication failed");
    expect(transportFailure?.message).not.toContain("8675309");
    expect([...pin]).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("Android package evidence", () => {
  test("extracts the installed package version from dumpsys output", () => {
    expect(
      parseAndroidPackageVersion(`Packages:\n  Package [com.chrome.canary]:\n    versionCode=801500000\n    versionName=154.0.8015.0\n`),
    ).toBe("154.0.8015.0");
  });

  test("refuses an evidence record without versionName", () => {
    expect(() => parseAndroidPackageVersion("Package [com.chrome.canary]\n  versionCode=801500000\n")).toThrow(
      "Android package metadata is missing versionName",
    );
  });
});

describe("Android package and DevTools binding", () => {
  test("accepts the same installed and CDP browser version", () => {
    expect(() =>
      assertBrowserVersionMatchesPackage("com.chrome.canary", "154.0.8015.0", {
        product: "Chrome/154.0.8015.0",
        revision: "@r1683520",
      }),
    ).not.toThrow();
  });

  test("rejects a DevTools socket owned by a different browser version", () => {
    expect(() =>
      assertBrowserVersionMatchesPackage("com.chrome.canary", "154.0.8015.0", {
        product: "Chrome/151.0.7922.171",
      }),
    ).toThrow('DevTools browser version does not match com.chrome.canary: "Chrome/151.0.7922.171" != "154.0.8015.0"');
  });
});

describe("Android DevTools endpoint ownership", () => {
  const metadata = {
    "Android-Package": "com.chrome.canary",
    Browser: "Chrome/154.0.8015.0",
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser",
  };

  test("accepts endpoint metadata owned by the selected package and version", () => {
    expect(assertDevtoolsEndpointMatchesPackage("com.chrome.canary", "154.0.8015.0", metadata, 9222)).toBe(
      metadata.webSocketDebuggerUrl,
    );
  });

  test("rejects another package even when both packages share a Chrome version", () => {
    expect(() =>
      assertDevtoolsEndpointMatchesPackage("com.android.chrome", "154.0.8015.0", metadata, 9222),
    ).toThrow("DevTools socket is not owned by com.android.chrome");
  });

  test("rejects a WebSocket URL outside the exact local ADB forward", () => {
    expect(() =>
      assertDevtoolsEndpointMatchesPackage(
        "com.chrome.canary",
        "154.0.8015.0",
        { ...metadata, webSocketDebuggerUrl: "ws://example.invalid/devtools/browser" },
        9222,
      ),
    ).toThrow("DevTools endpoint WebSocket escaped the local ADB forward");
  });

  test("R2 rejects fragments before constructing the DevTools WebSocket", () => {
    expect(() => assertDevtoolsEndpointMatchesPackage("com.chrome.canary", "154.0.8015.0",
      { ...metadata, webSocketDebuggerUrl: `${metadata.webSocketDebuggerUrl}#fragment` }, 9222)).toThrow();
  });
});

describe("Android DevTools endpoint wait", () => {
  const reset = () => Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
  const virtualClock = () => {
    const clock = { elapsed: 0, now: () => clock.elapsed, sleep: async (milliseconds: number) => void (clock.elapsed += milliseconds) };
    return clock;
  };

  test("waits past nine seconds for a browser the freezer just released", async () => {
    const clock = virtualClock();
    const answer = new Response("{}");
    const response = await waitForDevtoolsEndpoint(
      "http://127.0.0.1:9222/json/version",
      async () => {
        if (clock.elapsed < 20_000) throw reset();
        return answer;
      },
      clock,
    );
    expect(response).toBe(answer);
  });

  test("names the last connection error once the deadline passes", async () => {
    const clock = virtualClock();
    const failure = waitForDevtoolsEndpoint("http://127.0.0.1:9222/json/version", async () => { throw reset(); }, clock);
    await expect(failure).rejects.toThrow("DevTools endpoint never accepted a connection (ECONNRESET)");
    expect(clock.elapsed).toBeGreaterThanOrEqual(30_000);
    expect(clock.elapsed).toBeLessThan(32_000);
  });
});

test("a page-side exception from Runtime.evaluate is the step's failure, never an undefined value", () => {
  // The Push lane's replay evaluated `navigator.serviceWorker.ready` inside a WebAPK that was
  // showing chrome-error:// (gateway unreachable at launch); the rejection was read as
  // `undefined` and the lane reported only "replayed notification unavailable" (2026-10-02).
  expect(evaluationValue<string>({ result: { type: "string", value: "complete" } })).toBe("complete");
  expect(evaluationValue<undefined>({ result: { type: "undefined" } })).toBeUndefined();
  expect(() => evaluationValue({ result: { type: "object", value: {} }, exceptionDetails: { exceptionId: 1, text: "Uncaught (in promise) TypeError", exception: { description: "TypeError: Cannot read properties of undefined (reading 'ready')\n    at <anonymous>:2:56" } } }))
    .toThrow("CDP Runtime.evaluate: TypeError: Cannot read properties of undefined (reading 'ready')");
  expect(() => evaluationValue({ exceptionDetails: { exceptionId: 2, text: "Uncaught" } })).toThrow("CDP Runtime.evaluate: Uncaught");
});
