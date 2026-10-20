/** Closed device-cloud machine evidence, separate from human campaign stdout. */
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { deviceCloudMachineOutcome, parseDeviceCloudHold } from "./device-cloud-availability.ts";
import type { DeviceCloudHold } from "./device-cloud-availability.ts";
import { parseRetainedVendorJson } from "./device-cloud-record-json.ts";

export interface DeviceCloudMachineOutcome {
  readonly outcome: "infrastructure-hold";
  readonly availabilityHolds: readonly DeviceCloudHold[];
}

export function parseDeviceCloudHoldSet(value: unknown): readonly DeviceCloudHold[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new Error("invalid device-cloud availability hold set");
  return value.map(parseDeviceCloudHold);
}

export function parseDeviceCloudMachineOutcome(value: unknown): DeviceCloudMachineOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "availabilityHolds,outcome" ||
    !("outcome" in value) || value.outcome !== "infrastructure-hold" || !("availabilityHolds" in value)) {
    throw new Error("invalid stable infrastructure outcome");
  }
  return { outcome: "infrastructure-hold", availabilityHolds: parseDeviceCloudHoldSet(value.availabilityHolds) };
}

export function recognizedDeviceCloudOutcome(error: unknown): DeviceCloudMachineOutcome | undefined {
  const outcome = deviceCloudMachineOutcome(error);
  if (outcome === undefined) return undefined;
  try { return parseDeviceCloudMachineOutcome(outcome); }
  catch { return undefined; }
}

/** The driver supplies a distinct path inside its private immutable job for each command phase. */
export async function writeDeviceCloudOutcomeFile(path: string | undefined, value: DeviceCloudMachineOutcome): Promise<void> {
  if (path === undefined) return;
  const outcome = parseDeviceCloudMachineOutcome(value);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(outcome)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function readDeviceCloudOutcomeFile(path: string): Promise<DeviceCloudMachineOutcome> {
  const metadata = await lstat(path).catch(() => undefined);
  if (metadata === undefined || !metadata.isFile() || metadata.size < 1 || metadata.size > 16_384) {
    throw new Error("stable infrastructure outcome file is missing or invalid");
  }
  return parseDeviceCloudMachineOutcome(parseRetainedVendorJson(await readFile(path, "utf8")));
}
