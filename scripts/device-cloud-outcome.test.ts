import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceCloudAvailabilityHold } from "./device-cloud-availability.ts";
import { parseDeviceCloudHoldSet, parseDeviceCloudMachineOutcome, readDeviceCloudOutcomeFile, recognizedDeviceCloudOutcome, writeDeviceCloudOutcomeFile } from "./device-cloud-outcome.ts";
import { HANG_DEADLINE_MS } from "../apps/gateway/test/test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

const evidence = { kind: "device-cloud-availability", stage: "preflight", target: "ipad", vendors: ["testingbot"], reason: "pinned-pool-busy", waitedMs: 0 } as const;

describe("closed stable machine outcome channel", () => {
  test.each([1, 2, 3])("serializes every leaf of an all-hold aggregate of %i", count => {
    const holds = Array.from({ length: count }, () => new DeviceCloudAvailabilityHold(evidence));
    const outcome = recognizedDeviceCloudOutcome(new AggregateError(holds));
    if (outcome === undefined) throw new Error("expected a recognized fixture outcome");
    expect(outcome?.availabilityHolds).toHaveLength(count);
    expect(parseDeviceCloudMachineOutcome(outcome)).toEqual(outcome);
    expect(recognizedDeviceCloudOutcome(new AggregateError([...holds, new Error("ordinary diagnostic")]))).toBeUndefined();
  });
  test("refuses empty, oversized, singular, malformed and open evidence sets", () => {
    for (const set of [[], evidence, [evidence, evidence, evidence, evidence], [{ ...evidence, detail: "untrusted" }]]) {
      expect(() => parseDeviceCloudHoldSet(set)).toThrow();
    }
    expect(() => parseDeviceCloudMachineOutcome({ outcome: "infrastructure-hold", availabilityHolds: [evidence], detail: "untrusted" })).toThrow();
    expect(recognizedDeviceCloudOutcome(new AggregateError(Array.from({ length: 4 }, () => new DeviceCloudAvailabilityHold(evidence))))).toBeUndefined();
  });
  test("atomically publishes only the closed file; noisy human stdout is independent", async () => {
    const root = await mkdtemp(join(tmpdir(), "stable-machine-channel-"));
    const path = join(root, "preflight-outcome.json");
    try {
      const module = new URL("./device-cloud-outcome.ts", import.meta.url).href;
      const outcome = { outcome: "infrastructure-hold", availabilityHolds: [evidence] } as const;
      const child = Bun.spawn([process.execPath, "-e", `import {writeDeviceCloudOutcomeFile} from ${JSON.stringify(module)}; console.log("gh run watch: earlier Debian output"); console.log("Mac lane: earlier fixture output"); await writeDeviceCloudOutcomeFile(process.env.TEST_OUTCOME_FILE, ${JSON.stringify(outcome)}); process.exitCode=75;`], {
        env: { ...process.env, TEST_OUTCOME_FILE: path }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(75);
      expect(stderr).toBe("");
      expect(stdout).toContain("earlier fixture output");
      expect(() => JSON.parse(stdout)).toThrow();
      expect(await readDeviceCloudOutcomeFile(path)).toEqual(outcome);
      expect(await readdir(root)).toEqual(["preflight-outcome.json"]);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(outcome);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("missing, duplicate-key and open outcome files fail closed without echo", async () => {
    const root = await mkdtemp(join(tmpdir(), "stable-machine-invalid-"));
    const path = join(root, "outcome.json");
    try {
      await expect(readDeviceCloudOutcomeFile(path)).rejects.toThrow("missing or invalid");
      await writeFile(path, '{"outcome":"private-untrusted-value","outcome":"infrastructure-hold","availabilityHolds":[]}');
      const error = await readDeviceCloudOutcomeFile(path).catch((error: unknown) => error);
      expect(String(error)).not.toContain("private-untrusted-value");
      expect(String(error)).toContain("duplicate");
      await expect(writeDeviceCloudOutcomeFile(path, { outcome: "infrastructure-hold", availabilityHolds: [] })).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
