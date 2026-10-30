import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupWindows, runWindows, verifyWindowsDoctor, windowsCampaignLabel, windowsFailure, windowsNeedsCleanup, assertWindowsPins } from "./windows-stable-qualification.ts";
import pins from "./windows-qualification-pins.json";
import type { WindowsContext, WindowsFirewall, WindowsGuestAction, WindowsIdentity, WindowsInstance, WindowsPrincipal, WindowsRuntime, WindowsTransportProbe } from "./windows-stable-qualification.ts";
import { command as windowsCommand, reconnectWindowsTransport, verifyWindowsStaleLaunch, windowsPixelForeground, windowsPixelLauncher, waitForStableWindowsTransport } from "./windows-qualification-runtime.ts";
import { QualificationFailure, privateQualificationFailureDiagnostic, normalizeQualificationFailures, qualificationRetryEligible } from "./qualification-failure.ts";
import * as windowsRuntime from "./windows-qualification-runtime.ts";
import { firewallEligibility } from "./vultr-target.ts";
import { createPixelLease, parseQualificationPins } from "./stable-qualification.ts";
import { pixelUnrestored } from "./restoration.ts";

const epoch = "11111111-1111-4111-8111-111111111111";
const label = windowsCampaignLabel(epoch);
const identity: WindowsIdentity = {
  tag: "v0.5.3",
  candidate: { tag: "v0.5.3", sourceCommit: "a".repeat(40), archiveSha256: "b".repeat(64), archivePath: "/synthetic/candidate.tar" },
  predecessor: { tag: "v0.5.2", sourceCommit: "c".repeat(40), archiveSha256: "d".repeat(64), archivePath: "/synthetic/predecessor.tar" },
  omp: parseQualificationPins(await readFile(new URL("../UPSTREAM.lock.json", import.meta.url), "utf8")),
};
const taggedDoctorChecks = { assets: true, compatibility: true, config: true, daemon: true, discoveryReadable: true,
  funnelDisabled: true, listenerLoopbackOnly: true, loopbackTrustSound: true, permissions: true, relay: true,
  serveMapping: true, serviceActive: true, serviceInstalled: true, tailscaleConnected: true,
  identityAllowed: false, pwa: false, sessionHealth: false, securityHeaders: true };
