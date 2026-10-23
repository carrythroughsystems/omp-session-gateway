import { describe, expect, spyOn, test } from "bun:test";
import type { SessionMetadata } from "../packages/protocol/src/types.ts";
import {
  DEVICE_CLOUD_PROFILES,
  DEVICE_CLOUD_TARGETS,
  DeviceCloudJourneyFailure,
  ALLOCATION_REPORT_EXPRESSION,
  attestAllocation,
  cleanupDeviceCloud,
  deviceCloudNeedsCleanup,
  parseDeviceCloudProgress,
  runDeviceCloud,
  type DeviceCloudIdentity,
  type DeviceCloudLaneInput,
  type DeviceCloudObservation,
  type DeviceCloudRuntime,
  type DeviceCloudTarget,
  type BrowserAllocationReport,
} from "./device-cloud-qualification.ts";
import type { DeviceCloudVendor } from "./device-cloud-common.ts";
import { DeviceCloudAvailabilityHold, deviceCloudHolds } from "./device-cloud-availability.ts";
import { createPixelLease, createStableQualificationReceipt, externalCleanupCurrent, runExternalLane, type ExternalLaneModule, type PixelLease } from "./stable-qualification.ts";
import { pixelUnrestored } from "./restoration.ts";
import { TestingBotApi } from "./testingbot.ts";
import { BrowserStackApi, BrowserStackAuditFailure, prepareBrowserStackLocal } from "./browserstack.ts";
import { RetainedVendorJsonError } from "./device-cloud-record-json.ts";

// Distinctive synthetic links: never a real capability shape, so the repository leak scans stay green.
const LINKS: Record<string, Record<"view" | "control", string>> = {
  "instance-fixture": {
    view: "omp-synthetic://relay/SYNTHETIC-CLOUD-FIXTURE-VIEW-4c1e/SYNTHETIC-CLOUD-FIXTURE-VIEWKEY-9b7d2f6a",
    control: "omp-synthetic://relay/SYNTHETIC-CLOUD-FIXTURE-CTRL-8a2f/SYNTHETIC-CLOUD-FIXTURE-CTRLKEY-1d6e4b9c",
  },
  "instance-live": {
    view: "omp-synthetic://relay/SYNTHETIC-CLOUD-LIVE-VIEW-3e5d/SYNTHETIC-CLOUD-LIVE-VIEWKEY-7f0a2c8e",
    control: "omp-synthetic://relay/SYNTHETIC-CLOUD-LIVE-CTRL-6b9f/SYNTHETIC-CLOUD-LIVE-CTRLKEY-5a3d0b1f",
  },
};
const LIVE_LABEL = "omp-stable-live";

const identity: DeviceCloudIdentity = {
  tag: "v0.7.0-prealpha.1",
  candidate: { tag: "v0.7.0-prealpha.1", sourceCommit: "a".repeat(40), archiveSha256: "b".repeat(64), archivePath: "/fixture/archive.tar" },
  omp: {
    bunVersion: "1.4.0", sourceCommit: "c".repeat(40), sourceTree: "d".repeat(40), version: "18.1.20",
    nativeTarballSha256: "e".repeat(64), nativeBinarySha256: "f".repeat(64),
  },
  origin: "https://qual-mac.example.ts.net",
};

interface Harness {
  readonly runtime: DeviceCloudRuntime;
  readonly pixel: PixelLease;
  /** Effects in order, each marked with whether the Pixel lease was held. */
  readonly effects: string[];
  readonly checkpoints: Record<string, unknown>[];
  readonly checkpoint: (progress: Record<string, unknown>) => Promise<void>;
}

function harness(options: {
  readonly record?: (sessionId: string) => string;
  readonly media?: boolean;
  readonly generationChangesAt?: string;
  readonly generationChanges?: "fixture" | "live";
  readonly failing?: string;
  readonly journeyFailures?: Partial<Record<DeviceCloudTarget, number>>;
  readonly failureStage?: "collaboration" | "home-screen";
  readonly hold?: DeviceCloudTarget;
  readonly auditFails?: boolean;
  readonly vendors?: Partial<Record<DeviceCloudTarget, DeviceCloudVendor>>;
  readonly sessionIds?: Partial<Record<DeviceCloudTarget, string>>;
  /** What a target's device reports instead of its first pinned model. */
  readonly evidence?: Partial<Record<DeviceCloudTarget, Record<string, DeviceCloudObservation>>>;
} = {}): Harness {
  const effects: string[] = [];
  const checkpoints: Record<string, unknown>[] = [];
  let leased = false;
  let clock = 0;
  let published = false;
  const attempts: Partial<Record<DeviceCloudTarget, number>> = {};
  const generations: Record<"fixture" | "live", number> = { fixture: 1, live: 1 };
  const effect = (name: string) => {
    effects.push(`${name}${leased ? "" : " (unleased)"}`);
    if (options.failing === name) throw new Error(`${name} failed with vendor detail session-secret-detail`);
  };
  const session = (kind: "fixture" | "live"): SessionMetadata => ({
    instanceId: `instance-${kind}`, generation: generations[kind], cwdLabel: kind === "live" ? LIVE_LABEL : "omp-cloud-fixture",
    model: "fixture/model", startedAt: "2026-09-26T00:00:00.000Z", lastSeenAt: "2026-09-26T00:00:00.000Z",
    canView: true, canControl: true, inputRequired: false,
  });
  const runtime: DeviceCloudRuntime = {
    now: () => clock,
    pause: async milliseconds => {
      clock += milliseconds;
    },
    admit: async () => {
      effects.push("admit");
    },
    fixture: async operation => {
      effect(`fixture ${operation}`);
      published = operation === "start";
    },
    fixtureSession: async () => (published ? session("fixture") : undefined),
    liveSession: async label => (label === LIVE_LABEL ? session("live") : undefined),
    tunnel: async operation => {
      effect(`tunnel ${operation}`);
    },
    verify: async (target, attempt) => {
      const ordinal = attempts[target] = (attempts[target] ?? 0) + 1;
      if (attempt.session.cwdLabel !== LIVE_LABEL) throw new Error("journeys must drive the live session");
      if (target === options.hold) throw new DeviceCloudAvailabilityHold({
        kind: "device-cloud-availability", stage: "allocation", target, vendors: ["testingbot"],
        reason: "pinned-pool-busy", waitedMs: 600_000, epoch: attempt.epoch,
      });
      const vendor = options.vendors?.[target] ?? "testingbot";
      if (vendor === "browserstack") await attempt.startingTunnel(vendor);
      await attempt.allocating(vendor);
      const fixedId = options.sessionIds?.[target];
      const sessionId = fixedId === undefined ? (vendor === "browserstack"
        ? String(DEVICE_CLOUD_TARGETS.indexOf(target) + 1).repeat(39) + ordinal
        : `session-${target}-${String(ordinal).padStart(4, "0")}`) : ordinal === 1 ? fixedId :
          vendor === "browserstack" ? fixedId.slice(0, -1) + ((parseInt(fixedId.slice(-1), 16) + 1) % 16).toString(16) : `${fixedId}-retry`;
      await attempt.created({ vendor, target, sessionId });
      try {
        effect(`verify ${target}`);
        if (ordinal <= (options.journeyFailures?.[target] ?? 0)) throw new Error("synthetic journey failure with vendor-secret-detail");
      } catch (error) { throw new DeviceCloudJourneyFailure(options.failureStage ?? "collaboration", error); }
      if (options.generationChangesAt === target) generations[options.generationChanges ?? "fixture"] += 1;
      return {
        vendor: vendor === "testingbot" ? "TestingBot" : "BrowserStack", tunnelVersion: vendor === "testingbot" ? "4.9" : "8.9",
        device: DEVICE_CLOUD_PROFILES[target].models[0]!, os: "26.6", viewReadOnly: true, controlWritable: true, sinkFindings: 0,
        ...options.evidence?.[target],
      };
    },
    endSession: async ({ sessionId }) => {
      effect(`end ${sessionId}`);
    },
    record: async ({ vendor, sessionId }, remember) => {
      effect(`audit ${sessionId}`);
      if (vendor === "browserstack") await remember?.([{
        url: `https://bs-selenium-logs-usw.s3.us-west-1.amazonaws.com/${sessionId}/synthetic-log`,
        buildId: "c".repeat(40), kind: "text",
      }]);
      if (options.auditFails) throw new Error("vendor audit failed");
      return {
        complete: true,
        text: options.record?.(sessionId) ?? JSON.stringify({ state: "COMPLETE", steps: `POST /url for ${sessionId}` }),
        video: options.media === true,
        screenshots: 0,
      };
    },
    removeRecord: async ({ sessionId }, removal) => { effect(`remove ${sessionId}`); await removal.markDeleted(); },
    launch: async (launched, mode) => LINKS[launched.instanceId]![mode],
    removeWorkspace: async () => {
      effect("workspace remove");
    },
  };
  const pixel: PixelLease = async (_owner, action) => {
    leased = true;
    try {
      return await action();
    } finally {
      leased = false;
    }
  };
  return {
    runtime,
    pixel,
    effects,
    checkpoints,
    checkpoint: async progress => {
      checkpoints.push(structuredClone(progress));
    },
  };
}

