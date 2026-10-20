/** Closed infrastructure evidence: provider errors and ambiguous writes are never availability. */
export interface DeviceCloudHold {
  readonly kind: "device-cloud-availability";
  readonly stage: "preflight" | "allocation";
  readonly target: "iphone" | "ipad" | "android";
  readonly vendors: readonly ["testingbot"];
  readonly reason: "pinned-pool-busy";
  readonly waitedMs: number;
  readonly epoch?: string;
}

const EPOCH = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export function parseDeviceCloudHold(value: unknown): DeviceCloudHold {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid device-cloud availability hold");
  const hold = value as Record<string, unknown>;
  const allocation = hold.stage === "allocation";
  if (
    Object.keys(hold).sort().join(",") !== (allocation ? "epoch,kind,reason,stage,target,vendors,waitedMs" : "kind,reason,stage,target,vendors,waitedMs") ||
    hold.kind !== "device-cloud-availability" || typeof hold.stage !== "string" || !["preflight", "allocation"].includes(hold.stage) ||
    typeof hold.target !== "string" || !["iphone", "ipad", "android"].includes(hold.target) || hold.reason !== "pinned-pool-busy" ||
    !Array.isArray(hold.vendors) || hold.vendors.length !== 1 || hold.vendors[0] !== "testingbot" ||
    typeof hold.waitedMs !== "number" || !Number.isSafeInteger(hold.waitedMs) || hold.waitedMs < 0 || hold.waitedMs > 600_000 ||
    (allocation ? typeof hold.epoch !== "string" || !EPOCH.test(hold.epoch) : hold.waitedMs !== 0)
  ) throw new Error("invalid device-cloud availability hold");
  return structuredClone(value) as DeviceCloudHold;
}

export class DeviceCloudAvailabilityHold extends Error {
  readonly evidence: DeviceCloudHold;
  constructor(evidence: DeviceCloudHold) {
    const safe = parseDeviceCloudHold(evidence);
    super(`device-cloud ${safe.target} pinned pool is busy (${safe.stage})`);
    this.name = "DeviceCloudAvailabilityHold";
    this.evidence = safe;
  }
}

/** Every failure leaf must be a typed hold. Never traverse ordinary Error.cause wrappers. */
export function deviceCloudHolds(error: unknown): readonly DeviceCloudHold[] | undefined {
  if (error instanceof DeviceCloudAvailabilityHold) {
    try { return [parseDeviceCloudHold(error.evidence)]; } catch { return undefined; }
  }
  if (!(error instanceof AggregateError) || error.errors.length === 0) return undefined;
  const holds: DeviceCloudHold[] = [];
  for (const child of error.errors) {
    const leaves = deviceCloudHolds(child);
    if (leaves === undefined) return undefined;
    holds.push(...leaves);
  }
  return holds;
}

export function deviceCloudMachineOutcome(error: unknown): { readonly outcome: "infrastructure-hold"; readonly availabilityHolds: readonly DeviceCloudHold[] } | undefined {
  const holds = deviceCloudHolds(error);
  return holds === undefined ? undefined : { outcome: "infrastructure-hold", availabilityHolds: holds };
}