const doctorState = { loopbackOnly: true, logonTrigger: true, interactivePrincipal: true, logonTriggerScoped: true };
test("an authenticated transport error resets both the stability count and window", async () => {
  let now = 0; let failed = false;
  const uninterrupted: number[] = [];
  const result = await waitForStableWindowsTransport(async () => {
    if (!failed && uninterrupted.length === 1) {
      failed = true; uninterrupted.length = 0;
      throw windowsFailure("connection_reset", "connection", "read_only", { transportFailure: true });
    }
    uninterrupted.push(now);
    return { windowsBuild: 26100 };
  }, { now: () => now, sleep: async ms => { now += ms; } }, 180_000);
  expect(result.transportStabilitySamples).toBe(uninterrupted.length);
  expect(result.transportStabilitySamples).toBeGreaterThanOrEqual(3);
  expect(result.transportStabilityDurationMs).toBe(uninterrupted.at(-1)! - uninterrupted[0]!);
  expect(result.transportStabilityDurationMs).toBeGreaterThanOrEqual(60_000);
});
test("transport instability cannot extend the allocation deadline", async () => {
  let now = 0;
  await expect(waitForStableWindowsTransport(async () => {
    if (now >= 75_000) throw new Error("probe started after allocation deadline");
    throw windowsFailure("connection_timeout", "connection", "read_only", { transportFailure: true });
  }, { now: () => now, sleep: async ms => { now += ms; } }, 75_000)).rejects.toThrow("deadline_exceeded");
  expect(now).toBe(75_000);
});
test("guest rejection is not treated as transient transport instability", async () => {
  let probes = 0; let elapsed = 0;
  const failure = new Error("provider guest shape mismatch");
  await expect(waitForStableWindowsTransport(async () => { probes += 1; throw failure; },
    { now: () => elapsed, sleep: async ms => { elapsed += ms; } }, 75_000)).rejects.toBe(failure);
  expect(probes).toBe(1);
  expect(elapsed).toBe(0);
});
test("slow first authenticated probes get 180 seconds without weakening the stability window", async () => {
  let now = 0;
  const limits: number[] = [];
  const result = await waitForStableWindowsTransport(async timeoutMs => {
    limits.push(timeoutMs); now += 100_000;
    return { windowsBuild: 26100 };
  }, { now: () => now, sleep: async ms => { now += ms; } }, 12 * 60_000);
  expect(limits).toEqual([180_000, 180_000, 180_000]);
  expect(result).toMatchObject({ transportStabilitySamples: 3, transportStabilityDurationMs: 260_000 });
  expect(now).toBeLessThan(12 * 60_000);
});
test("a probe is capped by remaining admission time and a late success cannot pass", async () => {
  let now = 0;
  const limits: number[] = [];
  await expect(waitForStableWindowsTransport(async timeoutMs => {
    limits.push(timeoutMs); now += timeoutMs;
    return { windowsBuild: 26100 };
  }, { now: () => now, sleep: async ms => { now += ms; } }, 90_000)).rejects.toThrow("deadline_exceeded");
  expect(limits).toEqual([90_000]);
  expect(now).toBe(90_000);
});
test("496 R2 stability uses one positive clock snapshot before dispatch, never a clamped expired budget", async () => {
  let now = -60;
  const dispatched: number[][] = [];
  await expect(waitForStableWindowsTransport(async budget => { dispatched.push([now, budget]); return {}; },
    { now: () => (now += 60), sleep: async ms => { now += ms; } }, 100)).rejects.toThrow("deadline_exceeded");
  expect(dispatched).toEqual([[60, 40]]);
});
test("transport command checkpoints first response before exit without copying stream contents", async () => {
  const probes: WindowsTransportProbe[] = [];
  const script = `process.stderr.write("synthetic-private-output-never-real\\n" + "x".repeat(200) + "\\n");
    process.stderr.write("WINRM_FIRST_");
    setTimeout(() => { process.stderr.write("RESPONSE " + Date.now() + "\\n"); process.stdout.write("bounded-result"); }, 10);`;
  expect(await windowsCommand([process.execPath, "-e", script], { timeoutMs: 3_000,
    transportProbe: async probe => { await Bun.sleep(1); probes.push({ ...probe }); },
  })).toBe("bounded-result");
  expect(probes).toHaveLength(3);
  expect(probes[0]).toMatchObject({ firstResponseLatencyMs: null, signalAt: null, exitedAt: null, exitCode: null });
  expect(probes[1]!.firstResponseLatencyMs).toBeGreaterThanOrEqual(0);
  expect(probes[1]!.exitedAt).toBeNull();
  expect(probes[2]!.exitCode).toBe(0);
  expect(probes[2]!.signalAt).toBeNull();
  expect(probes[2]!.exitedAt!).toBeGreaterThanOrEqual(probes[0]!.startedAt + probes[2]!.firstResponseLatencyMs!);
  expect(JSON.stringify(probes)).not.toContain("synthetic-private");
  expect(Object.keys(probes[2]!).sort()).toEqual(["exitCode", "exitedAt", "firstResponseLatencyMs", "signalAt", "startedAt", "timeoutMs"]);
});
test("a timed-out transport command persists signal and exit before its failure escapes", async () => {
  const probes: WindowsTransportProbe[] = [];
  await expect(windowsCommand([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    timeoutMs: 50, transportProbe: async probe => { probes.push({ ...probe }); },
  })).rejects.toThrow("output withheld");
  expect(probes).toHaveLength(3);
  const last = probes.at(-1)!;
  expect(last.signalAt).toBeGreaterThanOrEqual(last.startedAt);
  expect(last.exitedAt).toBeGreaterThanOrEqual(last.signalAt!);
  expect(last.exitCode).not.toBe(0);
  expect(last.firstResponseLatencyMs).toBeNull();
});
test("transport checkpoint failures refuse spawn or success instead of losing diagnostics silently", async () => {
  const failure = new Error("synthetic checkpoint failure");
  await expect(windowsCommand(["synthetic-missing-command"], {
    transportProbe: async () => { throw failure; },
  })).rejects.toBe(failure);
  let checkpoints = 0;
  await expect(windowsCommand([process.execPath, "-e", ""], {
    transportProbe: async () => { if (++checkpoints === 2) throw failure; },
  })).rejects.toBe(failure);
  expect(checkpoints).toBe(2);
});
test("Pixel restoration selects the installed app behind a non-exported Chrome activity", () => {
  const component = "com.android.chrome/org.chromium.chrome.browser.webapps.SameTaskWebApkActivity";
  const activities = [
    "* Task{a #10 type=standard A=101:com.android.chrome}",
    "ActivityRecord{a u0 com.android.chrome/com.google.android.apps.chrome.Main t10}",
    "* Task{b #20 type=standard A=102:org.chromium.webapk.fixture}",
    `ActivityRecord{b u0 ${component} t20}`,
  ].join("\n");
  expect(windowsPixelLauncher(activities, component)).toEqual({ packageName: "org.chromium.webapk.fixture", category: "android.intent.category.LAUNCHER" });
  expect(() => windowsPixelLauncher(activities + `\n* Task{c #21 A=103:org.chromium.webapk.other}\nActivityRecord{c u0 ${component} t21}`, component)).toThrow("ambiguous");
});
test("Pixel restoration returns to the home screen the Pixel started on", () => {
  // A home task has no affinity, so Android prints its intent component; its app answers HOME, not LAUNCHER.
  const component = "com.google.android.apps.nexuslauncher/.NexusLauncherActivity";
  const activities = [
    "* Task{d #2 type=home I=com.google.android.apps.nexuslauncher/.NexusLauncherActivity U=0 rootTaskId=1 visible=true mode=fullscreen sz=2}",
    `ActivityRecord{d u0 ${component} t2}`,
    "rootOfTask=true task=Task{d #2 type=home I=com.google.android.apps.nexuslauncher/.NexusLauncherActivity}",
    "* Task{e #30 type=standard A=101:com.android.chrome}",
    "ActivityRecord{e u0 com.android.chrome/com.google.android.apps.chrome.Main t30}",
  ].join("\n");
  expect(windowsPixelLauncher(activities, component)).toEqual({ packageName: "com.google.android.apps.nexuslauncher", category: "android.intent.category.HOME" });
});
test("Pixel restoration treats a screensaver as the task beneath it", () => {
  // Line shapes from a Pixel that dreamed while charging; the dream task's affinity parses as "android".
  const dream = [
    "Display #0 (activities from top to bottom):",
    "  * Task{f1 #21837 type=dream U=0 visible=true visibleRequested=true mode=fullscreen translucent=false sz=1}",
    "    * Task{f2 #21839 type=dream A=10258:android:com.android.systemui/dream U=0 rootTaskId=21837 visible=true mode=fullscreen sz=1}",
    "      topResumedActivity=ActivityRecord{f3 u0 com.android.systemui/android.service.dreams.DreamActivity t21839}",
    "      * Hist  #0: ActivityRecord{f3 u0 com.android.systemui/android.service.dreams.DreamActivity t21839}",
  ];
  const home = [
    "  * Task{d1 #1 type=home U=0 visible=false visibleRequested=false mode=fullscreen translucent=true sz=1}",
    "    * Task{d2 #2 type=home I=com.google.android.apps.nexuslauncher/.NexusLauncherActivity U=0 rootTaskId=1 visible=false mode=fullscreen sz=2}",
    "      mLastPausedActivity: ActivityRecord{d3 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t2}",
    "      * Hist  #1: ActivityRecord{d3 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t2}",
  ];
  const overHome = [...dream, ...home].join("\n");
  const launcher = "com.google.android.apps.nexuslauncher/.NexusLauncherActivity";
  expect(windowsPixelForeground(overHome)).toBe(launcher);
  expect(windowsPixelLauncher(overHome, launcher)).toEqual({ packageName: "com.google.android.apps.nexuslauncher", category: "android.intent.category.HOME" });
  const webApk = "com.android.chrome/org.chromium.chrome.browser.webapps.SameTaskWebApkActivity";
  const overApp = [...dream, "  * Task{g1 #40 type=standard A=10123:org.chromium.webapk.fixture U=0 visible=false mode=fullscreen sz=1}",
    `      * Hist  #0: ActivityRecord{g2 u0 ${webApk} t40}`, ...home].join("\n");
  expect(windowsPixelForeground(overApp)).toBe(webApk);
  expect(windowsPixelLauncher(overApp, webApk)).toEqual({ packageName: "org.chromium.webapk.fixture", category: "android.intent.category.LAUNCHER" });
  // Awake, asleep and dozing Pixels keep the resumed activity, which stays the launcher's while dozing.
  expect(windowsPixelForeground([home[0], home[1], `      topResumedActivity=ActivityRecord{d3 u0 ${launcher} t2}`, home[3]].join("\n"))).toBe(launcher);
});
function fixture(options: { development?: boolean; fail?: WindowsGuestAction; productFailure?: boolean; listener?: boolean; neverStarts?: boolean; vaultFails?: boolean; lostCreate?: boolean; protected?: boolean; unlabelled?: boolean; stale?: number } = {}) {
  let now = 1_800_000_000_000;
  let progress: unknown;
  const events: string[] = [];
  let instances: WindowsInstance[] = [];
  let firewalls: WindowsFirewall[] = [];
  let standardUninstalled = false;
  const runtime: WindowsRuntime = {
    development: options.development === true,
    environment: options.protected ? { OMP_QUAL_PROTECTED_INSTANCES: "synthetic-owned" } : {},
    now: () => now, sleep: async ms => { now += ms; }, uuid: () => epoch,
    admit: async () => ({ admitted: true, protectionVerified: true, toolchainVerified: true }),
    provider: {
      instances: async () => instances,
      firewalls: async () => firewalls,
      instance: async id => instances.find(item => item.id === id),
      firewall: async id => firewalls.find(item => item.id === id),
      createFirewall: async description => { firewalls = [{ id: "synthetic-firewall", description }]; events.push("firewallCreated"); return firewalls[0]!; },
      configureFirewall: async () => { events.push("firewallConfigured"); },
      createInstance: async requested => {
        instances = [{ id: "synthetic-owned", label: options.unlabelled ? "unrelated" : requested, os_id: 2514, region: "ewr", plan: pins.plan, main_ip: "192.0.2.1", default_password: "synthetic-never-real" }];
        events.push("instanceCreated");
        if (options.lostCreate) throw new Error("response lost after provider creation");
        return instances[0]!;
      },
      destroyInstance: async id => { events.push("instanceDestroyed"); instances = instances.filter(item => item.id !== id); },
      destroyFirewall: async id => { events.push("firewallDestroyed"); firewalls = firewalls.filter(item => item.id !== id); },
    },
    saveAccess: async () => { events.push("vaultSaved"); if (options.vaultFails) throw new Error("private disk full"); },
    removeAccess: async () => { events.push("vaultRemoved"); },
    guest: async (_context: WindowsContext, action: WindowsGuestAction, principal?: WindowsPrincipal) => {
      now += 1_000; events.push(principal === "standard" ? `${action}@standard` : action);
      if (options.fail === action) throw options.productFailure
        ? windowsFailure("assertion_failed", "output", "confirmed") : new Error("guest operation failed");
      if (action === "uninstall" && principal === "standard") standardUninstalled = true;
      return {
        ready: !options.neverStarts, taskPresent: !(action === "state" && standardUninstalled), taskRunning: false, gatewayProcesses: 0, listeners: options.listener ? 1 : 0,
        configPreserved: true, readinessPreserved: true, readinessChanged: true, checks: taggedDoctorChecks, ...doctorState,
        namedPipe: true, generation: 1, viewStatus: 200, controlStatus: 200, staleViewStatus: options.stale ?? 409, staleControlStatus: 409, noStore: true,
        revoked: true, historySelected: true, restored: true, uninstalled: true,
        transportStabilitySamples: 3, transportStabilityDurationMs: 60_000,
        prepared: true, released: true, taggedNode: true, tunMode: true, funnelOff: true, standardUserNonAdmin: true, standardUserNoSecurityPrivilege: true,
      };
    },
    rdp: async (_context: WindowsContext, principal?: WindowsPrincipal) => { events.push(principal === "standard" ? "rdp@standard" : "rdp"); },
    pixel: async () => { events.push("physicalPixel"); return { pixelIdentityAccepted: true, viewReadOnly: true, controlWritable: true, promptAccepted: true, returnedToDirectory: true }; },
    restorePixel: async () => { events.push("pixelRestored"); },
    deleteTailnet: async () => { events.push("tailnetDeleted"); },
  };
  // Installation readiness is not the automatic post-reboot readiness sample.
  const originalGuest = runtime.guest;
  if (options.neverStarts) runtime.guest = async (context, action, principal) => ({ ...await originalGuest(context, action, principal), ready: action !== "ready", note: "synthetic-guest-string" });
  const checkpoint = async (next: Record<string, unknown>) => { progress = structuredClone(next); events.push(`checkpoint:${String(next.phase)}`); };
  const pixel = async <T>(_owner: string, action: () => Promise<T>) => { events.push("pixelLease"); return action(); };
  return { runtime, events, checkpoint, pixel, get progress() { return progress; }, get instances() { return instances; }, get firewalls() { return firewalls; },
    run: () => runWindows({ identity, progress: undefined, checkpoint, pixel, runtime }),
    clean: () => cleanupWindows({ identity, progress, checkpoint, pixel, runtime }) };
}

test.each(["phase", "cleanup", "retirement"] as const)("509 council Windows %s reconstruction preserves the private cause", async stage => {
  const f = fixture(), cause = new Error("synthetic private Windows cause");
  if (stage === "phase") {
    f.runtime.guest = async () => { throw new QualificationFailure({ id: 120, lane: "windows", step: "output",
      class: "harness", reason: "unclassified_failure", operation: "read_only", elapsedMs: 0, observations: {} }, { cause }); };
    const error = await f.run().catch(error => error);
    expect(privateQualificationFailureDiagnostic(error).map(entry => entry.message)).toContain(cause.message);
  } else {
    await f.run();
    if (stage === "cleanup") f.runtime.restorePixel = async () => { throw cause; };
    else f.runtime.removeAccess = async () => { throw cause; };
    const error = await f.clean().catch(error => error);
    expect(privateQualificationFailureDiagnostic(error).map(entry => entry.message)).toContain(cause.message);
  }
});

