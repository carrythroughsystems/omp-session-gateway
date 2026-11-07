import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  ALLOCATION_REPORT_EXPRESSION, DEVICE_CLOUD_PROFILES, DEVICE_CLOUD_TARGETS, SAMSUNG_MODEL_CODES,
  eligibleDevice, type BrowserAllocationReport, type DeviceCloudIdentity, type DeviceCloudTargetAttempt,
} from "./device-cloud-qualification.ts";
import { deviceCloudHolds } from "./device-cloud-availability.ts";
import { recognizedDeviceCloudOutcome } from "./device-cloud-outcome.ts";
import { DEVICE_WAIT_MS, admitDeviceCloud, createDeviceCloudRuntime, deviceCloudVendor, freeDevice, installHomeScreenApp, type DeviceCloudAdmissionDependencies } from "./device-cloud-runtime.ts";
import * as testingbot from "./testingbot.ts";
import { TestingBotApi, TestingBotNativeSession } from "./testingbot.ts";
import { WebDriverError, WebDriverSession } from "./device-cloud-webdriver.ts";
import type { CloudDevice } from "./device-cloud-common.ts";
import { abortablePause } from "./provider-read.ts";
import { JOURNEY_VIEW_STATE } from "./browser-journey.ts";
import type { QualificationExecutionContext } from "./stable-qualification.ts";

const epoch = "11111111-2222-4333-8444-555555555555";
const catalog: readonly CloudDevice[] = [
  { name: "iPhone 17 Pro Max", platform: "iOS", version: "26.6" },
  { name: "iPad (9th generation)", platform: "iOS", version: "26.6" },
  { name: "Galaxy S26", platform: "Android", version: "16.0" },
];
function admission(free: readonly CloudDevice[] = catalog) {
  const reads: string[] = [];
  const dependencies: DeviceCloudAdmissionDependencies = {
    javaRuns: () => true,
    credentials: async () => ({ key: "synthetic-key", secret: "synthetic-secret" }),
    api: () => ({ devices: async scope => { reads.push(scope); return scope === "all" ? catalog : free; } }),
    fallbackReady: async (_environment, target) => { reads.push(`browserstack ${target}`); },
  };
  return { dependencies, reads };
}
function clock() {
  let time = 0;
  const waits: number[] = [];
  return { now: () => time, pause: async (ms: number) => { waits.push(ms); time += ms; }, waits };
}

test("cloud availability backoff observes outer cancellation without another read", async () => {
  const controller = new AbortController();
  let reads = 0;
  const waiting = freeDevice({ devices: async () => { reads += 1; return []; } },
    "iphone", DEVICE_CLOUD_PROFILES.iphone, epoch, {
      now: Date.now, pause: ms => abortablePause(ms, controller.signal),
    });
  await Bun.sleep(5);
  controller.abort(new DOMException("outer cancelled", "AbortError"));
  await expect(waiting).rejects.toThrow("outer cancelled");
  expect(reads).toBe(1);
});