function input(test: Harness, progress: unknown = undefined): DeviceCloudLaneInput {
  return { identity, sessionLabel: LIVE_LABEL, progress, checkpoint: test.checkpoint, pixel: test.pixel, runtime: test.runtime };
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a rejection");
}

function errorMessages(error: unknown): string {
  return error instanceof AggregateError ? [error.message, ...error.errors.map(errorMessages)].join("\n") :
    error instanceof Error ? error.message : String(error);
}

describe("device-cloud lane", () => {
  test("records every session before driving it, passes, and releases everything before giving up the lease", async () => {
    const lane = harness();
    const result = await runDeviceCloud(input(lane));
    expect(result).toMatchObject({ passed: true, vendor: "TestingBot", audit: { records: 3, recordsExposingLinks: 0, recordsWithMedia: 0 } });
    const progress = parseDeviceCloudProgress(lane.checkpoints.at(-1));
    expect(progress).toMatchObject({ phase: "restored", cleanupRequired: false });
    expect(progress.sessions).toEqual(DEVICE_CLOUD_TARGETS.map(target => `session-${target}-0001`));
    // Each session id reached a checkpoint before its target was driven.
    for (const target of DEVICE_CLOUD_TARGETS) {
      const firstRecorded = lane.checkpoints.findIndex(saved => JSON.stringify(saved).includes(`session-${target}-0001`));
      const verified = lane.checkpoints.findIndex(saved => saved.phase === `${target}_verified`);
      expect(firstRecorded).toBeGreaterThanOrEqual(0);
      expect(firstRecorded).toBeLessThan(verified);
    }
    expect(lane.effects.filter(effect => effect.endsWith("(unleased)"))).toEqual([]);
    expect(lane.effects.slice(-3)).toEqual([
      "tunnel stop", "fixture stop", "workspace remove",
    ]);

    // The cleanup lane then finds nothing left to release.
    const effects = lane.effects.length;
    expect(await cleanupDeviceCloud(input(lane, progress))).toEqual({ epoch: progress.epoch, restored: true });
    expect(lane.effects).toHaveLength(effects);
  });

  test("ends each target before allocating another under the vendor's two-session limit", async () => {
    const lane = harness();
    const active = new Set<string>();
    let maximumActive = 0;
    const runtime: DeviceCloudRuntime = {
      ...lane.runtime,
      verify: async (target, attempt) => {
        if (active.size >= 2) throw new Error("the vendor refuses a third concurrent session");
        return lane.runtime.verify(target, {
          ...attempt,
          created: async reference => {
            active.add(`${reference.vendor}:${reference.sessionId}`);
            maximumActive = Math.max(maximumActive, active.size);
            await attempt.created(reference);
          },
        });
      },
      endSession: async reference => {
        await lane.runtime.endSession(reference);
        active.delete(`${reference.vendor}:${reference.sessionId}`);
      },
    };
    expect(await runDeviceCloud({ ...input(lane), runtime })).toMatchObject({ passed: true });
    expect(maximumActive).toBe(1);
    expect(active.size).toBe(0);
    expect(lane.effects.indexOf("end session-iphone-0001")).toBeLessThan(lane.effects.indexOf("verify ipad"));
    expect(lane.effects.indexOf("end session-ipad-0001")).toBeLessThan(lane.effects.indexOf("verify android"));
  });

  test("no other Pixel lane starts between the attempt and its release", async () => {
    const lane = harness();
    const lease = createPixelLease(() => {});
    let queued: Promise<unknown> | undefined;
    const runtime: DeviceCloudRuntime = {
      ...lane.runtime,
      verify: async (target, attempt) => {
        queued ??= lease("androidPush", async () => {
          lane.effects.push("androidPush");
        });
        return lane.runtime.verify(target, attempt);
      },
    };
    await runDeviceCloud({ ...input(lane), pixel: lease, runtime });
    await queued;
    expect(lane.effects.map(effect => effect.replace(" (unleased)", "")).slice(-4)).toEqual([
      "tunnel stop", "fixture stop", "workspace remove", "androidPush",
    ]);
  });

  test("a failed cloud release refuses a queued Android lane until cleanup recovery", async () => {
    const lane = harness({ failing: "tunnel stop" });
    const lease = createPixelLease(() => {});
    let queued: Promise<unknown> | undefined;
    let androidStarted = false;
    const runtime: DeviceCloudRuntime = {
      ...lane.runtime,
      verify: async (target, attempt) => {
        queued ??= lease("android", async () => { androidStarted = true; });
        queued.catch(() => {});
        return lane.runtime.verify(target, attempt);
      },
    };
    const error = await runDeviceCloud({ ...input(lane), pixel: lease, runtime }).catch((error: unknown) => error);
    expect(pixelUnrestored(error)).toBe(true);
    if (queued === undefined) throw new Error("the fake Android lane was not queued");
    await expect(queued).rejects.toThrow("left unrestored by deviceCloud");
    expect(androidStarted).toBe(false);
    expect(deviceCloudNeedsCleanup(lane.checkpoints.at(-1))).toBe(true);
    const recovery = harness();
    await cleanupDeviceCloud(input(recovery, lane.checkpoints.at(-1)));
    expect(deviceCloudNeedsCleanup(recovery.checkpoints.at(-1))).toBe(false);
  });

  test("a failed restoration checkpoint also leaves the Pixel lease unrestored", async () => {
    const lane = harness();
    const error = await runDeviceCloud({
      ...input(lane), pixel: createPixelLease(() => {}),
      checkpoint: async progress => {
        if (progress.phase === "restored") throw new Error("restoration checkpoint failed");
        await lane.checkpoint(progress);
      },
    }).catch((error: unknown) => error);
    expect(pixelUnrestored(error)).toBe(true);
    expect(deviceCloudNeedsCleanup(lane.checkpoints.at(-1))).toBe(true);
  });

  test("a failed attempt is still released under its own lease", async () => {
    const lane = harness({ failing: "verify ipad" });
    expect(await failure(runDeviceCloud(input(lane)))).toContain("journey failed twice");
    expect(lane.effects.filter(effect => effect.endsWith("(unleased)"))).toEqual([]);
    expect(lane.effects.slice(-5)).toEqual([
      "audit session-iphone-0001", "audit session-ipad-0002", "tunnel stop", "fixture stop", "workspace remove",
    ]);
    expect(deviceCloudNeedsCleanup(lane.checkpoints.at(-1))).toBe(false);
  });

  test("device text outside the evidence grammar fails the attempt before it is saved", async () => {
    const lane = harness({ evidence: { ipad: { device: "iPad (9th generation)", os: "SYNTHETICKEYREFLECTION7c4b1e9a" } } });
    expect(await failure(runDeviceCloud(input(lane)))).toBe("unsafe device-cloud evidence from the ipad");
    expect(JSON.stringify(lane.checkpoints)).not.toContain("SYNTHETICKEYREFLECTION");
    expect(deviceCloudNeedsCleanup(lane.checkpoints.at(-1))).toBe(false);
  });

  test.each([
    ["the live session's whole View link", LINKS["instance-live"]!.view],
    ["an opaque segment of the fixture's Control link", "SYNTHETIC-CLOUD-FIXTURE-CTRLKEY-1d6e4b9c"],
    ["an interior 16-character window", LINKS["instance-live"]!.view.slice(39, 55)],
    ["a delimiter-crossing 16-character window", LINKS["instance-fixture"]!.control.slice(15, 31)],
  ])("a vendor record holding %s fails the lane without repeating it", async (_name, leaked) => {
    const lane = harness({ record: sessionId => JSON.stringify({ steps: sessionId.includes("ipad") ? `returned ${leaked}` : "clean" }) });
    const message = await failure(runDeviceCloud(input(lane)));
    expect(message).toContain("1 of 3 cloud test records contain a live View or Control link");
    const saved = JSON.stringify(lane.checkpoints);
    for (const text of [message, saved]) expect(text).not.toContain("SYNTHETIC-CLOUD-");
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1)).results.audit).toMatchObject({ records: 3, recordsExposingLinks: 1, recordsWithMedia: 0 });
  });

  test.each(["duplicate-key", "escaped-value"] as const)("audits raw and canonical retained JSON without dropping a %s leak", async form => {
    const leaked = LINKS["instance-live"]!.view.slice(39, 55);
    const encoded = [...leaked].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const raw = form === "duplicate-key"
      ? `{"state":"COMPLETE","assets_available":true,"steps":"${leaked}","steps":"clean","logs":{},"video":false,"thumbs":[]}`
      : `{"state":"COMPLETE","assets_available":true,"steps":"${encoded}","logs":{},"video":false,"thumbs":[]}`;
    const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL) => {
      const path = new URL(String(url)).pathname;
      const sessionId = path.split("/")[3]!;
      return path.endsWith("/assets")
        ? Response.json({ session_id: sessionId, logs: {}, video: null, screenshots: [], har: null, performance: null })
        : new Response(raw);
    }, { preconnect: () => {} }));
    try {
      const lane = harness();
      const api = new TestingBotApi({ key: "synthetic-key", secret: "synthetic-secret" });
      const message = await failure(runDeviceCloud({ ...input(lane), runtime: { ...lane.runtime, record: ({ sessionId }) => api.testRecord(sessionId) } }));
      expect(message).toContain(form === "duplicate-key" ? "device-cloud retained-record audits failed" : "3 of 3 cloud test records contain a live View or Control link");
      expect(message).not.toContain(leaked);
      expect(JSON.stringify(lane.checkpoints)).not.toContain(leaked);
    } finally { mock.mockRestore(); }
  });

  test("an iPad hold ends and audits the partial iPhone attempt before release", async () => {
    const lane = harness({ hold: "ipad" });
    const error = await runDeviceCloud(input(lane)).catch((error: unknown) => error);
    expect(deviceCloudHolds(error)).toHaveLength(1);
    expect(lane.effects.indexOf("end session-iphone-0001")).toBeLessThan(lane.effects.indexOf("audit session-iphone-0001"));
    expect(lane.effects.indexOf("audit session-iphone-0001")).toBeLessThan(lane.effects.indexOf("tunnel stop"));
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1))).toMatchObject({
      phase: "restored", cleanupRequired: false, results: { audit: { records: 1, recordsExposingLinks: 0 } },
    });
    expect(lane.effects.filter(effect => effect.endsWith("(unleased)"))).toEqual([]);
  });

  test.each([{ auditFails: true }, { failing: "tunnel stop" }])("availability combined with audit or cleanup failure is diagnostic: %j", async options => {
    const lane = harness({ hold: "ipad", ...options });
    const error = await runDeviceCloud(input(lane)).catch((error: unknown) => error);
    expect(deviceCloudHolds(error)).toBeUndefined();
    expect(pixelUnrestored(error)).toBe("failing" in options);
    if ("failing" in options) {
      expect(lane.effects).not.toContain("fixture stop");
      expect(lane.effects).not.toContain("workspace remove");
    } else expect(lane.effects).toContain("workspace remove");
  });

  test.each(["fixture", "live"] as const)("a %s generation change before the audit fails instead of searching for the wrong links", async kind => {
    const lane = harness({ generationChangesAt: "android", generationChanges: kind });
    expect(await failure(runDeviceCloud(input(lane)))).toContain("changed generation");
  });

  test("a vendor record with video or screenshots fails the lane", async () => {
    const lane = harness({ media: true });
    expect(await failure(runDeviceCloud(input(lane)))).toContain("kept video or screenshots for 3 of 3 sessions");
  });

  test("an attempt interrupted before its release is released, never resumed", async () => {
    const first = harness({ failing: "verify ipad" });
    await failure(runDeviceCloud(input(first)));
    // The last state saved before the release: what a crash at that point leaves behind.
    const interrupted = first.checkpoints.filter(saved => saved.cleanupRequired === true).at(-1);
    expect(deviceCloudNeedsCleanup(interrupted)).toBe(true);

    const second = harness();
    expect(await failure(runDeviceCloud(input(second, interrupted)))).toContain("requires cleanup before a fresh run");
    expect(second.effects).toEqual([]);
    await cleanupDeviceCloud(input(second, interrupted));
    expect(second.effects).toEqual([
      "tunnel stop", "fixture stop", "workspace remove",
    ]);
  });

  test("a release that cannot finish stays dirty and retries the unfinished cleanup", async () => {
    const run = harness({ failing: "tunnel stop" });
    expect(await failure(runDeviceCloud(input(run)))).toBe("device-cloud cleanup failed: testingbotTunnel");
    const progress = run.checkpoints.at(-1);
    expect(parseDeviceCloudProgress(progress)).toMatchObject({ phase: "evidence_complete", cleanupRequired: true });

    const cleanup = harness({ failing: "tunnel stop" });
    expect(await failure(cleanupDeviceCloud(input(cleanup, progress)))).toBe("device-cloud cleanup failed: testingbotTunnel");
    expect(cleanup.effects).toEqual(["tunnel stop"]);
    expect(cleanup.checkpoints).toEqual([]);
    expect(deviceCloudNeedsCleanup(progress)).toBe(true);
  });

  test("progress from another candidate is refused before any effect", async () => {
    const run = harness();
    await runDeviceCloud(input(run));
    const other = harness();
    const foreign = { ...input(other, run.checkpoints.at(-1)), identity: { ...identity, origin: "https://other-mac.example.ts.net" } };
    expect(await failure(cleanupDeviceCloud(foreign))).toContain("different candidate");
    expect(await failure(runDeviceCloud(foreign))).toContain("different candidate");
    expect(other.effects).toEqual([]);
  });
});