test.each(["phase", "expiry", "guest-containment", "poll-expiry"] as const)(
  "509 round2 Windows ordinary %s error stays privately reachable", async stage => {
    const f = fixture(), raw = new Error(`synthetic private ordinary ${stage} failure`);
    let id = 200;
    const execution = { signal: new AbortController().signal, deadline: performance.now() + 60_000, nextFailureId: () => ++id };
    if (stage === "phase" || stage === "expiry") {
      f.runtime.guest = async () => { if (stage === "expiry") execution.deadline = 0; throw raw; };
      const error = await runWindows({ identity, progress: undefined, runtime: f.runtime, checkpoint: f.checkpoint, pixel: f.pixel, execution }).catch(error => error);
      expect(privateQualificationFailureDiagnostic(error).map(entry => entry.message)).toContain(raw.message);
      expect(normalizeQualificationFailures(error).some(item => item.reason === (stage === "expiry" ? "deadline_exceeded" : "unclassified_failure"))).toBe(true);
    } else {
      await f.run();
      if (stage === "guest-containment") {
        f.runtime.guest = async () => { throw raw; };
        f.runtime.provider.destroyInstance = async () => { throw new Error("synthetic provider containment failure"); };
      } else {
        f.runtime.provider.destroyInstance = async () => {};
        const instance = f.runtime.provider.instance;
        let calls = 0;
        f.runtime.provider.instance = async (...args) => {
          if (++calls === 3) { execution.deadline = 0; throw raw; }
          return instance(...args);
        };
      }
      const error = await cleanupWindows({ identity, progress: f.progress, runtime: f.runtime, checkpoint: f.checkpoint, pixel: f.pixel, execution }).catch(error => error);
      expect(privateQualificationFailureDiagnostic(error).map(entry => entry.message)).toContain(raw.message);
      expect(normalizeQualificationFailures(error).some(item => item.reason === "containment_unproven" || item.reason === "deadline_exceeded")).toBe(true);
    }
  });