describe("pinned cloud pools", () => {
  test("pins every model, preference, OS floor and Samsung hardware mapping", () => {
    expect(DEVICE_CLOUD_PROFILES.iphone.models).toEqual(["iPhone 17 Pro Max", "iPhone 17 Pro", "iPhone 16", "iPhone 16 Pro", "iPhone Air", "iPhone 17"]);
    expect(DEVICE_CLOUD_PROFILES.ipad.models).toEqual(["iPad (9th generation)"]);
    expect(DEVICE_CLOUD_PROFILES.android.models).toEqual(["Galaxy S26", "Galaxy S25", "Galaxy S24", "Galaxy A55"]);
    expect(DEVICE_CLOUD_TARGETS.map(target => DEVICE_CLOUD_PROFILES[target].minimumOsMajor)).toEqual([26, 26, 14]);
    expect(SAMSUNG_MODEL_CODES).toEqual({ "Galaxy S24": ["SM-S921B"], "Galaxy S25": ["SM-S931B"], "Galaxy S26": ["SM-S942B", "SM-S942U1"] });
    for (const target of DEVICE_CLOUD_TARGETS) {
      const profile = DEVICE_CLOUD_PROFILES[target];
      for (const name of profile.models.filter(name => !profile.disabledModels.includes(name))) {
        expect(eligibleDevice(profile, { name, platform: profile.platform, version: `${profile.minimumOsMajor}.0` })).toBe(true);
        expect(eligibleDevice(profile, { name, platform: profile.platform, version: `${profile.minimumOsMajor - 1}.9` })).toBe(false);
        for (const version of ["", "26.bad", "26.0-secret", "26..0", "NaN"]) expect(eligibleDevice(profile, { name, platform: profile.platform, version })).toBe(false);
      }
    }
  });
  test("refuses obsolete iPads and A55 until its bounded hardware proof exists", async () => {
    expect(DEVICE_CLOUD_PROFILES.android.disabledModels).toEqual(["Galaxy A55"]);
    expect(eligibleDevice(DEVICE_CLOUD_PROFILES.android, { name: "Galaxy A55", platform: "Android", version: "14.0" })).toBe(false);
    for (const name of ["iPad Air 2", "iPad (9th generation)"]) expect(eligibleDevice(DEVICE_CLOUD_PROFILES.ipad, { name, platform: "iOS", version: "15.0" })).toBe(false);
    const adr = await readFile(new URL("../docs/DECISIONS.md", import.meta.url), "utf8");
    expect(adr).toContain("Galaxy A55 remains disabled: the bounded 2026-10-20 public-page probe found no free device, so its observed hardware code awaits proof.");
  });
});

describe("read-only cloud admission", () => {
  test("catalog mode does not check or reserve free hardware", async () => {
    const fixture = admission([]);
    await admitDeviceCloud({}, "catalog", fixture.dependencies);
    expect(fixture.reads).toEqual(["all"]);
  });
  test("valid free-empty inventory is a hold and the dependency boundary exposes only reads", async () => {
    const fixture = admission([]);
    const error = await admitDeviceCloud({}, "free", fixture.dependencies).catch((error: unknown) => error);
    expect(deviceCloudHolds(error)).toMatchObject([{ stage: "preflight", target: "iphone", waitedMs: 0 }]);
    expect(recognizedDeviceCloudOutcome(error)?.availabilityHolds).toHaveLength(1);
    expect(fixture.reads).toEqual(["all", "available", "browserstack ipad", "browserstack android"]);
  });
  test("only empty iPad and Android pools trigger immediate, lazy fallback admission", async () => {
    const fixture = admission([catalog[0]!]);
    await admitDeviceCloud({}, "free", fixture.dependencies);
    expect(fixture.reads).toEqual(["all", "available", "browserstack ipad", "browserstack android"]);
    expect(deviceCloudVendor("iphone", [])).toBe("testingbot");
    for (const target of ["ipad", "android"] as const) {
      expect(deviceCloudVendor(target, [])).toBe("browserstack");
      expect(deviceCloudVendor(target, catalog)).toBe("testingbot");
    }
  });
  test("a primary hold does not hide fallback diagnostics or skip other targets", async () => {
    const fixture = admission([]);
    fixture.dependencies.fallbackReady = async (_environment, target) => {
      fixture.reads.push(`browserstack ${target}`);
      if (target === "ipad") throw new Error("fallback entitlement unavailable");
    };
    const error = await admitDeviceCloud({}, "free", fixture.dependencies).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(deviceCloudHolds(error)).toBeUndefined();
    expect(recognizedDeviceCloudOutcome(error)).toBeUndefined();
    expect(fixture.reads).toEqual(["all", "available", "browserstack ipad", "browserstack android"]);
  });
  test.each(["authentication", "transport", "malformed catalog"])("%s failure is not a hold", async kind => {
    const fixture = admission();
    fixture.dependencies.api = () => ({ devices: async () => { throw new Error(kind); } });
    const error = await admitDeviceCloud({}, "free", fixture.dependencies).catch((error: unknown) => error);
    expect(deviceCloudHolds(error)).toBeUndefined();
  });
});

