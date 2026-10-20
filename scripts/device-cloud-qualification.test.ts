import { describe, expect, spyOn, test } from "bun:test";
import type { SessionMetadata } from "../packages/protocol/src/types.ts";
import {
  DEVICE_CLOUD_PROFILES,
  DEVICE_CLOUD_TARGETS,
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
import { DeviceCloudAvailabilityHold, deviceCloudHolds } from "./device-cloud-availability.ts";
import { createPixelLease, type PixelLease } from "./stable-qualification.ts";
import { pixelUnrestored } from "./restoration.ts";
import { TestingBotApi } from "./testingbot.ts";

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
  readonly hold?: DeviceCloudTarget;
  readonly auditFails?: boolean;
  /** What a target's device reports instead of its first pinned model. */
  readonly evidence?: Partial<Record<DeviceCloudTarget, Record<string, DeviceCloudObservation>>>;
} = {}): Harness {
  const effects: string[] = [];
  const checkpoints: Record<string, unknown>[] = [];
  let leased = false;
  let clock = 0;
  let published = false;
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
      if (attempt.session.cwdLabel !== LIVE_LABEL) throw new Error("journeys must drive the live session");
      if (target === options.hold) throw new DeviceCloudAvailabilityHold({
        kind: "device-cloud-availability", stage: "allocation", target, vendors: ["testingbot"],
        reason: "pinned-pool-busy", waitedMs: 600_000, epoch: attempt.epoch,
      });
      await attempt.created(`session-${target}-0001`);
      effect(`verify ${target}`);
      if (options.generationChangesAt === target) generations[options.generationChanges ?? "fixture"] += 1;
      return options.evidence?.[target] ?? {
        device: DEVICE_CLOUD_PROFILES[target].models[0]!, os: "26.6", viewReadOnly: true, controlWritable: true, sinkFindings: 0,
      };
    },
    endSession: async sessionId => {
      effect(`end ${sessionId}`);
    },
    record: async sessionId => {
      effect(`audit ${sessionId}`);
      if (options.auditFails) throw new Error("vendor audit failed");
      return {
        complete: true,
        text: options.record?.(sessionId) ?? JSON.stringify({ state: "COMPLETE", steps: `POST /url for ${sessionId}` }),
        video: options.media === true,
        screenshots: 0,
      };
    },
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
    expect(lane.effects.slice(-6)).toEqual([
      "end session-iphone-0001", "end session-ipad-0001", "end session-android-0001",
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
          created: async sessionId => {
            active.add(sessionId);
            maximumActive = Math.max(maximumActive, active.size);
            await attempt.created(sessionId);
          },
        });
      },
      endSession: async sessionId => {
        await lane.runtime.endSession(sessionId);
        active.delete(sessionId);
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
    expect(await failure(runDeviceCloud(input(lane)))).toContain("verify ipad failed");
    expect(lane.effects.filter(effect => effect.endsWith("(unleased)"))).toEqual([]);
    expect(lane.effects.slice(-5)).toEqual([
      "end session-iphone-0001", "end session-ipad-0001", "tunnel stop", "fixture stop", "workspace remove",
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
    expect(message).toContain("1 of 3 TestingBot test records contain a live View or Control link");
    const saved = JSON.stringify(lane.checkpoints);
    for (const text of [message, saved]) expect(text).not.toContain("SYNTHETIC-CLOUD-");
    expect(parseDeviceCloudProgress(lane.checkpoints.at(-1)).results.audit).toEqual({ records: 3, recordsExposingLinks: 1, recordsWithMedia: 0 });
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
      const message = await failure(runDeviceCloud({ ...input(lane), runtime: { ...lane.runtime, record: sessionId => api.testRecord(sessionId) } }));
      expect(message).toContain("3 of 3 TestingBot test records contain a live View or Control link");
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
    expect(lane.effects).toContain("workspace remove");
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
      "end session-iphone-0001", "end session-ipad-0001", "tunnel stop", "fixture stop", "workspace remove",
    ]);
  });

  test("a release that cannot finish leaves the attempt dirty, and cleanup retries every step", async () => {
    const run = harness({ failing: "tunnel stop" });
    expect(await failure(runDeviceCloud(input(run)))).toBe("device-cloud cleanup failed: tunnel");
    const progress = run.checkpoints.at(-1);
    expect(parseDeviceCloudProgress(progress)).toMatchObject({ phase: "evidence_complete", cleanupRequired: true });

    const cleanup = harness({ failing: "tunnel stop" });
    expect(await failure(cleanupDeviceCloud(input(cleanup, progress)))).toBe("device-cloud cleanup failed: tunnel");
    expect(cleanup.effects.slice(-2)).toEqual(["fixture stop", "workspace remove"]);
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

describe("device-cloud progress", () => {
  const valid = {
    lane: "deviceCloud", epoch: "0b8a2f64-3c1d-4e5f-9a7b-2c4d6e8f0a1b", binding: "9".repeat(64), phase: "iphone_verified",
    cleanupRequired: true, sessions: ["session-iphone-0001"], results: { iphone: { device: "iPad (9th generation)", os: "26.6", deliveredMs: 5_400 } },
  };

  test("accepts the exact shape", () => {
    expect(parseDeviceCloudProgress(valid).sessions).toEqual(["session-iphone-0001"]);
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
    expect(attestAllocation("iphone", requested.iphone, await parsed({ capabilities: ios("iPhone 17 Pro Max"), userAgent: IPHONE_UA, touchPoints: 5 })))
      .toEqual({ device: "iPhone 17 Pro Max", os: "26.6", browser: "safari", browserVersion: "26.6" });
    expect(attestAllocation("ipad", requested.ipad, await parsed({ capabilities: ios("iPad (9th generation)"), userAgent: IPAD_UA, touchPoints: 5 })))
      .toEqual({ device: "iPad (9th generation)", os: "26.6", browser: "safari", browserVersion: "26.6" });
    expect(attestAllocation("android", requested.android, await parsed({ capabilities: galaxy, userAgent: GALAXY_UA, touchPoints: 5, hints })))
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
    expect(() => attestAllocation(target, requested[target], observed)).toThrow(message);
  });
});