describe("bounded device journey retry", () => {
  test.each([...DEVICE_CLOUD_TARGETS])("retries only a failed %s journey once on the same fixture and epoch", async target => {
    const lane = harness({ journeyFailures: { [target]: 1 } });
    const result = await runDeviceCloud(input(lane));
    expect(result.passed).toBe(true);
    for (const other of DEVICE_CLOUD_TARGETS) {
      expect(lane.effects.filter(effect => effect === `verify ${other}`)).toHaveLength(other === target ? 2 : 1);
    }
    expect(lane.effects.filter(effect => effect === "fixture start")).toHaveLength(1);
    expect(new Set(lane.checkpoints.map(progress => progress.epoch)).size).toBe(1);
    expect(result.journeys).toMatchObject({ [target]: [
      { attempt: 1, outcome: "journey-failed", stage: "collaboration" }, { attempt: 2, outcome: "passed" },
    ] });
    const progress = parseDeviceCloudProgress(lane.checkpoints.at(-1));
    expect(progress.results.audit).toMatchObject({ records: 4, recordsExposingLinks: 0 });
    expect(progress.sessions).toHaveLength(4);
    expect(JSON.stringify(lane.checkpoints)).not.toContain("vendor-secret-detail");
    const first = `session-${target}-0001`;
    expect(lane.effects.indexOf(`end ${first}`)).toBeLessThan(lane.effects.indexOf(`audit ${first}`));
    expect(lane.effects.indexOf(`audit ${first}`)).toBeLessThan(lane.effects.lastIndexOf(`verify ${target}`));
  });

  test("a second journey failure is terminal and both failures remain in the receipt", async () => {
    const lane = harness({ journeyFailures: { ipad: 2 } });
    await expect(runDeviceCloud(input(lane))).rejects.toThrow("journey failed");
    expect(lane.effects.filter(effect => effect === "verify ipad")).toHaveLength(2);
    expect(lane.effects).not.toContain("verify android");
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1))).toMatchObject({
      cleanupRequired: false, journeys: { ipad: [
        { attempt: 1, outcome: "journey-failed" }, { attempt: 2, outcome: "journey-failed" },
      ] },
    });
  });

  test("availability is never retried and retains its typed hold", async () => {
    const lane = harness({ hold: "ipad" });
    let calls = 0;
    const error = await runDeviceCloud({ ...input(lane), runtime: { ...lane.runtime,
      verify: async (target, attempt) => { if (target === "ipad") calls++; return lane.runtime.verify(target, attempt); },
    } }).catch(error => error);
    expect(deviceCloudHolds(error)).toHaveLength(1);
    expect(calls).toBe(1);
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1))).toMatchObject({
      journeys: { ipad: [{ attempt: 1, outcome: "availability-held" }] },
    });
  });

  test("records Home Screen failure separately before its single retry", async () => {
    const lane = harness({ journeyFailures: { iphone: 1 }, failureStage: "home-screen" });
    expect((await runDeviceCloud(input(lane))).journeys).toMatchObject({
      iphone: [{ attempt: 1, outcome: "journey-failed", stage: "home-screen" }, { attempt: 2, outcome: "passed" }],
    });
  });

  test("availability on the second attempt cannot erase the first ordinary failure", async () => {
    const lane = harness({ journeyFailures: { iphone: 1 } });
    let calls = 0;
    const error = await runDeviceCloud({ ...input(lane), runtime: { ...lane.runtime,
      verify: async (target, attempt) => {
        calls++;
        if (calls === 2) throw new DeviceCloudAvailabilityHold({
          kind: "device-cloud-availability", stage: "allocation", target, vendors: ["testingbot"],
          reason: "pinned-pool-busy", waitedMs: 600_000, epoch: attempt.epoch,
        });
        return lane.runtime.verify(target, attempt);
      },
    } }).catch(error => error);
    expect(calls).toBe(2);
    expect(deviceCloudHolds(error)).toBeUndefined();
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1))).toMatchObject({
      cleanupRequired: false, journeys: { iphone: [{ outcome: "journey-failed" }, { outcome: "availability-held" }] },
    });
  });

  test("history refuses a third attempt or a retry without prior containment", async () => {
    const lane = harness({ journeyFailures: { ipad: 1 } });
    await runDeviceCloud(input(lane));
    const progress = parseDeviceCloudProgress(lane.checkpoints.at(-1));
    const third = structuredClone(progress);
    (third.journeys!.ipad as unknown[]).push({ attempt: 3, outcome: "passed" });
    expect(() => parseDeviceCloudProgress(third)).toThrow("attempts");
    for (const change of [{ ended: false }, { audited: false }, { incident: true }, { unauditedDeletion: true }]) {
      const dirty = structuredClone(progress);
      Object.assign(dirty.resources!.find(resource => resource.target === "ipad" && resource.attempt === 1)!, change);
      expect(() => parseDeviceCloudProgress(dirty)).toThrow();
    }
    const reflected = structuredClone(progress);
    Object.assign(reflected.journeys!.ipad![0]!, { stage: "SYNTHETICKEYREFLECTION" });
    expect(() => parseDeviceCloudProgress(reflected)).toThrow("outcome");
  });

  test("all three per-journey budgets remain bounded and their six records stay attributable", async () => {
    const lane = harness({ journeyFailures: { iphone: 1, ipad: 1, android: 1 } });
    const result = await runDeviceCloud(input(lane));
    expect(result.audit).toMatchObject({ records: 6, recordsExposingLinks: 0 });
    const progress = parseDeviceCloudProgress(lane.checkpoints.at(-1));
    expect(progress.resources).toHaveLength(6);
    for (const target of DEVICE_CLOUD_TARGETS) {
      expect(progress.journeys?.[target]).toMatchObject([{ attempt: 1, outcome: "journey-failed" }, { attempt: 2, outcome: "passed" }]);
      expect(progress.resources?.filter(resource => resource.target === target).map(resource => resource.attempt)).toEqual([1, 2]);
    }
  });

  test("an interrupted retry cannot resume or allocate again before old-attempt cleanup", async () => {
    const lane = harness({ journeyFailures: { ipad: 1 } });
    await runDeviceCloud(input(lane));
    const interrupted = lane.checkpoints.find(saved => {
      const progress = parseDeviceCloudProgress(saved);
      return progress.journeys?.ipad?.[1]?.outcome === "running";
    });
    expect(interrupted).toBeDefined();
    const resumed = harness();
    await expect(runDeviceCloud(input(resumed, interrupted))).rejects.toThrow("requires cleanup");
    expect(resumed.effects).toEqual([]);
    const epoch = parseDeviceCloudProgress(interrupted).epoch;
    expect(await cleanupDeviceCloud(input(resumed, interrupted))).toMatchObject({ epoch, restored: true });
    expect(resumed.effects.filter(effect => effect.startsWith("verify "))).toEqual([]);
  });

  test.each(["end", "audit", "remove", "allocation"] as const)("does not retry after %s containment failure", async step => {
    const lane = harness({ journeyFailures: { ipad: 1 }, vendors: { ipad: "browserstack" } });
    let calls = 0;
    const runtime: DeviceCloudRuntime = { ...lane.runtime,
      verify: async (target, attempt) => {
        if (target === "ipad") {
          calls++;
          if (step === "allocation") { await attempt.allocating("testingbot"); throw new Error("ambiguous allocation"); }
        }
        return lane.runtime.verify(target, attempt);
      },
      endSession: async reference => { if (step === "end" && reference.target === "ipad") throw new Error("end failed"); await lane.runtime.endSession(reference); },
      record: async (...args) => { if (step === "audit" && args[0].target === "ipad") throw new Error("audit failed"); return lane.runtime.record(...args); },
      removeRecord: async (...args) => { if (step === "remove" && args[0].target === "ipad") throw new Error("removal failed"); return lane.runtime.removeRecord(...args); },
    };
    await expect(runDeviceCloud({ ...input(lane), runtime })).rejects.toThrow();
    expect(calls).toBe(1);
    expect(lane.effects).not.toContain("verify android");
  });

  test("a BrowserStack retry audits and removes the failed allocation before replacing it", async () => {
    const lane = harness({ journeyFailures: { ipad: 1 }, vendors: { ipad: "browserstack" } });
    const result = await runDeviceCloud(input(lane));
    const first = "2".repeat(39) + "1";
    expect(lane.effects.indexOf(`remove ${first}`)).toBeGreaterThan(lane.effects.indexOf(`audit ${first}`));
    expect(lane.effects.indexOf(`remove ${first}`)).toBeLessThan(lane.effects.lastIndexOf("verify ipad"));
    expect(result.audit).toMatchObject({ records: 4, browserstackRecords: 2 });
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1)).resources?.filter(resource => resource.target === "ipad"))
      .toMatchObject([{ ended: true, audited: true, recordRemoved: true }, { ended: true, audited: true, recordRemoved: true }]);
  });

  test("keeps other lane receipts and binds final cleanup to the single cloud epoch", async () => {
    const lane = harness({ journeyFailures: { ipad: 1 } });
    const receipt = createStableQualificationReceipt(identity.tag, identity.candidate.sourceCommit, "v0.6.9");
    for (const [name, entry] of Object.entries(receipt.lanes)) {
      if (name !== "deviceCloud" && name !== "deviceCloudCleanup") Object.assign(entry, { status: "passed", attempts: 1, evidence: { retained: true } });
    }
    const before = structuredClone(receipt.lanes);
    const module: ExternalLaneModule = {
      preflight: async () => {}, needsCleanup: deviceCloudNeedsCleanup,
      run: context => runDeviceCloud({ ...input(lane), progress: context.progress, checkpoint: context.checkpoint, pixel: context.pixel }),
      cleanup: context => cleanupDeviceCloud({ ...input(lane), progress: context.progress, checkpoint: context.checkpoint, pixel: context.pixel }),
    };
    await runExternalLane(receipt, "deviceCloud", async () => {}, module, {
      identity: { ...identity, previousTag: "v0.6.9", orchestratorCommit: identity.candidate.sourceCommit,
        receiptRoot: "/synthetic/receipt", predecessor: { ...identity.candidate, tag: "v0.6.9" } },
      pixel: lane.pixel,
    });
    for (const [name, entry] of Object.entries(receipt.lanes)) {
      if (name !== "deviceCloud" && name !== "deviceCloudCleanup") expect(entry).toEqual(before[name as keyof typeof before]);
    }
    expect(receipt.lanes.deviceCloud).toMatchObject({ status: "passed", attempts: 1 });
    expect(receipt.lanes.deviceCloudCleanup).toMatchObject({ status: "passed", attempts: 1 });
    const progress = parseDeviceCloudProgress(receipt.lanes.deviceCloud.evidence?.progress);
    expect(progress).toMatchObject({ cleanupRequired: false, journeys: { ipad: [{ attempt: 1 }, { attempt: 2 }] } });
    expect(receipt.lanes.deviceCloudCleanup.evidence?.epoch).toBe(progress.epoch);
    expect(externalCleanupCurrent(receipt, "deviceCloud")).toBe(true);
    receipt.lanes.deviceCloudCleanup.evidence!.epoch = "stale";
    expect(externalCleanupCurrent(receipt, "deviceCloud")).toBe(false);
  });
});