describe("allocation availability races and bounded wait", () => {
  test("a successful admission snapshot is not a reservation; busy recovers to free", async () => {
    const fixture = admission();
    await admitDeviceCloud({}, "free", fixture.dependencies);
    const time = clock();
    let reads = 0;
    const device = await freeDevice({ devices: async () => ++reads === 3 ? catalog : [] }, "iphone", DEVICE_CLOUD_PROFILES.iphone, epoch, time);
    expect(device).toEqual(catalog[0]!);
    expect(time.waits).toEqual([15_000, 15_000]);
  });
  test("exhausts exactly ten minutes and never sleeps beyond the deadline", async () => {
    const time = clock();
    let reads = 0;
    const error = await freeDevice({ devices: async () => { reads += 1; return []; } }, "ipad", DEVICE_CLOUD_PROFILES.ipad, epoch, time).catch((error: unknown) => error);
    expect(deviceCloudHolds(error)).toMatchObject([{ stage: "allocation", target: "ipad", waitedMs: DEVICE_WAIT_MS, epoch }]);
    expect(time.now()).toBe(DEVICE_WAIT_MS);
    expect(reads).toBe(41);
    expect(time.waits).toEqual(Array(40).fill(15_000));
  });
  test("prefers model order then the newest eligible release", async () => {
    const time = clock();
    const device = await freeDevice({ devices: async () => [
      { name: "iPhone 17", platform: "iOS", version: "27.0" },
      { name: "iPhone 17 Pro Max", platform: "iOS", version: "25.9" },
      { name: "iPhone 17 Pro Max", platform: "iOS", version: "26.5" },
      catalog[0]!,
    ] }, "iphone", DEVICE_CLOUD_PROFILES.iphone, epoch, time);
    expect(device).toEqual(catalog[0]!);
    expect(time.waits).toEqual([]);
  });
});

