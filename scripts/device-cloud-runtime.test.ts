import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { DEVICE_CLOUD_PROFILES, DEVICE_CLOUD_TARGETS, SAMSUNG_MODEL_CODES, eligibleDevice } from "./device-cloud-qualification.ts";
import { deviceCloudHolds } from "./device-cloud-availability.ts";
import { DEVICE_WAIT_MS, admitDeviceCloud, deviceCloudVendor, freeDevice, type DeviceCloudAdmissionDependencies } from "./device-cloud-runtime.ts";
import { TestingBotApi } from "./testingbot.ts";
import type { CloudDevice } from "./device-cloud-common.ts";

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

describe("pinned cloud pools", () => {
  test("pins every model, preference, OS floor and Samsung hardware mapping", () => {
    expect(DEVICE_CLOUD_PROFILES.iphone.models).toEqual(["iPhone 17 Pro Max", "iPhone 17 Pro", "iPhone 16", "iPhone 16 Pro", "iPhone Air", "iPhone 17"]);
    expect(DEVICE_CLOUD_PROFILES.ipad.models).toEqual(["iPad (9th generation)"]);
    expect(DEVICE_CLOUD_PROFILES.android.models).toEqual(["Galaxy S26", "Galaxy S25", "Galaxy S24", "Galaxy A55"]);
    expect(DEVICE_CLOUD_TARGETS.map(target => DEVICE_CLOUD_PROFILES[target].minimumOsMajor)).toEqual([26, 26, 14]);
    expect(SAMSUNG_MODEL_CODES).toEqual({ "Galaxy S24": ["SM-S921B"], "Galaxy S25": ["SM-S931B"], "Galaxy S26": ["SM-S942B"] });
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
    expect(fixture.reads).toEqual(["all", "available"]);
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