describe("mixed-vendor ownership and partial failure", () => {
  const vendors = { ipad: "browserstack", android: "browserstack" } as const;
  const sessionIds = { ipad: "a".repeat(40), android: "b".repeat(40) };

  test("identical session IDs at different vendors remain separate owned resources", async () => {
    const lane = harness({ vendors, sessionIds: { ...sessionIds, iphone: sessionIds.ipad } });
    const ended: string[] = [];
    const audited: string[] = [];
    const removed: string[] = [];
    const result = await runDeviceCloud({
      ...input(lane),
      runtime: {
        ...lane.runtime,
        endSession: async reference => { ended.push(`${reference.vendor}:${reference.sessionId}`); await lane.runtime.endSession(reference); },
        record: async (reference, remember) => { audited.push(`${reference.vendor}:${reference.sessionId}`); return lane.runtime.record(reference, remember); },
        removeRecord: async (reference, removal) => { expect(removal.artifacts.length).toBeGreaterThan(0); removed.push(reference.vendor); await removal.markDeleted(); },
      },
    });
    expect(result).toMatchObject({ vendor: "mixed", tunnelVersion: "per-target", audit: { testingbotRecords: 1, browserstackRecords: 2, lingeringSignedArtifacts: 0 } });
    expect(JSON.stringify(result)).not.toContain("https://bs-selenium-logs");
    expect(ended).toEqual([`testingbot:${sessionIds.ipad}`, `browserstack:${sessionIds.ipad}`, `browserstack:${sessionIds.android}`]);
    expect(audited).toEqual(ended);
    expect(removed).toEqual(["browserstack", "browserstack"]);
    const progress = parseDeviceCloudProgress(lane.checkpoints.at(-1));
    expect(progress.sessions).toEqual([sessionIds.ipad]);
    expect(progress.resources?.map(resource => [resource.vendor, resource.ended, resource.recordRemoved])).toEqual([
      ["testingbot", true, false], ["browserstack", true, true], ["browserstack", true, true],
    ]);
  });

  test("audits every vendor after a later target exhausts its fresh-session retry", async () => {
    const lane = harness({ vendors, sessionIds, failing: "verify android" });
    await expect(runDeviceCloud(input(lane))).rejects.toThrow("journey failed twice");
    for (const sessionId of ["session-iphone-0001", ...Object.values(sessionIds)]) expect(lane.effects).toContain(`audit ${sessionId}`);
    expect(lane.effects.filter(effect => effect.startsWith("verify "))).toEqual(["verify iphone", "verify ipad", "verify android", "verify android"]);
    for (const sessionId of Object.values(sessionIds)) expect(lane.effects).toContain(`remove ${sessionId}`);
  });

  test("one vendor's missing record does not skip the other vendor's record audit", async () => {
    const lane = harness({ vendors, sessionIds });
    const audited: string[] = [];
    await expect(runDeviceCloud({
      ...input(lane), runtime: {
        ...lane.runtime,
        record: async (reference, remember) => {
          audited.push(reference.vendor);
          if (reference.target === "iphone") throw new Error("primary record unavailable");
          return lane.runtime.record(reference, remember);
        },
      },
    })).rejects.toThrow("could not be audited");
    expect(audited).toEqual(["testingbot", "browserstack", "browserstack"]);
  });
  test.each(["reference", "duplicate-json", "vendor-error"])("audit diagnostics attach only fixed developer causes: %s", async kind => {
    const marker = "SYNTHETIC_VENDOR_BODY_NOT_FOR_DIAGNOSTICS";
    const raw = kind === "reference" ? JSON.stringify({ automation_session: {
      hashed_id: sessionIds.ipad, build_hashed_id: "c".repeat(40), status: "done",
      reason: `https://unreviewed.example/${sessionIds.ipad}/${marker}`,
    } }) : `{"automation_session":{"reason":"${marker}","reason":"clean"}}`;
    const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () =>
      new Response(raw, { headers: { "content-type": "application/json" } }), { preconnect: () => {} }));
    try {
      const lane = harness({ vendors, sessionIds });
      const api = new BrowserStackApi({ username: "synthetic-user", accessKey: "synthetic-key" });
      const error = await runDeviceCloud({ ...input(lane), runtime: {
        ...lane.runtime,
        record: async (reference, remember, inspect) => {
          if (reference.target !== "ipad") return lane.runtime.record(reference, remember, inspect);
          if (kind === "vendor-error") throw new Error(marker);
          return api.testRecord(reference.sessionId, remember, inspect);
        },
      } }).catch((error: unknown) => error);
      const findAudit = (error: unknown): Error | undefined => {
        if (error instanceof Error && error.message === "a device-cloud retained record could not be audited") return error;
        if (error instanceof AggregateError) for (const child of error.errors) {
          const found = findAudit(child);
          if (found !== undefined) return found;
        }
        return undefined;
      };
      const audit = findAudit(error);
      expect(audit).toBeDefined();
      if (kind === "reference") expect(audit?.cause).toBeInstanceOf(BrowserStackAuditFailure);
      else if (kind === "duplicate-json") expect(audit?.cause).toBeInstanceOf(RetainedVendorJsonError);
      else expect(audit?.cause).toBeUndefined();
      expect(String(audit?.cause)).not.toContain(marker);
      expect(audit?.cause instanceof Error ? audit.cause.stack : "").not.toContain(marker);
      expect(errorMessages(error)).not.toContain(marker);
      expect(JSON.stringify(lane.checkpoints)).not.toContain(marker);
      expect(JSON.stringify(parseDeviceCloudProgress(lane.checkpoints.at(-1)).results)).not.toContain(marker);
    } finally { mock.mockRestore(); }
  });

  test("the identical exact-16 window scan rejects BrowserStack retained text", async () => {
    const leaked = LINKS["instance-live"]!.control.slice(22, 38);
    const lane = harness({ vendors, sessionIds, record: sessionId => sessionId === sessionIds.ipad ? leaked : "clean" });
    const error = await runDeviceCloud(input(lane)).catch((error: unknown) => error);
    expect(errorMessages(error)).toContain("1 of 3 cloud test records");
    expect(pixelUnrestored(error)).toBe(true);
    expect(JSON.stringify(lane.checkpoints)).not.toContain(leaked);
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1)).results.audit).toMatchObject({ recordsExposingLinks: 1, browserstackRecords: 2 });
  });

  test.each([false, true])("compact default-relay capabilities do not confuse navigation origins with link windows (leak=%s)", async leak => {
    // Default-relay links are room.key, not origin-prefixed URLs. These strings remain synthetic.
    const capability = "SYNTHETIC_ROOM.SYNTHETIC_BROWSERSTACK_CAPABILITY_NOT_A_REAL_KEY";
    const navigation = JSON.stringify({ command: "navigate", url: `${identity.origin}/`, result: null });
    const lane = harness({ vendors, sessionIds, record: sessionId =>
      navigation + (leak && sessionId === sessionIds.ipad ? capability.slice(22, 38) : "") });
    const attempt = runDeviceCloud({ ...input(lane), runtime: { ...lane.runtime, launch: async () => capability } });
    if (leak) {
      const error = await attempt.catch((error: unknown) => error);
      expect(errorMessages(error)).toContain("1 of 3 cloud test records");
      expect(pixelUnrestored(error)).toBe(true);
      expect(parseDeviceCloudProgress(lane.checkpoints.at(-1)).resources?.find(resource => resource.target === "ipad")?.incident).toBe(true);
    } else expect(await attempt).toMatchObject({ passed: true, audit: { recordsExposingLinks: 0 } });
  });

  test("an allocation with no known session stays dirty and blocks the Pixel lease", async () => {
    const lane = harness();
    const error = await runDeviceCloud({
      ...input(lane), runtime: {
        ...lane.runtime,
        verify: async (_target, attempt) => {
          await attempt.allocating("testingbot");
          throw new Error("ambiguous primary session creation");
        },
      },
    }).catch((error: unknown) => error);
    expect(pixelUnrestored(error)).toBe(true);
    const progress = parseDeviceCloudProgress(lane.checkpoints.at(-1));
    expect(progress.cleanupRequired).toBe(true);
    expect(progress.resources).toEqual([{ vendor: "testingbot", target: "iphone", attempt: 1, ended: false, audited: false, recordRemoved: false }]);
    expect(lane.effects).not.toContain("workspace remove");
    expect(lane.effects.filter(effect => effect.startsWith("verify "))).toEqual([]);
  });

  test("failed BrowserStack deletion stays dirty and flags the lease", async () => {
    const lane = harness({ vendors, sessionIds });
    const error = await runDeviceCloud({
      ...input(lane), runtime: { ...lane.runtime, removeRecord: async () => { throw new Error("absence unverified"); } },
    }).catch((error: unknown) => error);
    expect(errorMessages(error)).toContain("BrowserStack record removal could not be verified");
    expect(errorMessages(error)).not.toContain("BrowserStack record removed under a retained-record incident");
    expect(pixelUnrestored(error)).toBe(true);
    expect(deviceCloudNeedsCleanup(lane.checkpoints.at(-1))).toBe(true);
    expect(lane.effects.filter(effect => effect === "tunnel stop")).toHaveLength(2);
    expect(lane.effects).not.toContain("fixture stop");
    expect(lane.effects).not.toContain("workspace remove");
  });

  async function interruptedDeletion() {
    const lane = harness({ vendors, sessionIds });
    await expect(runDeviceCloud({
      ...input(lane), runtime: { ...lane.runtime, removeRecord: async () => { throw new Error("not absent"); } },
    })).rejects.toThrow();
    return parseDeviceCloudProgress(structuredClone(lane.checkpoints.at(-1)));
  }

  test.each(["unchanged", "changed", "unavailable"] as const)("fresh cleanup audits only recoverable generations (%s)", async state => {
    const progress = await interruptedDeletion();
    expect(progress.resources?.filter(resource => resource.vendor === "browserstack").every(resource => resource.artifacts?.length === 1)).toBe(true);
    const recovery = harness({ vendors, sessionIds });
    const runtime: DeviceCloudRuntime = {
      ...recovery.runtime,
      fixtureSession: async () => state === "unavailable" ? undefined : {
        ...(await recovery.runtime.liveSession(LIVE_LABEL))!, instanceId: "instance-fixture", generation: state === "changed" ? 2 : 1,
      },
      removeRecord: async (reference, removal) => {
        expect(recovery.effects).toContain(`audit ${reference.sessionId}`);
        expect(removal.artifacts).toHaveLength(1);
        await recovery.runtime.removeRecord(reference, removal);
      },
    };
    const result = await cleanupDeviceCloud({ ...input(recovery, progress), runtime });
    expect(result).toMatchObject({ restored: true, unauditedRecordsDeleted: state === "unchanged" ? 0 : 2 });
    expect(JSON.stringify(result)).not.toContain("https://bs-selenium-logs");
    const final = parseDeviceCloudProgress(recovery.checkpoints.at(-1));
    for (const resource of final.resources!.filter(resource => resource.vendor === "browserstack")) {
      expect(resource.recordRemoved).toBe(true);
      expect(resource.artifacts).toEqual([]);
      expect(resource.audited).toBe(true); // Earlier successful audit remains a historical stage.
      expect(resource.unauditedDeletion === true).toBe(state !== "unchanged");
    }
  });

  test("fresh cleanup detects an exact-16 link hit, deletes for confidentiality, and persists an incident", async () => {
    const progress = await interruptedDeletion();
    const leaked = LINKS["instance-live"]!.control.slice(22, 38);
    const recovery = harness({ vendors, sessionIds, record: sessionId => sessionId === sessionIds.ipad ? leaked : "clean" });
    const runtime = {
      ...recovery.runtime,
      fixtureSession: async () => ({ ...(await recovery.runtime.liveSession(LIVE_LABEL))!, instanceId: "instance-fixture" }),
    };
    const error = await cleanupDeviceCloud({ ...input(recovery, progress), runtime }).catch((error: unknown) => error);
    expect(pixelUnrestored(error)).toBe(true);
    expect(String(error)).toContain("incident");
    expect(recovery.effects).toContain(`remove ${sessionIds.ipad}`);
    const final = parseDeviceCloudProgress(recovery.checkpoints.at(-1));
    expect(final.resources?.find(resource => resource.target === "ipad")).toMatchObject({ recordRemoved: true, incident: true, audited: true });
    expect(final.cleanupRequired).toBe(true);
    expect(JSON.stringify(recovery.checkpoints)).not.toContain(leaked);
    await expect(cleanupDeviceCloud({ ...input(harness(), final), runtime })).rejects.toThrow("incident");
  });

  test("a late signed artifact hit uses the same exact-16 scanner and cannot be restored", async () => {
    const progress = await interruptedDeletion();
    const leaked = LINKS["instance-live"]!.view.slice(22, 38);
    const recovery = harness({ vendors, sessionIds });
    const runtime: DeviceCloudRuntime = {
      ...recovery.runtime,
      fixtureSession: async () => ({ ...(await recovery.runtime.liveSession(LIVE_LABEL))!, instanceId: "instance-fixture" }),
      removeRecord: async (_reference, removal) => { await removal.inspect({ complete: true, text: leaked, video: false, screenshots: 0 }); await removal.markDeleted(); },
    };
    await expect(cleanupDeviceCloud({ ...input(recovery, progress), runtime })).rejects.toThrow("incident");
    expect(deviceCloudNeedsCleanup(recovery.checkpoints.at(-1))).toBe(true);
    expect(JSON.stringify(recovery.checkpoints)).not.toContain(leaked);
  });
  test("a post-DELETE absence retry preserves the audited/deleted stages and does not invent unaudited deletions", async () => {
    const lane = harness({ vendors, sessionIds });
    await expect(runDeviceCloud({
      ...input(lane), runtime: { ...lane.runtime, removeRecord: async (_reference, removal) => {
        await removal.markDeleted();
        throw new Error("signed artifacts still present");
      } },
    })).rejects.toThrow();
    const progress = parseDeviceCloudProgress(lane.checkpoints.at(-1));
    for (const resource of progress.resources!.filter(resource => resource.vendor === "browserstack")) {
      expect(resource).toMatchObject({ audited: true, recordDeleted: true, recordRemoved: false });
      expect(resource.unauditedDeletion).toBeUndefined();
    }
    expect(lane.effects.filter(effect => effect.startsWith("audit "))).toHaveLength(3);
    const recovery = harness({ vendors, sessionIds });
    const result = await cleanupDeviceCloud({ ...input(recovery, progress), runtime: {
      ...recovery.runtime,
      record: async () => { throw new Error("must not re-fetch a deleted API record"); },
    } });
    expect(result).toMatchObject({ restored: true, unauditedRecordsDeleted: 0 });
    expect(parseDeviceCloudProgress(recovery.checkpoints.at(-1)).resources?.filter(resource => resource.vendor === "browserstack").every(resource =>
      resource.audited && resource.recordDeleted && resource.recordRemoved)).toBe(true);
  });
  test("a post-DELETE body-audit failure remains an incident after a later successful absence retry", async () => {
    const progress = await interruptedDeletion();
    for (const resource of progress.resources!.filter(resource => resource.vendor === "browserstack")) resource.recordDeleted = true;
    const recovery = harness({ vendors, sessionIds });
    await expect(cleanupDeviceCloud({ ...input(recovery, progress), runtime: {
      ...recovery.runtime, removeRecord: async () => { throw new BrowserStackAuditFailure("retained body invalid"); },
    } })).rejects.toThrow("incident");
    const interrupted = parseDeviceCloudProgress(recovery.checkpoints.at(-1));
    expect(interrupted.resources?.filter(resource => resource.vendor === "browserstack").every(resource => resource.incident)).toBe(true);
    await expect(cleanupDeviceCloud(input(harness({ vendors, sessionIds }), interrupted))).rejects.toThrow("incident");
    expect(interrupted.cleanupRequired).toBe(true);
  });
  test.each(["end", "record", "local", "fixture"] as const)("release preserves recovery dependencies after %s failure", async step => {
    const progress = await interruptedDeletion();
    if (step === "end") progress.resources!.find(resource => resource.target === "ipad")!.ended = false;
    const recovery = harness({ vendors, sessionIds });
    const runtime: DeviceCloudRuntime = {
      ...recovery.runtime,
      endSession: async reference => { if (step === "end" && reference.target === "ipad") throw new Error("end failed"); await recovery.runtime.endSession(reference); },
      removeRecord: async (reference, removal) => { if (step === "record") throw new Error("record not absent"); await recovery.runtime.removeRecord(reference, removal); },
      tunnel: async (operation, epoch, vendor) => { if (step === "local" && vendor === "browserstack") throw new Error("Local still running"); await recovery.runtime.tunnel(operation, epoch, vendor); },
      fixture: async (operation, epoch) => { if (step === "fixture") throw new Error("fixture stop failed"); await recovery.runtime.fixture(operation, epoch); },
    };
    const error = await cleanupDeviceCloud({ ...input(recovery, progress), runtime }).catch((error: unknown) => error);
    expect(pixelUnrestored(error)).toBe(true);
    expect(recovery.effects).not.toContain("workspace remove");
    expect(recovery.effects).not.toContain("fixture stop");
    expect(deviceCloudNeedsCleanup(progress)).toBe(true);
  });
  test("a Local download failure owns no fallback tunnel and a later TestingBot-only attempt proceeds", async () => {
    const lane = harness();
    const runtime: DeviceCloudRuntime = { ...lane.runtime, verify: async (target, attempt) => {
      if (target === "ipad") await prepareBrowserStackLocal({
        binary: "/synthetic/cache/BrowserStackLocal", directory: "/synthetic/never-created", identifier: "omp-dc-bs-1234abcd",
      }, () => attempt.startingTunnel("browserstack"), async () => { throw new Error("Local download failed"); });
      return lane.runtime.verify(target, attempt);
    } };
    await expect(runDeviceCloud({ ...input(lane), runtime })).rejects.toThrow("Local download failed");
    const progress = parseDeviceCloudProgress(lane.checkpoints.at(-1));
    expect(progress.cleanupRequired).toBe(false);
    expect(progress.tunnels).toEqual(["testingbot"]);
    const next = harness();
    expect(await runDeviceCloud(input(next, progress))).toMatchObject({ passed: true, vendor: "TestingBot" });
  });
});