describe("first-visit service worker settling", () => {
  const restores: (() => void)[] = [];
  afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });

  async function fixture(options: {
    readonly unsettledReads?: number;
    readonly rejectedReads?: number;
    readonly execution?: QualificationExecutionContext;
  } = {}) {
    const time = clock();
    const now = spyOn(Date, "now").mockImplementation(time.now);
    const sleep = spyOn(Bun, "sleep").mockImplementation(milliseconds => time.pause(Number(milliseconds)));
    const credentials = spyOn(testingbot, "readTestingBotCredentials")
      .mockResolvedValue({ key: "synthetic-key", secret: "synthetic-secret" });
    const devices = spyOn(TestingBotApi.prototype, "devices").mockResolvedValue([catalog[2]!]);
    const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({
      stdout: new Response("candidate/apps/web/dist/assets/app.abc123.js\n").body!,
      exited: Promise.resolve(0), kill() {},
    })) as unknown as typeof Bun.spawn);
    restores.push(() => now.mockRestore(), () => sleep.mockRestore(), () => credentials.mockRestore(),
      () => devices.mockRestore(), () => spawn.mockRestore());
    const effects: string[] = [];
    const results: boolean[] = [];
    let navigations = 0, reads = 0;
    let workerExpression: string | undefined;
    const session = {
      vendor: "testingbot", id: "synthetic-session-0001", signal: options.execution?.signal,
      async navigate() { navigations += 1; effects.push("navigate"); },
      async evaluate<T>(expression: string): Promise<T> {
        if (expression === ALLOCATION_REPORT_EXPRESSION) {
          effects.push("attest");
          return {
            family: "android", browser: "chrome", browserVersion: "145.0.7632.159",
            os: "16.0.0", model: "SM-S942B",
          } satisfies BrowserAllocationReport as T;
        }
        if (navigations === 1) {
          workerExpression = expression;
          reads += 1;
          if (reads <= (options.rejectedReads ?? 0)) {
            effects.push("read-rejected");
            throw new Error("SYNTHETIC_FIRST_VISIT_EVALUATION_DETAIL");
          }
          const unsettled = reads <= (options.rejectedReads ?? 0) + (options.unsettledReads ?? 0);
          const settled = await new Function("navigator", `return ${expression};`)({
            serviceWorker: { getRegistration: async () => ({
              installing: unsettled ? { state: "installing" } : null,
              waiting: null, active: unsettled ? null : { state: "activated" },
            }) },
          }) as boolean;
          results.push(settled);
          effects.push(settled ? "settled" : "unsettled");
          return settled as T;
        }
        if (expression === JOURNEY_VIEW_STATE) return { readOnly: true, controlVisible: true, rootMounted: true } as T;
        if (expression.includes("sendInitiallyDisabled")) return { writable: true, sendInitiallyDisabled: true } as T;
        if (expression.includes("missedCount")) return { complete: true, missedCount: 0, residualCount: 0 } as T;
        if (expression.includes("findingCount")) return { launchStatus: 200, launchNoStore: true, findingCount: 0 } as T;
        if (expression.includes("serviceWorker")) { effects.push("journey-shell"); return "ready" as T; }
        return true as T;
      },
    } as unknown as WebDriverSession;
    const create = spyOn(WebDriverSession, "create").mockImplementation(async (_vendor, _username, _password, _capabilities, created) => {
      await created(session.id);
      return { session, capabilities: { platformName: "Android", browserName: "chrome" } };
    });
    restores.push(() => create.mockRestore());
    const identity: DeviceCloudIdentity = {
      tag: "v0.9.1-prealpha.4",
      candidate: { tag: "v0.9.1-prealpha.4", sourceCommit: "a".repeat(40), archiveSha256: "b".repeat(64), archivePath: "/synthetic/archive.tar" },
      omp: {
        bunVersion: "1.4.4", sourceCommit: "c".repeat(40), sourceTree: "d".repeat(40), version: "18.1.20",
        nativeTarballSha256: "e".repeat(64), nativeBinarySha256: "f".repeat(64),
      },
      origin: "https://fixture.invalid",
    };
    const runtime = await createDeviceCloudRuntime({
      identity, workspace: "/synthetic/workspace", environment: {},
      ...(options.execution === undefined ? {} : { execution: options.execution }),
      fixture: async () => { throw new Error("verification must not stage a fixture"); },
    });
    const attempt: DeviceCloudTargetAttempt = {
      epoch,
      session: {
        instanceId: "instance-live", generation: 1, cwdLabel: "synthetic-live", model: "fixture/model",
        startedAt: "2026-10-23T00:00:00.000Z", lastSeenAt: "2026-10-23T00:00:00.000Z",
        canView: true, canControl: true, inputRequired: false,
      },
      allocating: async () => {}, startingTunnel: async () => {}, created: async () => {},
    };
    return { verify: () => runtime.verify("android", attempt), time, effects, results,
      reads: () => reads, expression: () => workerExpression };
  }

  test.each([0, 1])("settles before the journey's first navigation after transient rejected reads (%d)", async rejectedReads => {
    const lane = await fixture({ unsettledReads: 3, rejectedReads });
    await expect(lane.verify()).resolves.toMatchObject({ viewReadOnly: true, controlWritable: true });
    expect(lane.effects.slice(0, 7 + rejectedReads)).toEqual([
      "navigate", "attest", ...Array(rejectedReads).fill("read-rejected"),
      "unsettled", "unsettled", "unsettled", "settled", "navigate",
    ]);
    expect(lane.results).toEqual([false, false, false, true]);
    expect(lane.time.waits).toEqual(Array(3 + rejectedReads).fill(500));
  });

  test("an unsettled first visit exhausts only the bounded wait and still runs the journey gate", async () => {
    const lane = await fixture({ unsettledReads: Infinity });
    await expect(lane.verify()).resolves.toMatchObject({ returnedToDirectory: true });
    expect(lane.time.now()).toBe(60_000);
    expect(lane.time.waits).toEqual(Array(120).fill(500));
    expect(lane.reads()).toBe(121);
    expect(lane.results.every(result => result === false)).toBe(true);
    expect(lane.effects).toContain("journey-shell");
    expect(lane.effects.filter(effect => effect === "navigate")).toHaveLength(3);
  });

  test("cancellation during the abortable pause propagates without navigating into the journey", async () => {
    const controller = new AbortController();
    const reason = new DOMException("outer cancelled", "AbortError");
    const lane = await fixture({ unsettledReads: Infinity,
      execution: { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 1 },
    });
    const waits: number[] = [];
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((_callback: () => void, milliseconds: number) => {
      waits.push(milliseconds);
      queueMicrotask(() => controller.abort(reason));
      return 0;
    }) as unknown as typeof setTimeout);
    restores.push(() => timer.mockRestore());
    await expect(lane.verify()).rejects.toBe(reason);
    expect(waits).toEqual([500]);
    expect(lane.reads()).toBe(1);
    expect(lane.effects).toEqual(["navigate", "attest", "unsettled"]);
  });

  test("the first-visit expression returns only booleans for absent, changing and failed registrations", async () => {
    const lane = await fixture();
    await lane.verify();
    const expression = lane.expression();
    expect(expression).toBeDefined();
    const evaluate = new Function("navigator", `return ${expression};`);
    const active = { state: "activated", scriptURL: "SYNTHETIC_PAGE_DETAIL_NOT_FOR_RESULTS" };
    for (const registration of [
      undefined, { installing: active, waiting: null, active }, { installing: null, waiting: active, active },
      { installing: null, waiting: null, active: null },
      { installing: null, waiting: null, active: { state: "activating" } },
      { installing: null, waiting: null, active: { state: "redundant" } },
    ]) {
      expect(await evaluate({ serviceWorker: { getRegistration: async () => registration } })).toBe(false);
    }
    expect(await evaluate({})).toBe(false);
    expect(await evaluate({ serviceWorker: { getRegistration: async () => { throw new Error(active.scriptURL); } } })).toBe(false);
    expect(await evaluate({ serviceWorker: { getRegistration: async () => ({
      installing: null, waiting: null, active,
    }) } })).toBe(true);
  });
});