describe("Windows qualification ownership and failure paths", () => {
  test("503 cancelled Windows Pixel execution restores before failure classification without poisoning dependents", async () => {
    const f = fixture();
    const controller = new AbortController();
    let id = 500;
    const execution = { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => ++id };
    const pixel = createPixelLease(() => {}, execution.nextFailureId);
    f.runtime.restorePixel = async context => {
      await context.beforeEffect();
      context.assertEffect();
      expect(context.execution?.signal.aborted).toBe(false);
      f.events.push("pixelRestored");
    };
    f.runtime.pixel = async context => {
      controller.abort(new Error("synthetic smoke cancellation"));
      try { await f.runtime.restorePixel(windowsRuntime.windowsPixelRestorationContext(context)); }
      catch (error) { throw Object.assign(error as Error, { pixelUnrestored: true }); }
      f.events.push("restoredBeforeClassification");
      throw windowsFailure("deadline_exceeded", "pixel_verified", "unknown", {}, execution);
    };
    const error = await runWindows({ identity, progress: undefined, runtime: f.runtime, checkpoint: f.checkpoint, pixel, execution }).catch(error => error);
    expect(f.events.indexOf("pixelRestored")).toBeLessThan(f.events.indexOf("restoredBeforeClassification"));
    expect(f.events.indexOf("restoredBeforeClassification")).toBeGreaterThan(-1);
    expect(pixelUnrestored(error)).toBe(false);
    expect(normalizeQualificationFailures(error).some(failure => failure.reason === "deadline_exceeded")).toBe(true);
    expect(await pixel("android", async () => "admitted")).toBe("admitted");
  });
  test("503 Windows cleanup transport failures retain containment identity and stay sticky after recovery", async () => {
    const f = fixture();
    await f.run();
    const deleteTailnet = f.runtime.deleteTailnet;
    const transport = windowsFailure("retryable_service_failure", "connection", "read_only", { httpStatus: 503 });
    f.runtime.deleteTailnet = async () => { throw transport; };
    const error = await f.clean().catch(error => error);
    const failures = normalizeQualificationFailures(error);
    expect(failures).toMatchObject([{ lane: "windowsCleanup", step: "containment", reason: "containment_unproven",
      class: "harness", operation: "unknown", observations: { cleanupVerified: false } }]);
    expect(error.errors[0].cause).toBe(transport);
    expect(qualificationRetryEligible({ failures, timings: { attemptMs: 1, cleanupMs: 1 },
      containment: { proven: true, cleanupComplete: true, unresolvedMutation: false } }, true)).toBe(false);
    expect(f.progress).toMatchObject({ cleanupRequired: true, cleanupFailed: true });
    f.runtime.deleteTailnet = deleteTailnet;
    expect(await f.clean()).toMatchObject({ cleanupFailed: true, vaultRemoved: true });
    expect(f.progress).toMatchObject({ cleanupRequired: false, cleanupFailed: true });
    expect(f.instances).toEqual([]);
    expect(f.firewalls).toEqual([]);
  });
  test("council498r1 Windows Pixel projection preserves poison origins through later cleanup", async () => {
    const f = fixture();
    let id = 70;
    const pixel = createPixelLease(() => {}, () => ++id);
    const root = Object.assign(windowsFailure("unclassified_failure", "pixel_verified", "unknown", {},
      { signal: new AbortController().signal, deadline: performance.now() + 60_000, nextFailureId: () => ++id }), { pixelUnrestored: true });
    f.runtime.pixel = async () => { throw root; };
    const primary = await runWindows({ identity, progress: undefined, runtime: f.runtime, checkpoint: f.checkpoint, pixel,
      execution: { signal: new AbortController().signal, deadline: performance.now() + 60_000, nextFailureId: () => ++id } }).catch(error => error);
    const dependent = await pixel("android", async () => { throw new Error("poisoned measurement must not run"); }).catch(error => error);
    const failures = normalizeQualificationFailures(new AggregateError([primary, dependent]));
    expect(pixelUnrestored(primary)).toBe(true);
    expect(failures.some(item => item.id === root.evidence.id && item.lane === "windows")).toBe(true);
    expect(failures.some(item => item.class === "collateral" && item.originIds.includes(root.evidence.id))).toBe(true);
    expect(f.instances).toEqual([]);
  });
  test("499 R1 automatic cleanup inherits its in-process development Pixel lease for restoration", async () => {
    const root = await mkdtemp(join(tmpdir(), "windows-pixel-"));
    const f = fixture({ development: true });
    let pending = false, restorations = 0;
    const pixel = windowsRuntime.createWindowsDevelopmentPixelLease({
      lock: join(root, "lease"), epoch: () => epoch, recoverExitedOwner: false,
      recoveryPending: async () => pending,
      clock: { now: () => 0, sleep: async () => { throw new Error("same owner must not queue for its retained lease"); } },
    });
    f.runtime.restorePixel = async context => {
      if (++restorations === 1) throw Object.assign(new Error("synthetic first restoration failure"), { pixelUnrestored: true });
      expect(context.execution?.signal.aborted).toBe(false);
      expect(context.execution!.deadline).toBeGreaterThan(performance.now());
      pending = false;
    };
    f.runtime.pixel = async context => { pending = true; await f.runtime.restorePixel(context); return {}; };
    try {
      await expect(runWindows({ identity, progress: undefined, runtime: f.runtime, checkpoint: f.checkpoint, pixel })).rejects.toThrow();
      expect(restorations).toBe(2);
      expect(pending).toBe(false);
      expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
      expect(windowsNeedsCleanup(f.progress)).toBe(false);
      expect(await Bun.file(join(root, "lease", "owner")).exists()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test.each(["other-process", "same-pid-without-claim"] as const)("499 R1 development cleanup refuses %s lease custody within its execution budget", async kind => {
    const root = await mkdtemp(join(tmpdir(), "windows-pixel-foreign-")), lock = join(root, "lease");
    await mkdir(lock);
    const child = kind === "other-process" ? Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" }) : undefined;
    const owner = `WindowsLane 2026-10-26T00:00:00.000Z ${epoch} ${child?.pid ?? process.pid}\n`;
    await writeFile(join(lock, "owner"), owner);
    const waits: number[] = []; let actions = 0;
    const pixel = windowsRuntime.createWindowsDevelopmentPixelLease({
      lock, epoch: () => epoch, recoverExitedOwner: true, recoveryPending: async () => false,
      clock: { now: () => 0, sleep: async ms => { waits.push(ms); throw new Error("synthetic blocked lease"); } },
    });
    try {
      await expect(pixel("windows-cleanup", async () => { actions += 1; },
        { signal: new AbortController().signal, deadline: performance.now() + 1_000, nextFailureId: () => 1 })).rejects.toThrow("synthetic blocked lease");
      expect(actions).toBe(0); expect(waits).toHaveLength(1); expect(waits[0]).toBeLessThanOrEqual(1_000);
      expect(await readFile(join(lock, "owner"), "utf8")).toBe(owner);
    } finally {
      child?.kill(); if (child) await child.exited;
      await rm(root, { recursive: true, force: true });
    }
  });
  test("499 R1 restored development Pixel does not release a changed lease owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "windows-pixel-changed-")), lock = join(root, "lease");
    const pixel = windowsRuntime.createWindowsDevelopmentPixelLease({
      lock, epoch: () => epoch, recoverExitedOwner: false, recoveryPending: async () => false,
    });
    try {
      const owner = "synthetic foreign owner\n";
      await expect(pixel("windows", async () => { await writeFile(join(lock, "owner"), owner); })).rejects.toThrow("ownership_changed");
      expect(await readFile(join(lock, "owner"), "utf8")).toBe(owner);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("499 R1 in-process Pixel cleanup cannot overlap its still-active action", async () => {
    const root = await mkdtemp(join(tmpdir(), "windows-pixel-active-")), lock = join(root, "lease");
    const pixel = windowsRuntime.createWindowsDevelopmentPixelLease({
      lock, epoch: () => epoch, recoverExitedOwner: false, recoveryPending: async () => false,
    });
    const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    const first = pixel("windows", async () => { entered.resolve(); await finish.promise; });
    try {
      await entered.promise;
      let cleanupEntered = false;
      await expect(pixel("windows-cleanup", async () => { cleanupEntered = true; })).rejects.toThrow("helper_failed");
      expect(cleanupEntered).toBe(false);
    } finally {
      finish.resolve(); await first;
      await rm(root, { recursive: true, force: true });
    }
  });
  test.each(["provider", "checkpoint"] as const)("499 R1 lifetime expiry during %s preparation refuses actual helper spawn", async boundary => {
    const f = fixture({ development: true }), original = f.runtime.guest;
    const spawn = spyOn(Bun, "spawn");
    f.runtime.guest = async (context, action, principal) => {
      if (action !== "stage") return original(context, action, principal);
      const started = (f.progress as { startedAt: number }).startedAt;
      await f.runtime.sleep(started + 3 * 60 * 60_000 - f.runtime.now() - 1);
      if (boundary === "provider") {
        const fresh = await f.runtime.provider.instance("synthetic-owned");
        await f.runtime.sleep(2);
        expect(fresh?.id).toBe("synthetic-owned"); // unchanged address/identity, not a refresh path
      }
      await windowsCommand([process.execPath, "-e", ""], {
        beforeSpawn: context.assertEffect,
        ...(boundary === "checkpoint" ? { transportProbe: async () => { await f.runtime.sleep(2); } } : {}),
      });
      return {};
    };
    try {
      await expect(f.run()).rejects.toThrow("deadline_exceeded");
      expect(spawn).not.toHaveBeenCalled();
      expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
    } finally { spawn.mockRestore(); }
  });
  test("499 R1 a rejected already-started mutation checks execution expiry before projecting its failure", async () => {
    const f = fixture({ development: true }), original = f.runtime.guest;
    const execution = { signal: new AbortController().signal, deadline: performance.now() + 60_000, nextFailureId: () => 100 };
    const operationFailure = windowsFailure("helper_failed", "command", "unknown");
    f.runtime.guest = async (context, action, principal) => {
      if (action === "stage") {
        execution.deadline = performance.now() - 1;
        throw operationFailure;
      }
      return original(context, action, principal);
    };
    const failure = await runWindows({ identity, progress: undefined, runtime: f.runtime, checkpoint: f.checkpoint, pixel: f.pixel, execution }).catch(error => error);
    const evidence = normalizeQualificationFailures(failure);
    expect(evidence).toContainEqual(expect.objectContaining({ reason: "deadline_exceeded", operation: "unknown", observations: { controllerDeadline: true } }));
    expect(evidence).toContainEqual(operationFailure.evidence);
    expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
  });
  test.each([
    ["transport", () => windowsFailure("connection_timeout", "connection", "read_only", { transportFailure: true })],
    ["authentication", () => windowsFailure("authentication_failed", "connection", "read_only")],
    ["helper", () => windowsFailure("helper_failed", "command", "read_only")],
    ["unknown mutation", () => windowsFailure("mutation_unconfirmed", "command", "unknown")],
    ["unknown product disposition", () => windowsFailure("assertion_failed", "output", "unknown")],
    ["raw error", () => new Error("synthetic unknown failure")],
    ["controller deadline", () => windowsFailure("deadline_exceeded", "connection", "read_only", { controllerDeadline: true })],
    ["probe deadline", () => windowsFailure("probe_deadline", "connection", "read_only", { controllerDeadline: true, readOnlyProbe: true })],
  ] as const)("496 R2 initial development %s failure contains rather than retaining resources", async (_name, failure) => {
    const f = fixture({ development: true }), original = f.runtime.guest;
    f.runtime.guest = async (context, action, principal) => {
      if (action === "transport") throw failure();
      return original(context, action, principal);
    };
    await expect(f.run()).rejects.toThrow();
    expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
    expect(windowsNeedsCleanup(f.progress)).toBe(false);
  });
  test("496 R2 a confirmed initial product assertion remains available for bounded development repair", async () => {
    const f = fixture({ development: true, listener: true });
    await expect(f.run()).rejects.toThrow("pre-login");
    expect(f.instances).toHaveLength(1); expect(f.firewalls).toHaveLength(1);
    expect(windowsNeedsCleanup(f.progress)).toBe(true);
    await f.clean();
  });
  test("496 R2 rejected late startup observations are typed controller expiry", async () => {
    const f = fixture({ development: true }), original = f.runtime.guest;
    f.runtime.guest = async (context, action, principal) => {
      if (action === "ready") { await f.runtime.sleep(180_001); throw new Error("synthetic late startup refusal"); }
      return original(context, action, principal);
    };
    const failure = await f.run().catch(error => error);
    expect(failure).toBeInstanceOf(QualificationFailure);
    expect(failure.evidence).toMatchObject({ reason: "deadline_exceeded", observations: { controllerDeadline: true, timeoutMs: 180_000 } });
    expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
  });
  test("496 R2 containment replaces the cancelled runtime owner before provider destruction", async () => {
    const f = fixture({ development: true }), controller = new AbortController();
    const primary = { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 100 };
    let current: typeof primary | undefined;
    const owners: Array<typeof primary | undefined> = [];
    f.runtime.setExecution = owner => { current = owner; owners.push(owner); };
    const guest = f.runtime.guest, destroy = f.runtime.provider.destroyInstance;
    f.runtime.guest = async (context, action, principal) => {
      if (action === "stage") controller.abort();
      return guest(context, action, principal);
    };
    f.runtime.provider.destroyInstance = async (...args) => {
      expect(current).not.toBe(primary);
      expect(current?.signal.aborted).toBe(false);
      expect(current!.deadline).toBeGreaterThan(performance.now());
      await destroy(...args);
    };
    await expect(runWindows({ identity, progress: undefined, runtime: f.runtime, pixel: f.pixel, checkpoint: f.checkpoint, execution: primary }))
      .rejects.toThrow("deadline_exceeded");
    expect(owners).toHaveLength(2); expect(owners[0]).toBe(primary);
    expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
  });
  test.each(["unsettled", "preflight", "cancel", "expire"] as const)("496 R1 retained %s exit uses independent containment before returning", async kind => {
    const f = fixture({ development: true, fail: kind === "preflight" ? "prelogin" : "stage", productFailure: true });
    await expect(f.run()).rejects.toThrow();
    const controller = new AbortController();
    const execution = { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 100 };
    if (kind === "cancel") controller.abort();
    if (kind === "expire") execution.deadline = performance.now() - 1;
    if (kind === "preflight") f.runtime.admit = async () => { throw new Error("synthetic preflight refusal"); };
    await expect(runWindows({ identity, progress: f.progress, runtime: f.runtime, pixel: f.pixel, checkpoint: f.checkpoint, execution }))
      .rejects.toThrow();
    expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
    expect(windowsNeedsCleanup(f.progress)).toBe(false);
  });
  test("496 R1 admitted transport resume uses reconnect after the original allocation deadline", async () => {
    const f = fixture({ development: true, fail: "transport", productFailure: true });
    await expect(f.run()).rejects.toThrow();
    await f.runtime.sleep(720_001);
    const admission = Object.freeze({ transportStabilitySamples: 3, transportStabilityDurationMs: 60_000 });
    f.runtime.transportAdmission = async () => admission;
    const original = f.runtime.guest;
    f.runtime.guest = async (context, action, principal) => action === "transport" ? { ...admission } : original(context, action, principal);
    expect((await runWindows({ identity, progress: f.progress, runtime: f.runtime, pixel: f.pixel, checkpoint: f.checkpoint })).observations)
      .toMatchObject(admission);
  });
  test("496 R1 sealed predecessor boolean admission cannot substitute for stability observations", async () => {
    const f = fixture({ development: true, fail: "transport", productFailure: true });
    await expect(f.run()).rejects.toThrow();
    const predecessorVault = Object.freeze({ transportAdmitted: true });
    f.runtime.transportAdmission = async () => predecessorVault;
    let samples = 0; let observed: Record<string, unknown> | undefined;
    const original = f.runtime.guest;
    f.runtime.guest = async (context, action, principal) => {
      if (action !== "transport") return original(context, action, principal);
      if (observed) return observed;
      expect(context.transportAdmission).toBeUndefined();
      observed = await waitForStableWindowsTransport(async () => { samples += 1; return {}; }, f.runtime, context.allocationDeadline!);
      return observed;
    };
    const result = await runWindows({ identity, progress: f.progress, runtime: f.runtime, pixel: f.pixel, checkpoint: f.checkpoint });
    expect(samples).toBeGreaterThanOrEqual(3);
    expect(result.observations).toMatchObject({ transportStabilitySamples: 3, transportStabilityDurationMs: 60_000 });
  });
  test("493 R2 allocation expiry during the firewall checkpoint prevents creation", async () => {
    const f = fixture(); let expired = false;
    await expect(runWindows({ identity, progress: undefined, runtime: f.runtime, pixel: f.pixel,
      checkpoint: async progress => {
        await f.checkpoint(progress);
        if (!expired && progress.phase === "firewall_created" && typeof progress.allocationDeadline === "number") {
          expired = true; await f.runtime.sleep(720_001);
        }
      },
    })).rejects.toThrow("deadline_exceeded");
    expect(f.events).not.toContain("firewallCreated");
  });
  test("493 R2 allocation expiry during inventory prevents VM creation", async () => {
    const f = fixture(); let expired = false;
    f.runtime.provider.instances = async () => {
      if (!expired && f.events.includes("firewallConfigured")) { expired = true; await f.runtime.sleep(720_001); }
      return f.instances;
    };
    await expect(f.run()).rejects.toThrow("deadline_exceeded");
    expect(f.events).not.toContain("instanceCreated");
  });
  test("493 R2 partial firewall vault cannot veto destruction of a VM whose create response was lost", async () => {
    const f = fixture({ lostCreate: true });
    f.runtime.hasAccess = async () => false;
    f.runtime.cleanupInstance = async () => undefined;
    f.runtime.guest = async () => { throw windowsFailure("ownership_changed", "connection", "not_started"); };
    await expect(f.run()).rejects.toThrow("unclassified_failure");
    expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
    expect(windowsNeedsCleanup(f.progress)).toBe(false);
  });
  test("493 R2 partial firewall vault without any VM still cleans its firewall", async () => {
    const f = fixture();
    f.runtime.provider.createInstance = async () => { throw new Error("synthetic create refused"); };
    f.runtime.hasAccess = async () => false;
    f.runtime.cleanupInstance = async () => undefined;
    await expect(f.run()).rejects.toThrow("unclassified_failure");
    expect(f.events).not.toContain("reconnect"); expect(f.events).toContain("firewallDestroyed");
    expect(f.firewalls).toEqual([]); expect(windowsNeedsCleanup(f.progress)).toBe(false);
  });
  test("493 R2 interrupted settled-phase checkpoint preserves stability evidence but contains the harness failure", async () => {
    const f = fixture({ development: true }); const original = f.runtime.guest;
    let admission: ReturnType<typeof windowsRuntime.windowsTransportStability>; let failed = false;
    f.runtime.guest = async (context, action, principal) => {
      if (action !== "transport") return original(context, action, principal);
      if (admission) return { windowsBuild: 26100, ...admission };
      const result = await original(context, action, principal);
      admission = windowsRuntime.windowsTransportStability(result);
      return result;
    };
    await expect(runWindows({ identity, progress: undefined, runtime: f.runtime, pixel: f.pixel,
      checkpoint: async progress => {
        if (!failed && progress.phase === "transport_ready" && progress.settled === true) {
          failed = true; throw new Error("synthetic checkpoint interruption");
        }
        await f.checkpoint(progress);
      },
    })).rejects.toThrow("synthetic checkpoint interruption");
    expect((f.progress as { facts: Record<string, unknown> }).facts).toMatchObject({ transportStabilitySamples: 3, transportStabilityDurationMs: 60_000 });
    expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
    expect(windowsNeedsCleanup(f.progress)).toBe(false);
  });
  test.each(["cancel", "expire"] as const)("493 R2 development %s cleans retained resources instead of offering repair", async kind => {
    const f = fixture({ development: true }); const controller = new AbortController();
    const execution = { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 100 };
    const original = f.runtime.guest;
    f.runtime.guest = async (context, action, principal) => {
      if (action === "stage") {
        if (kind === "cancel") controller.abort(); else execution.deadline = performance.now() - 1;
      }
      return original(context, action, principal);
    };
    await expect(runWindows({ identity, progress: undefined, runtime: f.runtime, pixel: f.pixel, checkpoint: f.checkpoint, execution }))
      .rejects.toThrow("deadline_exceeded");
    expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
    expect(windowsNeedsCleanup(f.progress)).toBe(false);
  });
  test("493 R2 a late readiness success does not pass its local deadline", async () => {
    const f = fixture(); const original = f.runtime.guest;
    f.runtime.guest = async (context, action, principal) => {
      if (action === "ready") await f.runtime.sleep(180_000);
      return original(context, action, principal);
    };
    await expect(f.run()).rejects.toThrow("automatic LogonTrigger startup timed out");
  });
  test.each(["stage", "upgrade"] as const)("493 R1 completed uploads cannot authorize replaying an unsettled %s mutation", async action => {
    const f = fixture({ development: true, fail: action, productFailure: true });
    await expect(f.run()).rejects.toThrow();
    await windowsRuntime.windowsUploadOnce({ allowFresh: false, state: async () => "complete",
      checkpoint: async () => { throw new Error("completed archive must not change"); },
      upload: async () => { throw new Error("completed archive must not stream"); }, verify: async () => true });
    f.events.length = 0;
    await expect(runWindows({ identity, progress: f.progress, checkpoint: f.checkpoint, pixel: f.pixel, runtime: f.runtime }))
      .rejects.toThrow("mutation_unconfirmed");
    expect(f.events).not.toContain(action);
    expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
  });
  test("493 R1 each nested guest mutation checkpoints started and complete before another mutation", async () => {
    const f = fixture({ development: true }); const original = f.runtime.guest;
    f.runtime.guest = async (context, action, principal) => {
      if (action !== "stage") return original(context, action, principal);
      await context.mutation!("ps:administrator:join", async () => {
        expect((f.progress as { mutationClaims: Record<string, string> }).mutationClaims["toolchain_staged:ps:administrator:join"]).toBe("started");
      });
      expect((f.progress as { mutationClaims: Record<string, string> }).mutationClaims["toolchain_staged:ps:administrator:join"]).toBe("complete");
      await context.mutation!("ps:administrator:build", async () => { throw new Error("synthetic interrupted mutation"); });
      return {};
    };
    await expect(f.run()).rejects.toThrow();
    expect((f.progress as { mutationClaims: Record<string, string> }).mutationClaims).toMatchObject({
      "toolchain_staged:ps:administrator:join": "complete", "toolchain_staged:ps:administrator:build": "started",
    });
  });
  test.each(["cancel", "expire"] as const)("493 R1 %s during final settled checkpoint cannot return success", async kind => {
    const f = fixture({ development: true }); const controller = new AbortController();
    const execution = { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 100 };
    await expect(runWindows({ identity, progress: undefined, runtime: f.runtime, pixel: f.pixel, execution,
      checkpoint: async progress => {
        await f.checkpoint(progress);
        if (progress.phase === "evidence_complete" && progress.settled === true) {
          if (kind === "cancel") controller.abort(); else execution.deadline = performance.now() - 1;
        }
      },
    })).rejects.toThrow("deadline_exceeded");
  });
  test("493 R1 cached completed evidence refuses an already cancelled execution", async () => {
    const f = fixture(); await f.run(); const controller = new AbortController(); controller.abort();
    await expect(runWindows({ identity, progress: f.progress, runtime: f.runtime, pixel: f.pixel, checkpoint: f.checkpoint,
      execution: { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 100 },
    })).rejects.toThrow("deadline_exceeded");
  });
  test("493 R1 firewall and VM creation consume the shared twelve-minute admission budget", async () => {
    const f = fixture(); const firewall = f.runtime.provider.createFirewall, instance = f.runtime.provider.createInstance;
    f.runtime.provider.createFirewall = async (...args) => { await f.runtime.sleep(700_000); return firewall(...args); };
    f.runtime.provider.createInstance = async (...args) => { await f.runtime.sleep(30_000); return instance(...args); };
    await expect(f.run()).rejects.toThrow("deadline_exceeded");
    expect(f.events).not.toContain("transport");
  });
  test.each(["tailnet", "inventory"] as const)("493 R1 %s retirement failure preserves committed cleanup and its retry does not restore Pixel", async kind => {
    const f = fixture(); await f.run(); await f.clean();
    const tailnet = f.runtime.deleteTailnet, inventory = f.runtime.provider.instances;
    if (kind === "tailnet") f.runtime.deleteTailnet = async () => { throw new Error("synthetic transient failure"); };
    else f.runtime.provider.instances = async () => { throw new Error("synthetic transient failure"); };
    await expect(windowsRuntime.retireWindowsDevelopmentEpoch({ identity, progress: f.progress, checkpoint: f.checkpoint, pixel: f.pixel, runtime: f.runtime })).rejects.toThrow();
    expect(windowsNeedsCleanup(f.progress)).toBe(false);
    expect((f.progress as { retirementPending: boolean }).retirementPending).toBe(true);
    f.runtime.deleteTailnet = tailnet; f.runtime.provider.instances = inventory;
    f.runtime.restorePixel = async () => { throw new Error("committed cleanup must not restore Pixel again"); };
    await windowsRuntime.retireWindowsDevelopmentEpoch({ identity, progress: f.progress, checkpoint: f.checkpoint, pixel: f.pixel, runtime: f.runtime });
    expect((f.progress as { retirementPending: boolean }).retirementPending).toBe(false);
  });
  test("R2 resumed unsettled legacy staging refuses before another guest mutation", async () => {
    const f = fixture({ development: true, fail: "stage", productFailure: true });
    await expect(f.run()).rejects.toThrow();
    const prior = f.progress; f.events.length = 0;
    f.runtime.guest = async () => ({});
    await expect(runWindows({ identity, progress: prior, checkpoint: f.checkpoint, pixel: f.pixel, runtime: f.runtime })).rejects.toThrow("mutation_unconfirmed");
    expect(f.events).not.toContain("stage");
    expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
  });
  test("R2 development retires a cleanup-complete epoch vault before replacing identity", async () => {
    expect(typeof windowsRuntime.retireWindowsDevelopmentEpoch).toBe("function");
    const f = fixture(); await f.run(); await f.clean(); f.events.length = 0;
    await windowsRuntime.retireWindowsDevelopmentEpoch({ identity, progress: f.progress, checkpoint: f.checkpoint, pixel: f.pixel, runtime: f.runtime });
    f.events.push("identityReplaced");
    expect(f.events.indexOf("vaultRemoved")).toBeGreaterThanOrEqual(0);
    expect(f.events.indexOf("vaultRemoved")).toBeLessThan(f.events.indexOf("identityReplaced"));
  });
  test("R2 failed vault retirement cannot authorize replacing identity", async () => {
    const f = fixture(); await f.run(); await f.clean(); f.events.length = 0;
    f.runtime.removeAccess = async () => { throw new Error("synthetic unlink failure"); };
    await expect(windowsRuntime.retireWindowsDevelopmentEpoch({ identity, progress: f.progress, checkpoint: f.checkpoint, pixel: f.pixel, runtime: f.runtime })
      .then(() => { f.events.push("identityReplaced"); })).rejects.toThrow();
    expect(f.events).not.toContain("identityReplaced");
  });
  test("R2 dirty epochs cannot use the development retirement path", async () => {
    const f = fixture(); await f.run(); f.events.length = 0;
    await expect(windowsRuntime.retireWindowsDevelopmentEpoch({ identity, progress: f.progress, checkpoint: f.checkpoint, pixel: f.pixel, runtime: f.runtime }))
      .rejects.toThrow("mutation_unconfirmed");
    expect(f.events).toEqual([]);
  });
  test.each(["firewall_created", "instance_created"] as const)("R2 cancellation at %s checkpoint prevents allocation", async phase => {
    const f = fixture(); const controller = new AbortController();
    await expect(runWindows({ identity, progress: undefined, runtime: f.runtime, pixel: f.pixel,
      checkpoint: async progress => { await f.checkpoint(progress); if (progress.phase === phase && progress.settled === false) controller.abort(); },
      execution: { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 100 },
    })).rejects.toThrow();
    expect(f.events).not.toContain(phase === "firewall_created" ? "firewallCreated" : "instanceCreated");
  });
  test("R2 cancellation during the pre-allocation inventory prevents the VM create", async () => {
    const f = fixture(); const controller = new AbortController();
    f.runtime.provider.instances = async () => {
      if (f.events.includes("firewallConfigured")) controller.abort();
      return f.instances;
    };
    await expect(runWindows({ identity, progress: undefined, runtime: f.runtime, pixel: f.pixel, checkpoint: f.checkpoint,
      execution: { signal: controller.signal, deadline: performance.now() + 60_000, nextFailureId: () => 100 },
    })).rejects.toThrow();
    expect(f.events).not.toContain("instanceCreated");
  });
  test("R2 delayed firewall visibility is sampled after a settle window before committing completion", async () => {
    const f = fixture(); await f.run(); const start = f.runtime.now();
    f.runtime.provider.firewalls = async () => f.runtime.now() - start >= 5_000 ? f.firewalls : [];
    f.runtime.guest = async () => ({});
    await expect(f.clean()).rejects.toThrow("firewallResidue");
    expect(f.events).not.toContain("vaultRemoved"); expect(windowsNeedsCleanup(f.progress)).toBe(true);
  });
  test("R1 late firewall residue retains vault and dirty checkpoint", async () => {
    const f = fixture(); await f.run();
    let listings = 0;
    f.runtime.provider.firewalls = async () => ++listings === 1 ? [] : f.firewalls;
    await expect(f.clean()).rejects.toThrow("firewallResidue");
    expect(f.events).not.toContain("vaultRemoved");
    expect(windowsNeedsCleanup(f.progress)).toBe(true);
  });
  test("R1 completion checkpoint precedes vault removal and survives a crash at that boundary", async () => {
    const f = fixture(); await f.run();
    let vaultPresent = true;
    f.runtime.removeAccess = async () => {
      expect(windowsNeedsCleanup(f.progress)).toBe(false);
      vaultPresent = false; throw new Error("synthetic crash after vault unlink");
    };
    await expect(f.clean()).rejects.toThrow();
    expect(vaultPresent).toBe(false);
    expect(windowsNeedsCleanup(f.progress)).toBe(false);
    f.runtime.restorePixel = async () => { throw new Error("missing vault cannot restore Pixel"); };
    f.runtime.removeAccess = async () => {};
    await f.clean();
  });
  test("R1 missing completion checkpoint must retain recovery vault", async () => {
    const f = fixture(); await f.run();
    await expect(cleanupWindows({ identity, progress: f.progress, runtime: f.runtime, pixel: f.pixel,
      checkpoint: async next => { if (next.cleanupRequired === false) throw new Error("synthetic disk failure"); await f.checkpoint(next); },
    })).rejects.toThrow();
    expect(f.events).not.toContain("vaultRemoved"); expect(windowsNeedsCleanup(f.progress)).toBe(true);
  });
  test("R1 missing vault without committed completion stays blocked", async () => {
    const f = fixture(); await f.run();
    f.runtime.hasAccess = async () => false;
    await expect(f.clean()).rejects.toThrow("vaultState");
    expect(windowsNeedsCleanup(f.progress)).toBe(true);
    expect(f.events).not.toContain("vaultRemoved");
  });
  test("R1 guest failure after reconnect skips remaining guest mutations", async () => {
    const f = fixture(); await f.run(); f.events.length = 0;
    const original = f.runtime.guest;
    f.runtime.guest = async (context, action, principal) => {
      if (action === "stopOmp") throw windowsFailure("connection_timeout", "connection", "read_only", { transportFailure: true });
      return original(context, action, principal);
    };
    expect(await f.clean()).toMatchObject({ guestCleanupFailures: 1 });
    for (const action of ["uninstall@standard", "resetServe@standard", "logout@standard"]) expect(f.events).not.toContain(action);
  });
  test("completed evidence retains separate transport probe observations", async () => {
    const f = fixture(); const original = f.runtime.guest;
    const probes: WindowsTransportProbe[] = [];
    f.runtime.guest = async (context, action, principal) => {
      if (action === "transport") {
        for (let i = 0; i < 3; i++) {
          const startedAt = f.runtime.now() + i * 30_000;
          const probe = { startedAt, timeoutMs: 180_000, firstResponseLatencyMs: 100, signalAt: null, exitedAt: startedAt + 200, exitCode: 0 };
          probes.push(probe); await context.transportProbe!(probe);
        }
      }
      return original(context, action, principal);
    };
    const result = await f.run();
    expect(result.transportProbes).toEqual(probes);
    expect((f.progress as Record<string, unknown>).transportProbes).toEqual(probes);
    await f.clean();
    expect((f.progress as Record<string, unknown>).transportProbes).toEqual(probes);
  });
  test("transport timeline is checkpointed during the probe and retained through failed owner cleanup", async () => {
    const f = fixture(); const original = f.runtime.guest;
    const probe: WindowsTransportProbe = { startedAt: f.runtime.now(), timeoutMs: 180_000,
      firstResponseLatencyMs: null, signalAt: null, exitedAt: null, exitCode: null };
    f.runtime.guest = async (context, action, principal) => {
      if (action !== "transport") return original(context, action, principal);
      await context.transportProbe!(probe);
      expect((f.progress as Record<string, unknown>).transportProbes).toEqual([probe]);
      await context.transportProbe!({ ...probe, firstResponseLatencyMs: 120_000 });
      await context.transportProbe!({ ...probe, firstResponseLatencyMs: 120_000, signalAt: probe.startedAt + 180_000 });
      await context.transportProbe!({ ...probe, firstResponseLatencyMs: 120_000, signalAt: probe.startedAt + 180_000, exitedAt: probe.startedAt + 180_010, exitCode: 143 });
      throw new Error("synthetic transport deadline");
    };
    await expect(f.run()).rejects.toThrow("unclassified_failure");
    expect((f.progress as Record<string, unknown>).transportProbes).toEqual([
      { ...probe, firstResponseLatencyMs: 120_000, signalAt: probe.startedAt + 180_000, exitedAt: probe.startedAt + 180_010, exitCode: 143 },
    ]);
    expect(windowsNeedsCleanup(f.progress)).toBe(false);
    expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
  });
  test("historical progress without diagnostic probes remains cleanable without fabricating observations", async () => {
    const f = fixture(); await f.run();
    const prior = { ...f.progress as Record<string, unknown> };
    delete prior.transportProbes;
    await cleanupWindows({ identity, progress: prior, checkpoint: f.checkpoint, pixel: f.pixel, runtime: f.runtime });
    expect((f.progress as Record<string, unknown>).transportProbes).toBeUndefined();
    expect(windowsNeedsCleanup(f.progress)).toBe(false);
  });
  test("transport diagnostics reject unknown fields and incoherent timestamps before effects", async () => {
    const f = fixture(); await f.run();
    const probe: WindowsTransportProbe = { startedAt: f.runtime.now(), timeoutMs: 180_000,
      firstResponseLatencyMs: null, signalAt: null, exitedAt: null, exitCode: null };
    for (const bad of [{ ...probe, stderr: "synthetic-private-never-real" }, { ...probe, timeoutMs: 180_001 },
      { ...probe, exitCode: 0 }, { ...probe, signalAt: probe.startedAt - 1 },
      { ...probe, firstResponseLatencyMs: 20, exitedAt: probe.startedAt + 10, exitCode: 0 }]) {
      expect(() => windowsNeedsCleanup({ ...f.progress as Record<string, unknown>, transportProbes: [bad] })).toThrow();
    }
  });
  test("tagged doctor records denial while rejecting an unsafe host", () => {
    const observed = verifyWindowsDoctor({ checks: taggedDoctorChecks, ...doctorState });
    expect(observed).toMatchObject({ doctorTrue: 15, doctorChecks: 18, doctorIdentityAllowed: false, doctorPwa: false, doctorSessionHealth: false });
    expect(() => verifyWindowsDoctor({ checks: { ...taggedDoctorChecks, loopbackTrustSound: false }, ...doctorState })).toThrow();
  });
  test("a refused response may omit CSP, but an unexpected allowed identity cannot pass", () => {
    expect(verifyWindowsDoctor({ checks: { ...taggedDoctorChecks, securityHeaders: false }, ...doctorState })).toMatchObject({ doctorTrue: 14, doctorChecks: 18, doctorSecurityHeaders: false });
    expect(() => verifyWindowsDoctor({ checks: { ...taggedDoctorChecks, identityAllowed: true }, ...doctorState })).toThrow();
  });
  test("missing host checks and additional failed checks are not baseline variants", () => {
    const { serveMapping: _mapping, ...incomplete } = taggedDoctorChecks;
    expect(() => verifyWindowsDoctor({ checks: incomplete, ...doctorState })).toThrow();
    expect(() => verifyWindowsDoctor({ checks: { ...taggedDoctorChecks, extraHostCheck: false }, ...doctorState })).toThrow();
  });
  test("a healthy listener cannot qualify a non-interactive task principal", () => {
    expect(() => verifyWindowsDoctor({ checks: taggedDoctorChecks, ...doctorState, interactivePrincipal: false })).toThrow();
  });
  test("a logon trigger that fires on anyone's logon cannot qualify", () => {
    expect(() => verifyWindowsDoctor({ checks: taggedDoctorChecks, ...doctorState, logonTriggerScoped: false })).toThrow();
  });
  test("a privileged standard token stops the sub-lane while the Administrator still holds Tailscale", async () => {
    const f = fixture(); const original = f.runtime.guest;
    f.runtime.guest = async (context, action, principal) => action === "identity" ? { standardUserNonAdmin: true, standardUserNoSecurityPrivilege: false } : original(context, action, principal);
    await expect(f.run()).rejects.toThrow("token is privileged");
    expect(f.events).not.toContain("releaseTailnet"); expect(f.events).not.toContain("installFresh@standard");
    // Cleanup therefore signs the Administrator out of Tailscale, not the standard account.
    expect(f.events).toContain("logout"); expect(f.events).not.toContain("logout@standard");
    expect(f.instances).toEqual([]); expect(windowsNeedsCleanup(f.progress)).toBe(false);
  });
  test("pins fail closed on an upstream change", () => {
    assertWindowsPins(identity.omp);
    expect(() => assertWindowsPins({ ...identity.omp, sourceTree: "f".repeat(40) })).toThrow("pins differ");
  });
  test("lost create response is recovered by exact epoch label and destroyed", async () => {
    const f = fixture({ lostCreate: true }); await expect(f.run()).rejects.toThrow("unclassified_failure");
    expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]); expect(f.events).toContain("instanceDestroyed");
    expect(windowsNeedsCleanup(f.progress)).toBe(false);
  });
  test("failed private vault write destroys the newly created instance", async () => {
    const f = fixture({ vaultFails: true }); await expect(f.run()).rejects.toThrow("unclassified_failure");
    expect(f.instances).toEqual([]); expect(f.events.indexOf("instanceDestroyed")).toBeLessThan(f.events.indexOf("vaultRemoved"));
  });
  test("a resumed create intent reconciles by epoch without creating a second VM", async () => {
    const f = fixture(); await f.run();
    const interrupted = { ...f.progress as Record<string, unknown>, phase: "instance_created", settled: false, timings: { firewall_created: 0 }, facts: {} };
    await expect(runWindows({ identity, progress: interrupted, checkpoint: f.checkpoint, pixel: f.pixel, runtime: f.runtime })).rejects.toThrow("start a fresh epoch");
    expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
    expect(f.events.filter(event => event === "instanceCreated")).toHaveLength(1);
  });
  test("terminal progress without the preceding observations is refused", async () => {
    const f = fixture(); await f.run();
    const invalid = { ...f.progress as Record<string, unknown>, timings: {} };
    await expect(runWindows({ identity, progress: invalid, checkpoint: f.checkpoint, pixel: f.pixel, runtime: f.runtime })).rejects.toThrow("phase history");
  });
  test("development repair resumes read-only prelogin observations without repeating completed mutations", async () => {
    const f = fixture({ development: true, fail: "prelogin", productFailure: true });
    await expect(f.run()).rejects.toThrow("assertion_failed");
    expect(f.instances).toHaveLength(1); expect(windowsNeedsCleanup(f.progress)).toBe(true);
    const original = f.runtime.guest;
    f.runtime.guest = async (context, action, principal) => {
      if (action === "prelogin") return { taskPresent: true, taskRunning: false, gatewayProcesses: 0, listeners: 0, ...doctorState };
      return original(context, action, principal);
    };
    const result = await runWindows({ identity, progress: f.progress, checkpoint: f.checkpoint, pixel: f.pixel, runtime: f.runtime });
    expect((result.observations as Record<string, unknown>).failedPhaseAttempts).toBe(1);
    expect(f.events.filter(event => event === "instanceCreated")).toHaveLength(1);
    await f.clean(); expect(f.instances).toEqual([]);
  });
  test("protected instance is never destroyed even with the exact label", async () => {
    const f = fixture({ protected: true }); await expect(f.run()).rejects.toThrow("cleanup failed");
    expect(f.instances).toHaveLength(1); expect(f.events).not.toContain("instanceDestroyed"); expect(windowsNeedsCleanup(f.progress)).toBe(true);
  });
  test("a returned unlabelled or unrelated instance is not admitted or destroyed", async () => {
    const f = fixture({ unlabelled: true }); await expect(f.run()).rejects.toThrow("ownership_changed");
    expect(f.instances[0]?.label).toBe("unrelated"); expect(f.events).not.toContain("instanceDestroyed");
  });
  test("firewalls require a positive label and reject protected IDs", () => {
    expect(firewallEligibility("synthetic", undefined, {}).eligible).toBe(false);
    expect(firewallEligibility("synthetic", "unrelated", {}).eligible).toBe(false);
    expect(firewallEligibility("synthetic", label, { OMP_QUAL_PROTECTED_FIREWALLS: "synthetic" }).eligible).toBe(false);
    expect(firewallEligibility("synthetic", label, {}).eligible).toBe(true);
  });
  test("pre-login listener fails rather than being stopped by the harness", async () => {
    const f = fixture({ listener: true }); await expect(f.run()).rejects.toThrow("pre-login");
    expect(f.events.filter(item => item === "rdp")).toHaveLength(1); expect(f.instances).toEqual([]);
  });
  test("missing automatic LogonTrigger startup times out without manual start, naming only its booleans and counts", async () => {
    const f = fixture({ neverStarts: true });
    const failure = await f.run().then(() => undefined, (error: Error) => error);
    expect(failure?.message).toMatch(/^automatic LogonTrigger startup timed out; last \{.*"ready":false/u);
    expect(failure?.message).not.toContain("synthetic-guest-string");
    expect(f.events).not.toContain("publish"); expect(f.instances).toEqual([]);
  });
  test("stale generation must be 409, not another failure status", async () => {
    const f = fixture({ stale: 404 }); await expect(f.run()).rejects.toThrow("generation/launch");
    expect(f.events).not.toContain("physicalPixel");
  });
  test("confirmed VM destruction makes failed guest commands diagnostic, not failed containment", async () => {
    const f = fixture({ fail: "resetServe" }); await f.run();
    expect(await f.clean()).toMatchObject({ guestCleanupFailures: 1, instancesRemaining: 0 });
    // After the handover only the standard account may operate Tailscale and its own gateway.
    expect(f.events).not.toContain("logout@standard"); expect(f.events).toContain("uninstall@standard"); expect(f.events).toContain("tailnetDeleted"); expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
    await f.clean(); expect(windowsNeedsCleanup(f.progress)).toBe(false);
  });
  test("a confirmed absent VM skips every guest command but still proves external cleanup", async () => {
    const f = fixture(); await f.run();
    await f.runtime.provider.destroyInstance("synthetic-owned", label);
    f.events.length = 0;
    const result = await f.clean();
    expect(result).toMatchObject({ guestCommandsSkipped: true, guestCleanupFailures: 0, tailnetDeleted: true, vaultRemoved: true });
    for (const action of ["reconnect", "stopOmp", "uninstall@standard", "resetServe@standard", "logout@standard"]) expect(f.events).not.toContain(action);
    expect(f.events).toContain("pixelRestored"); expect(f.events).toContain("firewallDestroyed");
  });
  test.each(["instance", "firewall", "tailnet"] as const)("destroyed-guest diagnostics never excuse unresolved %s containment", async resource => {
    const f = fixture({ fail: "resetServe" }); await f.run();
    if (resource === "instance") f.runtime.provider.destroyInstance = async () => {};
    if (resource === "firewall") f.runtime.provider.destroyFirewall = async () => { throw new Error("synthetic refusal"); };
    if (resource === "tailnet") f.runtime.deleteTailnet = async () => { throw new Error("synthetic refusal"); };
    await expect(f.clean()).rejects.toThrow("Windows cleanup failed");
    expect(windowsNeedsCleanup(f.progress)).toBe(true); expect(f.events).not.toContain("vaultRemoved");
  });
  test("a changed vault-bound owner blocks cleanup even when its former label is absent", async () => {
    const f = fixture(); await f.run();
    f.runtime.cleanupInstance = async () => ({ ...f.instances[0]!, label: "foreign-owner" });
    f.events.length = 0;
    await expect(f.clean()).rejects.toThrow("guestInventory");
    expect(f.events).not.toContain("reconnect"); expect(f.events).not.toContain("vaultRemoved");
    expect(f.events).not.toContain("instanceDestroyed");
    expect(windowsNeedsCleanup(f.progress)).toBe(true);
  });
  test("a renamed vault-bound firewall blocks deletion and retains the vault", async () => {
    const f = fixture(); await f.run();
    f.runtime.cleanupFirewall = async () => ({ ...f.firewalls[0]!, description: "foreign-owner" });
    f.events.length = 0;
    await expect(f.clean()).rejects.toThrow("firewalls");
    expect(f.events).not.toContain("firewallDestroyed"); expect(f.events).not.toContain("vaultRemoved");
    expect(windowsNeedsCleanup(f.progress)).toBe(true);
  });
  test("campaign's eight decaying probes end at the owned deadline; cleanup replaces four 60-second failures with one bounded reconnect", async () => {
    const f = fixture(); const original = f.runtime.guest;
    const starts = [1792966648052, 1792966738517, 1792966828893, 1792966919653, 1792967010015, 1792967100370, 1792967190733, 1792967281106];
    const exits = [1792966708514, 1792966798889, 1792966889649, 1792966980008, 1792967070367, 1792967160729, 1792967251100, 1792967285173];
    const budgets: number[] = []; const cleanupBudgets: number[] = [];
    let now = starts[0]!, probeIndex = 0, cleanupStart = 0;
    f.runtime.guest = async (context, action, principal) => {
      if (action === "transport") return waitForStableWindowsTransport(async timeoutMs => {
        const i = probeIndex++; budgets.push(timeoutMs);
        const probe: WindowsTransportProbe = { startedAt: starts[i]!, timeoutMs, firstResponseLatencyMs: i === 2 ? 36_072 : null,
          signalAt: i === 7 ? 1792967285140 : null, exitedAt: exits[i]!, exitCode: i === 7 ? 143 : 1,
          controllerDeadline: i === 7 };
        await context.transportProbe!(probe); now = exits[i]!;
        throw i === 7 ? windowsFailure("probe_deadline", "connection", "read_only", { controllerDeadline: true, readOnlyProbe: true, exitCode: 143 })
          : windowsFailure("connection_timeout", "connection", "read_only", { transportFailure: true });
      }, { now: () => now + (probeIndex === 6 ? 2 : 0), sleep: async () => { if (probeIndex < starts.length) now = starts[probeIndex]!; } }, 1792967285137);
      if (action === "reconnect") {
        cleanupStart = now;
        return reconnectWindowsTransport(async budget => {
          cleanupBudgets.push(budget); now += Math.min(60_000, budget);
          throw windowsFailure("connection_timeout", "connection", "read_only", { transportFailure: true });
        }, { now: () => now, sleep: async ms => { now += ms; } });
      }
      if (["stopOmp", "uninstall", "resetServe", "logout"].includes(action)) {
        throw new Error("the historical four 60-second ConnectTimeout commands must not execute");
      }
      return original(context, action, principal);
    };
    const failure = await f.run().catch(error => error);
    expect(failure).toBeInstanceOf(QualificationFailure);
    expect(failure.evidence.reason).toBe("deadline_exceeded");
    expect(failure.evidence.observations.controllerDeadline).toBe(true);
    expect(budgets).toEqual([180_000, 180_000, 180_000, 180_000, 180_000, 180_000, 94_402, 4_031]);
    expect(cleanupBudgets).toEqual([90_000, 28_000]); expect(now - cleanupStart).toBe(90_000);
    expect((f.progress as Record<string, unknown>).transportProbes).toHaveLength(8);
    expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]); expect(windowsNeedsCleanup(f.progress)).toBe(false);
  });
  test("Pixel lease failure cannot keep paid resources alive or erase recovery state", async () => {
    const f = fixture(); await f.run();
    await expect(cleanupWindows({ identity, progress: f.progress, checkpoint: f.checkpoint, runtime: f.runtime,
      pixel: async () => {
        expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
        throw new Error("Pixel lease unavailable");
      },
    })).rejects.toThrow("pixelRestore");
    expect(f.events).not.toContain("vaultRemoved"); expect(windowsNeedsCleanup(f.progress)).toBe(true);
    await f.clean(); expect(windowsNeedsCleanup(f.progress)).toBe(false);
  });
  test("checkpoint failure cannot prevent idempotent owned-resource destruction", async () => {
    const f = fixture(); await f.run();
    await expect(cleanupWindows({ identity, progress: f.progress, runtime: f.runtime, pixel: f.pixel,
      checkpoint: async () => { throw new Error("private disk full"); },
    })).rejects.toThrow();
    expect(f.instances).toEqual([]); expect(f.firewalls).toEqual([]);
    expect(f.events).toContain("tailnetDeleted"); expect(windowsNeedsCleanup(f.progress)).toBe(true);
  });
  test("unknown and foreign progress fails before an effect", async () => {
    const f = fixture(); await expect(runWindows({ identity, progress: { epoch }, checkpoint: f.checkpoint, pixel: f.pixel, runtime: f.runtime })).rejects.toThrow("progress");
    expect(f.events).toEqual([]);
    await f.run(); const p = f.progress as Record<string, unknown>;
    await expect(cleanupWindows({ identity, progress: { ...p, binding: "e".repeat(64) }, checkpoint: f.checkpoint, pixel: f.pixel, runtime: f.runtime })).rejects.toThrow("foreign");
  });
  test("pass records sampled lifecycle observations without identifiers or forbidden fields", async () => {
    const f = fixture(); const result = await f.run();
    const observations = result.observations as Record<string, unknown>;
    expect(observations.preloginDurationMs).toBeGreaterThanOrEqual(30_000); expect(observations.preloginSamples).toBeGreaterThanOrEqual(3);
    expect(observations.pixelIdentityAccepted).toBe(true); expect(observations.readinessChanged).toBe(true); expect(observations.historySelected).toBe(true);
    expect(observations.standardPreloginSamples).toBeGreaterThanOrEqual(3); expect(observations.standardUserNoSecurityPrivilege).toBe(true);
    expect(observations.standardDoctorTrue).toBe(15); expect(observations.standardUninstalled).toBe(true);
    // Tailscale changes hands before the standard account joins, and its desktop exists before it installs.
    const order = ["candidate_uninstalled", "releaseTailnet", "tailnetDeleted", "join@standard", "rdp@standard", "installFresh@standard", "doctor@standard"]
      .map(event => event === "candidate_uninstalled" ? f.events.indexOf("checkpoint:candidate_uninstalled") : f.events.indexOf(event));
    expect(order.every(index => index >= 0)).toBe(true); expect(order).toEqual([...order].sort((a, b) => a - b));
    const inspect = (value: unknown) => { if (!value || typeof value !== "object") return; for (const [key, item] of Object.entries(value)) { expect(key).not.toMatch(/capability|password|secret|authKey|token|bearer/iu); inspect(item); } };
    inspect(result); inspect(f.progress);
    const serialized = JSON.stringify(result);
    for (const forbidden of ["synthetic-owned", "synthetic-firewall", "192.0.2.1", "synthetic-never-real", label, "/synthetic/"]) expect(serialized).not.toContain(forbidden);
    expect(f.events.indexOf("pixelLease")).toBeLessThan(f.events.indexOf("physicalPixel"));
    expect(windowsNeedsCleanup(f.progress)).toBe(true);
    const cleaned = await f.clean(); expect(cleaned).toMatchObject({ epoch, instancesRemaining: 0, firewallsRemaining: 0, tailnetDeleted: true });
    await f.clean(); expect(windowsNeedsCleanup(f.progress)).toBe(false);
  });
});

describe("Windows stale launch HTTP boundary", () => {
  test("R2 wrong stale status is a product assertion before malformed body decoding", async () => {
    const failure = await verifyWindowsStaleLaunch("https://synthetic.invalid", { instanceId: "synthetic-session", generation: 1 },
      async () => new Response("not-json", { status: 500 })).catch(error => error);
    expect(failure.evidence).toMatchObject({ class: "product", reason: "assertion_failed" });
  });
  test("R2 expected stale status with malformed JSON remains a harness failure", async () => {
    const failure = await verifyWindowsStaleLaunch("https://synthetic.invalid", { instanceId: "synthetic-session", generation: 1 },
      async () => new Response("not-json", { status: 409, headers: { "cache-control": "no-store" } })).catch(error => error);
    expect(failure.evidence).toMatchObject({ class: "harness", reason: "helper_failed" });
  });
  test("R1 a stale-launch contract violation is typed product evidence", async () => {
    const failure = await verifyWindowsStaleLaunch("https://synthetic.invalid", { instanceId: "synthetic-session", generation: 1 },
      async () => new Response("{}", { status: 200 })).catch(error => error);
    expect(failure).toBeInstanceOf(QualificationFailure);
    expect(failure.evidence).toMatchObject({ class: "product", reason: "assertion_failed" });
  });
  test("both modes refuse a stale generation without releasing a value", async () => {
    const modes: string[] = [];
    const fake = async (_url: string, options: RequestInit) => { modes.push(JSON.parse(String(options.body)).mode); return new Response('{"code":"generation_mismatch"}', { status: 409, headers: { "cache-control": "no-store" } }); };
    expect(await verifyWindowsStaleLaunch("https://synthetic.invalid", { instanceId: "synthetic-session", generation: 1 }, fake)).toEqual({ staleViewStatus: 409, staleControlStatus: 409 });
    expect(modes).toEqual(["view", "control"]);
  });
  test.each([200, 400, 403, 404, 500])("rejects HTTP %i", async status => {
    const fake = async () => new Response("{}", { status, headers: { "cache-control": "no-store" } });
    await expect(verifyWindowsStaleLaunch("https://synthetic.invalid", { instanceId: "synthetic-session", generation: 1 }, fake)).rejects.toThrow("409");
  });
  test("refuses a 409 that leaks a launch value", async () => {
    const fake = async () => new Response(JSON.stringify({ capability: "synthetic-value-never-real" }), { status: 409, headers: { "cache-control": "no-store" } });
    await expect(verifyWindowsStaleLaunch("https://synthetic.invalid", { instanceId: "synthetic-session", generation: 1 }, fake)).rejects.toThrow("fail closed");
  });
});