describe("device-cloud progress", () => {
  const valid = {
    lane: "deviceCloud", epoch: "0b8a2f64-3c1d-4e5f-9a7b-2c4d6e8f0a1b", binding: "9".repeat(64), phase: "iphone_verified",
    cleanupRequired: true, sessions: ["session-iphone-0001"], results: { iphone: { device: "iPad (9th generation)", os: "26.6", deliveredMs: 5_400 } },
  };

  test("accepts the exact shape", () => {
    expect(parseDeviceCloudProgress(valid).sessions).toEqual(["session-iphone-0001"]);
  });

  test("rejects BrowserStack iPhone ownership and evidence attributed to the wrong vendor", () => {
    const resources = [{ vendor: "browserstack", target: "iphone", sessionId: "a".repeat(40), ended: true, audited: false, recordRemoved: false }];
    expect(() => parseDeviceCloudProgress({ ...valid, sessions: [], resources, tunnels: ["browserstack"] })).toThrow();
    expect(() => parseDeviceCloudProgress({
      ...valid, sessions: [], phase: "ipad_verified", resources: [{ ...resources[0], target: "ipad" }], tunnels: ["browserstack"],
      results: { ipad: { vendor: "TestingBot", device: "iPad (10th generation)", os: "27.0" } },
    })).toThrow("vendor");
  });

  test.each([
    ["an unknown field", { ...valid, capabilityHint: "x" }],
    ["a secret-named observation", { ...valid, results: { iphone: { controlToken: "x" } } }],
    ["free text that could carry a link", { ...valid, results: { iphone: { note: "https://relay.example/join#room" } } }],
    ["a release that could reflect a credential", { ...valid, results: { iphone: { os: "SYNTHETICKEYREFLECTION7c4b1e9a" } } }],
    ["a device outside the pinned models", { ...valid, results: { iphone: { device: "Fake iphone" } } }],
    ["a push service other than Apple's", { ...valid, results: { iphone: { pushServiceHost: "push.example.net" } } }],
    ["an unknown result section", { ...valid, results: { desktop: { passed: true } } }],
    ["more sessions than targets", { ...valid, sessions: ["s-00000001", "s-00000002", "s-00000003", "s-00000004"] }],
    ["a restored attempt that still needs cleanup", { ...valid, phase: "restored" }],
  ])("refuses %s", (_name, progress) => {
    expect(() => parseDeviceCloudProgress(progress)).toThrow();
  });
});