describe("TestingBot catalog refusal", () => {
  let restore: (() => void) | undefined;
  afterEach(() => { restore?.(); });
  test.each([
    [401, {}], [404, []], [200, {}], [200, [{ name: "Galaxy S26", platform_name: "Android", version: "16-secret" }]],
    [200, [{ name: "Galaxy S26", version: "16.0" }]],
  ] as const)("HTTP %s malformed or unauthenticated response is diagnostic", async (status, body) => {
    const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json(body, { status }), { preconnect: () => {} }));
    restore = () => { mock.mockRestore(); };
    const error = await new TestingBotApi({ key: "synthetic-key", secret: "synthetic-secret" }).devices("available").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(deviceCloudHolds(error)).toBeUndefined();
  });
});

interface NativeNode { readonly id: string; readonly type: string; readonly label: string }

/** The NSPredicate subset the lane uses: `key == "x"` / `key CONTAINS "x"` joined by AND, OR and parentheses. */
function nodeMatches(node: NativeNode, predicate: string): boolean {
  const tokens = predicate.match(/\(|\)|\bAND\b|\bOR\b|\w+\s+(?:==|CONTAINS)\s+"[^"]*"/gu) ?? [];
  let index = 0;
  const atom = (): boolean => {
    const token = tokens[index++]!;
    if (token === "(") {
      const value = either();
      index += 1;
      return value;
    }
    const [, key, operator, text] = /^(\w+)\s+(==|CONTAINS)\s+"([^"]*)"$/u.exec(token)!;
    const actual = key === "type" ? node.type : key === "label" ? node.label : node.id;
    return operator === "==" ? actual === text : actual.includes(text!);
  };
  const both = (): boolean => {
    let value = atom();
    while (tokens[index] === "AND") { index += 1; value = atom() && value; }
    return value;
  };
  const either = (): boolean => {
    let value = both();
    while (tokens[index] === "OR") { index += 1; value = both() || value; }
    return value;
  };
  return either();
}

