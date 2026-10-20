import { describe, expect, test } from "bun:test";
import { DeviceCloudAvailabilityHold, deviceCloudHolds, deviceCloudMachineOutcome, parseDeviceCloudHold, type DeviceCloudHold } from "./device-cloud-availability.ts";

const hold: DeviceCloudHold = {
  kind: "device-cloud-availability", stage: "allocation", target: "ipad", vendors: ["testingbot"], reason: "pinned-pool-busy", waitedMs: 600_000,
  epoch: "11111111-2222-4333-8444-555555555555",
};

describe("device-cloud infrastructure classification", () => {
  test("accepts typed holds and only all-hold nonempty aggregate trees", () => {
    const error = new DeviceCloudAvailabilityHold(hold);
    expect(deviceCloudHolds(error)).toEqual([hold]);
    expect(deviceCloudHolds(new AggregateError([error, new AggregateError([error])]))).toEqual([hold, hold]);
    expect(deviceCloudMachineOutcome(error)).toEqual({ outcome: "infrastructure-hold", availabilityHolds: [hold] });
  });
  test.each([
    new Error("no pinned model free within ten minutes"),
    new Error("authentication failed"), new Error("transport failed"),
    new Error("wrapped hold", { cause: new DeviceCloudAvailabilityHold(hold) }),
    new AggregateError([]),
    new AggregateError([new DeviceCloudAvailabilityHold(hold), new Error("audit failed")]),
    new AggregateError([new AggregateError([new DeviceCloudAvailabilityHold(hold)]), new Error("cleanup failed")]),
    { evidence: hold }, null,
  ])("never classifies ordinary, mixed or unknown failures: %j", error => {
    expect(deviceCloudHolds(error)).toBeUndefined();
    expect(deviceCloudMachineOutcome(error)).toBeUndefined();
  });
  test.each([
    { ...hold, detail: "untrusted-vendor-detail" }, { ...hold, vendors: ["unknown"] },
    { ...hold, epoch: "invalid" }, { ...hold, waitedMs: -1 }, { ...hold, waitedMs: 600_001 },
    { ...hold, target: "desktop" }, { ...hold, stage: "other" },
    { ...hold, stage: "preflight", waitedMs: 0 }, { ...hold, epoch: undefined },
  ])("refuses evidence outside the closed grammar: %j", value => {
    expect(() => parseDeviceCloudHold(value)).toThrow("invalid device-cloud availability hold");
  });
  test("serializes the free-admission hold without allocation resources", () => {
    const preflight = { kind: "device-cloud-availability", stage: "preflight", target: "android", vendors: ["testingbot"], reason: "pinned-pool-busy", waitedMs: 0 } as const;
    expect(parseDeviceCloudHold(JSON.parse(JSON.stringify(preflight)))).toEqual(preflight);
  });
});