describe("device allocation", () => {
  const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";
  const IPAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15";
  const GALAXY_UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
  // The shapes TestingBot returned for real allocations: iOS echoes the request, Android names its hardware.
  const ios = (deviceName: string) => ({ platformName: "iOS", browserName: "safari", deviceName, platformVersion: "26.6" });
  const galaxy = { platformName: "Android", browserName: "chrome", deviceName: "android-serial-placeholder", deviceModel: "SM-S942B", platformVersion: "16" };
  const hints = { uaFullVersion: "145.0.7632.159", platformVersion: "16.0.0", model: "SM-S942B" };
  const requested = {
    iphone: { name: "iPhone 17 Pro Max", version: "26.6" },
    ipad: { name: "iPad (9th generation)", version: "26.6" },
    android: { name: "Galaxy S26", version: "16.0" },
  } as const;

  async function parsed(report: { capabilities: Record<string, unknown>; userAgent: string; touchPoints: number; hints?: Record<string, unknown> }) {
    const browser = await new Function("navigator", `return ${ALLOCATION_REPORT_EXPRESSION}`)({
      userAgent: report.userAgent, maxTouchPoints: report.touchPoints,
      userAgentData: { getHighEntropyValues: async () => report.hints },
    }) as BrowserAllocationReport;
    return { capabilities: report.capabilities, browser };
  }

  test("records what each device reports about itself", async () => {
    expect(attestAllocation("testingbot", "iphone", requested.iphone, await parsed({ capabilities: ios("iPhone 17 Pro Max"), userAgent: IPHONE_UA, touchPoints: 5 })))
      .toEqual({ device: "iPhone 17 Pro Max", os: "26.6", browser: "safari", browserVersion: "26.6" });
    expect(attestAllocation("testingbot", "ipad", requested.ipad, await parsed({ capabilities: ios("iPad (9th generation)"), userAgent: IPAD_UA, touchPoints: 5 })))
      .toEqual({ device: "iPad (9th generation)", os: "26.6", browser: "safari", browserVersion: "26.6" });
    expect(attestAllocation("testingbot", "android", requested.android, await parsed({ capabilities: galaxy, userAgent: GALAXY_UA, touchPoints: 5, hints })))
      .toEqual({ device: "Galaxy S26", model: "SM-S942B", os: "16.0.0", browser: "chrome", browserVersion: "145.0.7632.159" });
  });

  test.each([
    ["an iPad allocated as the iPhone", "iphone", { capabilities: ios("iPhone 17 Pro Max"), userAgent: IPAD_UA, touchPoints: 5 }, "another kind of device"],
    ["a Mac without touch allocated as the iPad", "ipad", { capabilities: ios("iPad (9th generation)"), userAgent: IPAD_UA, touchPoints: 0 }, "another kind of device"],
    ["another model than the one requested", "iphone", { capabilities: ios("iPhone 16"), userAgent: IPHONE_UA, touchPoints: 5 }, "another model"],
    ["another iOS release", "iphone", { capabilities: ios("iPhone 17 Pro Max"), userAgent: IPHONE_UA.replace("Version/26.6", "Version/18.6"), touchPoints: 5 }, "another iOS release"],
    ["Chrome on the iPhone", "iphone", { capabilities: ios("iPhone 17 Pro Max"), userAgent: IPHONE_UA.replace("Version/26.6", "CriOS/145.0.7632.159"), touchPoints: 5 }, "not Safari"],
    ["a session on another platform", "iphone", { capabilities: galaxy, userAgent: IPHONE_UA, touchPoints: 5 }, "another platform"],
    ["Samsung Internet on the Galaxy", "android", { capabilities: galaxy, userAgent: GALAXY_UA.replace("Chrome/", "SamsungBrowser/29.0 Chrome/"), touchPoints: 5, hints }, "not Chrome"],
    ["a Galaxy without client hints", "android", { capabilities: galaxy, userAgent: GALAXY_UA, touchPoints: 5 }, "not Chrome"],
    ["another Android release", "android", { capabilities: galaxy, userAgent: GALAXY_UA, touchPoints: 5, hints: { ...hints, platformVersion: "15.0.0" } }, "another Android release"],
    ["a phone that is not a Galaxy", "android", { capabilities: galaxy, userAgent: GALAXY_UA, touchPoints: 5, hints: { ...hints, model: "Pixel 10" } }, "not a Galaxy"],
    ["a different Galaxy hardware model", "android", { capabilities: galaxy, userAgent: GALAXY_UA, touchPoints: 5, hints: { ...hints, model: "SM-S921B" } }, "canonical model"],
  ] as const)("refuses %s", async (_name, target, report, message) => {
    const observed = await parsed(report);
    expect(() => attestAllocation("testingbot", target, requested[target], observed)).toThrow(message);
  });
});