describe("Safari Add to Home Screen on iOS 26", () => {
  let restoreSleep: (() => void) | undefined;
  afterEach(() => { restoreSleep?.(); });

  // Observed 2026-10-20 on TestingBot: Share lives in Safari's More menu, and the shortened share
  // sheet expands through a cell labelled "View More" (iOS 26.4) or "More" (26.2). Safari's own
  // toolbar keeps a "More" button on screen, and tapping it dismisses the sheet. A screen may also
  // render its new elements a few lookups after the tap that opened it (iPhone 17 Pro Max, 26.6).
  test.each([["View More", 0], ["More", 0], ["More", 3]] as const)("expands the share sheet through its %s cell, never Safari's More button (render lag %d)", async (expansion, lag) => {
    const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
    restoreSleep = () => sleep.mockRestore();
    const button = (label: string, id = label) => ({ id, type: "XCUIElementTypeButton", label });
    const cell = (label: string, id = label) => ({ id, type: "XCUIElementTypeCell", label });
    const toolbar = [button("Back"), button("Page Menu", "page-menu"), button("refresh"), button("More", "toolbar-more")];
    const screens: Record<string, readonly NativeNode[]> = {
      page: toolbar,
      menu: [...toolbar, button("Share", "menu-share"), button("Add to Bookmarks")],
      sheet: [...toolbar, cell("Mail"), cell("Copy"), cell("Add to Reading List"), cell(expansion, "expand")],
      expanded: [...toolbar, cell("Mail"), cell("Add to Home Screen", "add"), cell("View Less")],
      confirm: [button("Cancel"), button("Add", "confirm")],
      home: [{ id: "icon", type: "XCUIElementTypeIcon", label: "OMP Sessions" }],
      app: [],
    };
    // Either toolbar menu button opens the page menu, and either one dismisses an open share sheet.
    const menuButton = { page: "menu", sheet: "page", expanded: "page" };
    const transitions: Record<string, Record<string, string>> = {
      "page-menu": menuButton, "toolbar-more": menuButton,
      "menu-share": { menu: "sheet" }, expand: { sheet: "expanded" }, add: { expanded: "confirm" }, confirm: { confirm: "home" }, icon: { home: "app" },
    };
    let screen = "page";
    let lookupsSinceTap = 0;
    const element = "element-6066-11e4-a52e-4f735466cecf";
    const session = {
      vendor: "testingbot",
      async command(_operation: string, _method: string, path: string, body?: { value?: string }) {
        // Until the lag passes, only the toolbar of the newly opened screen has rendered.
        const rendered = screen === "page" || lookupsSinceTap >= lag ? screens[screen]! : screens[screen]!.filter(node => toolbar.includes(node as never));
        if (body?.value !== undefined) lookupsSinceTap += 1;
        const visible = rendered.filter(node => body?.value !== undefined && nodeMatches(node, body.value));
        if (path === "/element") {
          if (visible[0] === undefined) throw new WebDriverError("TestingBot element lookup failed with HTTP 404 (no such element)", 404, "no such element");
          return { [element]: visible[0].id };
        }
        if (path === "/elements") return visible.map(node => ({ [element]: node.id }));
        const tapped = /^\/element\/([^/]+)\/click$/u.exec(path)?.[1];
        if (tapped !== undefined) { screen = transitions[decodeURIComponent(tapped)]?.[screen] ?? screen; lookupsSinceTap = 0; }
        return null;
      },
    } as unknown as WebDriverSession;
    await installHomeScreenApp(new TestingBotNativeSession(session));
    expect(screen).toBe("app");
  });
});
