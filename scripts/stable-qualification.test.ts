import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { PRODUCT_VERSION } from "./build-release.ts";
import {
  assertMacBuildOutput,
  assertMacLifecycleOutput,
  assertProtectedFilesUnchanged,
  assertDeviceCloudResumeEligible,
  createPixelLease,
  createReceiptPersister,
  createStableQualificationReceipt,
  completeOmpPublicationLifecycle,
  executeReceiptLane,
  externalCleanupCurrent,
  finishLiveQualification,
  recordDeviceCloudCampaignFailure,
  withConsumedDeviceCloudHold,
  incompleteQualification,
  loadConfiguredMacTarget,
  markMacCleanupRequired,
  parseCandidateTagArgs,
  parseQualificationPins,
  parseStableQualificationArgs,
  qualifyDebian,
  runExternalLane,
  runAndroidAcceptance,
  runPixelRestoringChild,
  runStableQualification,
  receiptNeedsMacCleanup,
  validateStableQualificationReceipt,
  verifyLaunchContracts,
  waitForPublishedSession,
  waitForRevocation,
  type DebianQualificationRuntime,
  type ExternalLaneIdentity,
  type ExternalLaneModule,
  type ProtectedFileSnapshot,
  type StablePreflightRuntime,
  type StableQualificationLaneModules,
} from "./stable-qualification.ts";
import { OmpLifecycleFailure, type OmpLifecycleEvidence } from "./omp-lifecycle-qualification.ts";
import { DeviceCloudAvailabilityHold, deviceCloudHolds, parseDeviceCloudHold } from "./device-cloud-availability.ts";
import { parseDeviceCloudHoldSet, readDeviceCloudOutcomeFile, recognizedDeviceCloudOutcome } from "./device-cloud-outcome.ts";
import type { QualificationExecution } from "./qualification-outcome.ts";
import type { LaneFailure } from "./qualification-failure.ts";

const TAG = `v${PRODUCT_VERSION}-prealpha.21`;
// Derived exactly as the orchestrator derives it, so this suite cannot pass against a predecessor
// the campaign would refuse. The lock names the published stable while a candidate is being
// qualified, and names this version with that stable as `previousTag` once the ledger is approved.
const STABLE_LOCK = JSON.parse(
  readFileSync(fileURLToPath(new URL("../STABLE_RELEASE.lock.json", import.meta.url)), "utf8"),
) as { readonly releaseTag: string; readonly previousTag: string };
const PREVIOUS_TAG =
  STABLE_LOCK.releaseTag === `v${PRODUCT_VERSION}` ? STABLE_LOCK.previousTag : STABLE_LOCK.releaseTag;
const COMMIT = "a".repeat(40);
const MAC_ENV = { OMP_STABLE_MAC_HOST: "gwqual@fixture.invalid", OMP_STABLE_MAC_MODEL: "Mac17,14" };
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected promise to reject");
}

/** Admission-only lanes: an unrequested effect fails loudly instead of reaching a real VM or phone. */
function admissionLanes(refuse?: "windows" | "androidPush" | "deviceCloud"): StableQualificationLaneModules {
  const lane = (name: "windows" | "androidPush" | "deviceCloud"): ExternalLaneModule => ({
    preflight: async () => {
      if (refuse === name) throw new Error(`${name} fixture refuses admission`);
    },
    run: async () => {
      throw new Error(`${name} must not run in an admission test`);
    },
    needsCleanup: () => false,
    cleanup: async () => {
      throw new Error(`${name} must not clean up in an admission test`);
    },
  });
  return {
    windows: lane("windows"),
    androidPush: lane("androidPush"),
    deviceCloud: lane("deviceCloud"),
    createPixelLease: () => createPixelLease(() => {}),
  };
}

test("campaign exclusion precedes source/receipt reads and admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "stable-lease-boundary-"));
  try {
    const fixture = await preflightFixture(root);
    let acquired = false;
    const runtime: StablePreflightRuntime = {
      ...fixture,
      withReleaseLease: async (owner, _action) => {
        expect(owner).toBe(`qualification:${TAG}:${join(root, "stable-qualification.json")}`);
        acquired = true;
        throw new Error("release host is busy");
      },
      output: async () => { throw new Error("must not read source or probe a host without the lease"); },
    };
    await expect(runStableQualification(["--tag", TAG], runtime, admissionLanes())).rejects.toThrow("release host is busy");
    expect(acquired).toBe(true);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe("stable qualification arguments", () => {
  test.each([undefined, "", "host.invalid", "root@host.invalid:22", "-oProxyCommand=x@host", "user@host;true", "user@bad..host", "user@host\n"])("requires a plain Mac SSH destination: %s", host => {
    expect(() => parseStableQualificationArgs(["--tag", TAG], { ...MAC_ENV, OMP_STABLE_MAC_HOST: host })).toThrow("OMP_STABLE_MAC_HOST");
  });

  test.each([undefined, "", "Mac17", "Mac17,14\n", "Mac17,14;true"])("requires an exact hardware model: %s", model => {
    expect(() => parseStableQualificationArgs(["--tag", TAG], { ...MAC_ENV, OMP_STABLE_MAC_MODEL: model })).toThrow("OMP_STABLE_MAC_MODEL");
  });

  test("accepts a configured leased host without a provider lookup", async () => {
    const options = parseStableQualificationArgs(["--tag", TAG], {
      OMP_STABLE_MAC_HOST: "admin@192.0.2.10", OMP_STABLE_MAC_MODEL: "Mac14,3",
    });
    expect(await loadConfiguredMacTarget(options)).toEqual({ sshDestination: "admin@192.0.2.10", sudoPassword: "" });
  });

  test("rejects a blank password file rather than silently enabling passwordless sudo", () => {
    expect(() => parseStableQualificationArgs(["--tag", TAG], { ...MAC_ENV, OMP_STABLE_MAC_SUDO_PASSWORD_FILE: "" })).toThrow("OMP_STABLE_MAC_SUDO_PASSWORD_FILE");
  });

  test("a lane without a Mac parses the candidate pair with no Mac configuration at all", () => {
    // The Windows development CLI passes an empty environment on purpose, so the configured-Mac
    // requirement that #339 added to the campaign parser must not reach it: it broke every
    // `windows-stable-qualification.ts run` with "OMP_STABLE_MAC_HOST is required" (2026-10-02).
    expect(parseCandidateTagArgs(["--tag", TAG], {})).toEqual({ preflight: false, tag: TAG, previousTag: PREVIOUS_TAG });
    expect(() => parseCandidateTagArgs(["--tag", TAG, "--previous-tag", "v0.1.0"], {})).toThrow("--previous-tag");
    expect(() => parseStableQualificationArgs(["--tag", TAG], {})).toThrow("OMP_STABLE_MAC_HOST");
  });


  test("rejects stable, rc, zero-indexed, and prior-version candidate tags", () => {
    for (const tag of [`v${PRODUCT_VERSION}`, `v${PRODUCT_VERSION}-rc.1`, `v${PRODUCT_VERSION}-prealpha.0`, "v0.3.0-prealpha.25"]) {
      expect(() => parseStableQualificationArgs(["--tag", tag], {})).toThrow("--tag must match");
    }
  });

  test("accepts only the published stable as the rollback predecessor", () => {
    expect(parseStableQualificationArgs(["--tag", TAG, "--previous-tag", PREVIOUS_TAG], MAC_ENV).previousTag).toBe(
      PREVIOUS_TAG,
    );
    // Every superseded stable is rejected by name. Each was the correct predecessor for exactly one
    // campaign, and accepting one now would silently qualify the upgrade and rollback pair against a
    // release nobody is running.
    for (const previous of ["v0.1.0", "v0.2.0", "v0.3.0", "v0.4.0", "v0.2.1-prealpha.1", "v0.4.0-prealpha.1", "v0.2.1", ""]) {
      expect(previous).not.toBe(PREVIOUS_TAG);
      expect(() => parseStableQualificationArgs(["--tag", TAG, "--previous-tag", previous], {})).toThrow(
        "--previous-tag",
      );
    }
  });

  test("defaults the predecessor to the published stable this tree would roll back to", () => {
    // The constant this replaced went stale once per release: #200 corrected it from v0.3.0 to
    // v0.4.0, and it was still v0.4.0 while 0.4.2 was being cut. Deriving it from the lock that
    // publication rewrites is what stops that recurring, so the derivation itself is the assertion.
    expect(parseStableQualificationArgs(["--tag", TAG], MAC_ENV).previousTag).toBe(PREVIOUS_TAG);
    expect(PREVIOUS_TAG).toMatch(/^v[0-9]+\.[0-9]+\.[0-9]+$/u);
    // A candidate cannot roll back to itself: the lock must still name the superseded stable while
    // this version is in development.
    expect(PREVIOUS_TAG).not.toBe(`v${PRODUCT_VERSION}`);
  });

  test("rejects an unbounded relay duration before any external effect", () => {
    expect(() => parseStableQualificationArgs(["--tag", TAG], { OMP_STABLE_RELAY_SECONDS: "3601" })).toThrow(
      "must not exceed 3600",
    );
  });

  test("requires the campaign floor while allowing longer bounded relay checks", () => {
    expect(parseStableQualificationArgs(["--tag", TAG], MAC_ENV).relaySeconds).toBe(1_800);
    for (const duration of ["60", "1799"]) {
      expect(() => parseStableQualificationArgs(["--tag", TAG], { OMP_STABLE_RELAY_SECONDS: duration })).toThrow("at least 1800");
    }
    for (const duration of ["1800", "2400", "3600"]) {
      expect(parseStableQualificationArgs(["--tag", TAG], { ...MAC_ENV, OMP_STABLE_RELAY_SECONDS: duration }).relaySeconds).toBe(Number(duration));
    }
  });

  test("rejects path-special and overlong session labels before host access", () => {
    for (const sessionLabel of [".", "..", "a".repeat(129)]) {
      expect(() =>
        parseStableQualificationArgs(["--tag", TAG], { OMP_STABLE_SESSION_LABEL: sessionLabel }),
      ).toThrow("safe single path component");
    }
  });
});

describe("configured Mac sudo password file", () => {
  test.skipIf(process.platform === "win32")("accepts only a private owned regular file containing one password line", async () => {
    const root = await mkdtemp(join(tmpdir(), "stable-mac-password-"));
    const path = join(root, "sudo-password");
    const options = parseStableQualificationArgs(["--tag", TAG], { ...MAC_ENV, OMP_STABLE_MAC_SUDO_PASSWORD_FILE: path });
    const password = "synthetic-private-sudo-'canary ";
    try {
      await writeFile(path, password + "\n", { mode: 0o600 });
      expect(await loadConfiguredMacTarget(options)).toEqual({ sshDestination: MAC_ENV.OMP_STABLE_MAC_HOST, sudoPassword: password });
      for (const mode of [0o640, 0o604, 0o620]) {
        await chmod(path, mode);
        await expect(loadConfiguredMacTarget(options)).rejects.toThrow("no group or other access");
      }
      await chmod(path, 0o600);
      const link = join(root, "link");
      await symlink(path, link);
      for (const macSudoPasswordFile of [link, root]) {
        await expect(loadConfiguredMacTarget({ ...options, macSudoPasswordFile })).rejects.toThrow("current-user regular file");
      }
      for (const contents of ["", "\n", "first\nsecond", "nul\0password"]) {
        await writeFile(path, contents);
        await expect(loadConfiguredMacTarget(options)).rejects.toThrow("one nonempty password line");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("rejects another owner's private file without returning its contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "stable-mac-password-owner-"));
    const path = join(root, "sudo-password");
    try {
      await writeFile(path, "synthetic-private-owner-canary", { mode: 0o600 });
      // Isolate the uid seam: no privilege or host-wide ownership change is needed for this refusal.
      const child = Bun.spawn([process.execPath, "-e", `
        import { loadConfiguredMacTarget, parseStableQualificationArgs } from "./scripts/stable-qualification.ts";
        const uid = process.getuid();
        process.getuid = () => uid + 1;
        try {
          await loadConfiguredMacTarget(parseStableQualificationArgs(["--tag", process.env.TEST_TAG], process.env));
          process.exitCode = 2;
        } catch (error) { console.log(error.message); }
      `], {
        cwd: REPOSITORY_ROOT,
        env: { ...process.env, ...MAC_ENV, OMP_STABLE_MAC_SUDO_PASSWORD_FILE: path, TEST_TAG: TAG },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout.trim()).toBe("Mac sudo password file must be a current-user regular file with no group or other access");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function passedRelayReceipt(durationSeconds = 1_800) {
  const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
  const base = Date.now() - 2 * 60 * 60 * 1_000;
  const at = (seconds: number) => new Date(base + seconds * 1_000).toISOString();
  receipt.startedAt = at(0);
  receipt.status = "passed";
  receipt.completedAt = at(3_700);
  receipt.candidate = { tag: TAG, sourceCommit: COMMIT, archiveSha256: "b".repeat(64) };
  receipt.macHost = MAC_ENV.OMP_STABLE_MAC_HOST;
  for (const lane of Object.values(receipt.lanes)) {
    Object.assign(lane, { status: "passed", attempts: 1, startedAt: at(1), completedAt: at(3_700) });
  }
  receipt.lanes.relay = {
    status: "passed", attempts: 1, startedAt: at(10), completedAt: at(durationSeconds + 12),
    evidence: {
      startedAt: at(11), completedAt: at(durationSeconds + 11), durationSeconds, transitions: 2, finalPhase: "live",
    },
  };
  receipt.lanes.cleanup.evidence = { gatewayProcesses: 0, gatewayListeners: 0, liveOmpHosts: 0 };
  return receipt;
}

describe("resumed relay qualification proof", () => {
  test.each([
    ["historical sixty-second pass", (receipt: ReturnType<typeof passedRelayReceipt>) => {
      receipt.lanes.relay = passedRelayReceipt(60).lanes.relay;
    }],
    ["missing summary", (receipt: ReturnType<typeof passedRelayReceipt>) => { delete receipt.lanes.relay.evidence; }],
    ["invalid duration", (receipt: ReturnType<typeof passedRelayReceipt>) => { receipt.lanes.relay.evidence!.durationSeconds = "1800"; }],
    ["incomplete relay", (receipt: ReturnType<typeof passedRelayReceipt>) => { receipt.lanes.relay.evidence!.finalPhase = "ended"; }],
    ["invalid transitions", (receipt: ReturnType<typeof passedRelayReceipt>) => { receipt.lanes.relay.evidence!.transitions = -1; }],
    ["invalid timestamp", (receipt: ReturnType<typeof passedRelayReceipt>) => { receipt.lanes.relay.evidence!.startedAt = "not-a-date"; }],
    ["missing attempt boundary", (receipt: ReturnType<typeof passedRelayReceipt>) => { delete receipt.lanes.relay.completedAt; }],
    ["stale attempt", (receipt: ReturnType<typeof passedRelayReceipt>) => { receipt.lanes.relay.startedAt = receipt.lanes.relay.completedAt!; }],
    ["stale campaign", (receipt: ReturnType<typeof passedRelayReceipt>) => { receipt.startedAt = receipt.lanes.relay.completedAt!; }],
    ["invented elapsed duration", (receipt: ReturnType<typeof passedRelayReceipt>) => {
      receipt.lanes.relay = passedRelayReceipt(60).lanes.relay;
      receipt.lanes.relay.evidence!.durationSeconds = 1_800;
    }],
  ] as const)("rejects %s before admission without reopening completed cleanup", async (_name, mutate) => {
    const root = await mkdtemp(join(tmpdir(), "stable-relay-resume-"));
    try {
      const receipt = passedRelayReceipt();
      mutate(receipt);
      const path = join(root, "stable-qualification.json");
      await writeFile(path, JSON.stringify(receipt));
      const runtime = await preflightFixture(root);
      let externalProbe = false;
      const guarded = {
        ...runtime,
        output: async (command: readonly string[]) => {
          if (command.join(" ") === "git rev-parse HEAD") return COMMIT;
          externalProbe = true;
          throw new Error("unexpected admission");
        },
        loadMacTarget: async () => { throw new Error("completed cleanup must not reopen"); },
      };
      await expect(runStableQualification(["--tag", TAG], guarded, admissionLanes())).rejects.toThrow("relay evidence");
      const persisted = JSON.parse(await readFile(path, "utf8"));
      expect(persisted.status).toBe("failed");
      expect(persisted.completedAt).toBeUndefined();
      expect(persisted.lanes.relay).toEqual(receipt.lanes.relay);
      expect(persisted.lanes.cleanup).toEqual(receipt.lanes.cleanup);
      expect(externalProbe).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("binds resume to the requested duration without rejecting longer valid evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "stable-relay-duration-"));
    try {
      const path = join(root, "stable-qualification.json");
      const runtime = await preflightFixture(root, "absent");
      const guarded = { ...runtime, environment: { ...runtime.environment, OMP_STABLE_RELAY_SECONDS: "2400" } };
      await writeFile(path, JSON.stringify(passedRelayReceipt(1_800)));
      await expect(runStableQualification(["--tag", TAG], guarded, admissionLanes())).rejects.toThrow("relay evidence");
      for (const duration of [2_400, 3_600]) {
        await writeFile(path, JSON.stringify(passedRelayReceipt(duration)));
        // Valid proof reaches read-only admission, which deliberately stops before any effects.
        await expect(runStableQualification(["--tag", TAG], guarded, admissionLanes())).rejects.toThrow("authorized Android");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Mac receipt host ownership", () => {
  test.each(["different host", "unbound legacy"] as const)("refuses %s Mac effects before target resolution or any remote command", async variant => {
    const root = await mkdtemp(join(tmpdir(), "stable-mac-binding-"));
    try {
      const receipt = passedRelayReceipt(60);
      receipt.status = "failed";
      receipt.lanes.cleanup = { status: "pending", attempts: 1 };
      if (variant === "unbound legacy") delete receipt.macHost;
      const original = JSON.stringify(receipt);
      const path = join(root, "stable-qualification.json");
      await writeFile(path, original);
      const fixture = await preflightFixture(root);
      let remoteCommands = 0, targetLoads = 0;
      const runtime: StablePreflightRuntime = {
        ...fixture,
        environment: { ...fixture.environment, OMP_STABLE_MAC_HOST: variant === "different host" ? "gwqual@other.invalid" : MAC_ENV.OMP_STABLE_MAC_HOST },
        output: async command => {
          if (command.join(" ") === "git rev-parse HEAD") return COMMIT;
          remoteCommands += 1;
          throw new Error("unexpected remote admission or cleanup");
        },
        loadMacTarget: async () => { targetLoads += 1; throw new Error("unexpected target resolution"); },
      };
      await expect(runStableQualification(["--tag", TAG], runtime, admissionLanes())).rejects.toThrow(
        variant === "different host" ? "configured Mac host differs from the receipt" : "Perform manual cleanup of the original Mac",
      );
      expect({ remoteCommands, targetLoads }).toEqual({ remoteCommands: 0, targetLoads: 0 });
      expect(await readFile(path, "utf8")).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("persists the configured Mac host before the first effect and preserves schema 3", async () => {
    const root = await mkdtemp(join(tmpdir(), "stable-mac-first-effect-"));
    try {
      const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
      expect(validateStableQualificationReceipt(receipt, TAG, COMMIT, PREVIOUS_TAG).macHost).toBeUndefined();
      const path = join(root, "stable-qualification.json");
      const persist = createReceiptPersister(path, receipt);
      expect(markMacCleanupRequired(receipt, MAC_ENV.OMP_STABLE_MAC_HOST)).toBe(true);
      await persist();
      await executeReceiptLane(receipt, "macos", persist, async () => {
        const beforeEffect = validateStableQualificationReceipt(JSON.parse(await readFile(path, "utf8")), TAG, COMMIT, PREVIOUS_TAG);
        expect(beforeEffect.schemaVersion).toBe(3);
        expect(beforeEffect.macHost).toBe(MAC_ENV.OMP_STABLE_MAC_HOST);
        expect(beforeEffect.lanes.macos).toMatchObject({ status: "running", attempts: 1 });
        return { hardware: "Mac17,14" };
      });
      const restored = validateStableQualificationReceipt(JSON.parse(await readFile(path, "utf8")), TAG, COMMIT, PREVIOUS_TAG);
      expect(restored.macHost).toBe(MAC_ENV.OMP_STABLE_MAC_HOST);
      expect(() => markMacCleanupRequired(restored, "gwqual@other.invalid")).toThrow("configured Mac host differs");
      for (const macHost of [null, 7, "not a destination"]) {
        expect(() => validateStableQualificationReceipt({ ...restored, macHost }, TAG, COMMIT, PREVIOUS_TAG)).toThrow("Mac host is invalid");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([false, true])("model refusal never cleans a host with no recorded effects (resumed=%s)", async resumed => {
    const root = await mkdtemp(join(tmpdir(), "stable-mac-unowned-"));
    try {
      const path = join(root, "stable-qualification.json");
      const original = JSON.stringify(createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG));
      if (resumed) await writeFile(path, original);
      const fixture = await preflightFixture(root);
      let targetLoads = 0, cleanupCalls = 0, cleanupProbes = 0, sshProbes = 0;
      const runtime: StablePreflightRuntime = {
        ...fixture,
        loadMacTarget: async options => {
          targetLoads += 1;
          if (targetLoads > 1) throw new Error("unexpected cleanup target load");
          return loadConfiguredMacTarget(options);
        },
        output: async command => {
          if (command[0] !== "ssh") return fixture.output(command);
          sshProbes += 1;
          return "Mac14,3\nqualification-mac.example.ts.net\nomp/18.1.20\nguard=absent";
        },
      };
      const lane: ExternalLaneModule = {
        preflight: async () => { throw new Error("model refusal must precede lane admission"); },
        run: async () => { throw new Error("unexpected lane run"); },
        needsCleanup: () => { cleanupProbes += 1; throw new Error("no progress has ever been recorded"); },
        cleanup: async () => { cleanupCalls += 1; throw new Error("unexpected lane cleanup"); },
      };
      await expect(runStableQualification(["--tag", TAG], runtime, {
        windows: lane, androidPush: lane, deviceCloud: lane, createPixelLease: () => createPixelLease(() => {}),
      })).rejects.toThrow("Mac hardware mismatch: expected Mac17,14, measured Mac14,3");
      expect({ targetLoads, cleanupCalls, cleanupProbes, sshProbes }).toEqual({ targetLoads: 1, cleanupCalls: 0, cleanupProbes: 0, sshProbes: 1 });
      if (resumed) expect(await readFile(path, "utf8")).toBe(original);
      else expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test.skipIf(process.platform === "win32")("same-host resume cleans bound Mac effects when relay admission refuses", async () => {
  const root = await mkdtemp(join(tmpdir(), "stable-relay-cleanup-"));
  try {
    const receipt = passedRelayReceipt(60);
    receipt.status = "failed";
    receipt.lanes.cleanup = { status: "pending", attempts: 1 };
    const path = join(root, "stable-qualification.json");
    const bin = join(root, "bin");
    const effects = join(root, "effects");
    await mkdir(bin);
    await mkdir(effects);
    await writeFile(path, JSON.stringify(receipt));
    for (const effect of ["gateway", "serve", "omp", "artifacts"]) await writeFile(join(effects, effect), "recorded effect");
    await writeFile(join(bin, "bash"), [
      "#!/bin/sh",
      '[ "$1" = scripts/qualify-macos-host.sh ] || exit 91',
      'case "$2" in',
      'uninstall) /bin/rm "$FIXTURE_ROOT/effects/gateway"; printf "%s\n" "plist present:                         no" "gui job:                               absent" "gateway pids:                          0" "listeners:                             0";;',
      `omp-clean) /bin/rm "$FIXTURE_ROOT/effects/omp"; echo '{"liveOmpHosts":0,"binaryPresent":false,"sourcePresent":false}';;`,
      '*) exit 92;;',
      "esac",
    ].join("\n"), { mode: 0o700 });
    await writeFile(join(bin, "ssh"), [
      "#!/bin/sh",
      'case "$*" in',
      '*"serve reset"*) /bin/rm "$FIXTURE_ROOT/effects/serve";;',
      '*"rm -rf"*) /bin/rm "$FIXTURE_ROOT/effects/artifacts";;',
      '*) exit 93;;',
      "esac",
    ].join("\n"), { mode: 0o700 });
    const script = `
      import { writeFile } from "node:fs/promises";
      import { runStableQualification } from ${JSON.stringify(join(REPOSITORY_ROOT, "scripts/stable-qualification.ts"))};
      const root = process.env.FIXTURE_ROOT;
      const lane = {
        preflight: async () => { throw new Error("unexpected lane admission"); },
        run: async () => { throw new Error("unexpected lane run"); },
        needsCleanup: () => false,
        cleanup: async () => { throw new Error("unexpected lane cleanup"); },
      };
      try {
        await runStableQualification(["--tag", ${JSON.stringify(TAG)}], {
          platform: "darwin", arch: "arm64", bunVersion: Bun.version,
          withReleaseLease: (_owner, action) => action(),
          environment: { ...${JSON.stringify(MAC_ENV)}, OMP_STABLE_QUALIFICATION_DIR: root, OMP_STABLE_RELAY_SECONDS: "1800" },
          executable: name => process.env.PATH + "/" + name,
          output: async command => {
            if (command.join(" ") === "git rev-parse HEAD") return ${JSON.stringify(COMMIT)};
            await writeFile(root + "/unexpected-admission", command[0]);
            throw new Error("unexpected admission");
          },
          loadMacTarget: async () => {
            await writeFile(root + "/recovered", "yes");
            return { sshDestination: "gwqual@fixture.invalid", sudoPassword: "fixture" };
          },
        }, { windows: lane, androidPush: lane, deviceCloud: lane, createPixelLease: () => (_owner, action) => action() });
        process.exitCode = 2;
      } catch (error) {
        console.log(JSON.stringify({ rejected: error.message }));
      }
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, PATH: bin, FIXTURE_ROOT: root },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("relay evidence");
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted.status).toBe("failed");
    expect(persisted.lanes.relay).toEqual(receipt.lanes.relay);
    expect(persisted.lanes.cleanup).toMatchObject({ status: "passed", attempts: 2, evidence: { gatewayProcesses: 0, gatewayListeners: 0, liveOmpHosts: 0 } });
    expect(await readdir(effects)).toEqual([]);
    expect(await readFile(join(root, "recovered"), "utf8")).toBe("yes");
    expect(await Bun.file(join(root, "unexpected-admission")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

type PreflightFailure = "absent" | "unauthorized" | "ambiguous" | "bun" | "executable" | "pin" | "github" | "mac" | "ssh";

async function preflightFixture(root: string, failure?: PreflightFailure): Promise<StablePreflightRuntime> {
  const pins = parseQualificationPins(await readFile(join(REPOSITORY_ROOT, "UPSTREAM.lock.json"), "utf8"));
  const runtime: StablePreflightRuntime = {
    withReleaseLease: (_owner, action) => action(),
    adb: (serial, args) => runtime.output(["adb", ...(serial === undefined ? [] : ["-s", serial]), ...args]),
    platform: "darwin",
    arch: "arm64",
    bunVersion: failure === "bun" ? "0.0.0" : pins.bunVersion,
    environment: { ...MAC_ENV, OMP_STABLE_QUALIFICATION_DIR: root },
    executable: name => failure === "executable" && name === "cosign" ? null : "/fixture/" + name,
    loadMacTarget: async () => {
      if (failure === "mac") throw new Error("private-host private-credential");
      return { sshDestination: "private-host", sudoPassword: "private-credential" };
    },
    output: async command => {
      const invocation = command.join(" ");
      if (invocation === "adb devices") {
        const devices = failure === "absent" ? "" : failure === "unauthorized" ? "private-device unauthorized" :
          failure === "ambiguous" ? "private-device device\nother-private-device device" : "private-device device";
        return "List of devices attached\n" + devices + "\n";
      }
      if (invocation === "adb -s private-device shell getprop ro.product.model") return "Pixel 10";
      if (invocation === "adb -s private-device shell dumpsys tethering") return "    Upstream wanted: false\n";
      if (invocation === "adb -s private-device shell settings get global zen_mode") return "0\n";
      if (["qualification-mac.example.ts.net", "fixture.invalid"].some(host =>
        invocation === `adb -s private-device shell ping -c 1 -W 2 '${host}' || true`)) return "1 transmitted, 1 received";
      if (invocation === "adb -s private-device shell getprop ro.build.version.release") return "16";
      if (invocation === "adb -s private-device shell getprop ro.build.id") return "fixture-build";
      if (invocation === "adb -s private-device shell dumpsys package com.android.chrome") return "versionName=150.0.1";
      if (command[0] === "security" && command[1] === "find-generic-password") {
        if (failure === "pin") throw new Error("private-device private-credential");
        return "123456";
      }
      if (invocation === "gh auth token") return failure === "github" ? "" : "private-credential";
      if (invocation === "gh api repos/carrythroughsystems/omp-session-gateway") return JSON.stringify({ permissions: { push: true } });
      if (command[0] === "gh" && command[1] === "release" && command[2] === "view") {
        return JSON.stringify({ tagName: command[3], isDraft: false, isPrerelease: command[3] === TAG });
      }
      if (invocation === "git rev-parse HEAD") return COMMIT;
      if (invocation === "git --no-optional-locks status --porcelain") return "";
      if (invocation === "git branch --show-current") return "fixture";
      if (invocation === "git ls-remote --exit-code origin refs/heads/fixture") return COMMIT + "\trefs/heads/fixture";
      if (command[0] === "ssh") {
        if (failure === "ssh") throw new Error("private-host private-credential");
        return MAC_ENV.OMP_STABLE_MAC_MODEL + "\nqualification-mac.example.ts.net\nomp/" + pins.version + "\nguard=absent";
      }
      throw new Error("fixture refuses a non-prerequisite command: " + invocation);
    },
  };
  return runtime;
}

describe("stable qualification read-only admission", () => {
  test("Pixel DNS prerequisite refusal happens before campaign admission, effects or receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "stable-preflight-pixel-path-"));
    try {
      const fixture = await preflightFixture(root);
      let laneAdmissions = 0;
      const lanes = admissionLanes();
      const runtime: StablePreflightRuntime = {
        ...fixture,
        adb: (serial, args) => args[1]?.startsWith("ping ") ? Promise.resolve("ping: unknown host") : fixture.adb(serial, args),
      };
      const lane = { ...lanes.windows, preflight: async () => { laneAdmissions++; } };
      await expect(runStableQualification(["--preflight", "--tag", TAG], runtime, { ...lanes, windows: lane }))
        .rejects.toMatchObject({ name: "AndroidReachabilityPreconditionError", reason: "unreachable" });
      expect(laneAdmissions).toBe(0);
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test.each(["guard=unknown", "guard=refused:f", "guard=refused:" + "61".repeat(401), "guard=invalid:", "guard=passed\nextra"])("Mac admission rejects malformed reboot guard framing without receipts: %s", async guardLine => {
    const root = await mkdtemp(join(tmpdir(), "stable-preflight-guard-protocol-"));
    try {
      const fixture = await preflightFixture(root);
      const runtime: StablePreflightRuntime = {
        ...fixture,
        output: async command => {
          const result = await fixture.output(command);
          return command[0] === "ssh" ? result.replace("guard=absent", guardLine) : result;
        },
      };
      const error = await rejectionMessage(runStableQualification(["--tag", TAG], runtime, admissionLanes()));
      expect(error).toContain("retained Mac SSH");
      expect(error).not.toContain(guardLine);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test.skipIf(process.platform !== "darwin" || process.arch !== "arm64").each(["busy", "not executable", "directory"] as const)("Mac admission reboot guard %s refuses without lane effects or receipts", async kind => {
    const root = await mkdtemp(join(tmpdir(), "stable-preflight-guard-"));
    const home = join(root, "home");
    const guard = join(home, ".config", "omp-qualification", "reboot-guard");
    const receipts = join(root, "receipts");
    const busy = "runner busy\n" + "x".repeat(500);
    try {
      await mkdir(join(home, ".config", "omp-qualification"), { recursive: true });
      if (kind === "directory") await mkdir(guard);
      else await writeFile(guard, "#!/bin/sh\nprintf '%s' " + "'" + busy + "'\nexit 1\n", { mode: kind === "busy" ? 0o700 : 0o600 });
      const fixture = await preflightFixture(receipts);
      let laneCalls = 0;
      const refusal = async (): Promise<never> => { laneCalls += 1; throw new Error("unexpected lane effect"); };
      const lane: ExternalLaneModule = { preflight: refusal, run: refusal, cleanup: refusal, needsCleanup: () => { laneCalls += 1; return true; } };
      const runtime: StablePreflightRuntime = {
        ...fixture,
        output: async command => {
          if (command[0] !== "ssh") return fixture.output(command);
          const fixtures = "bun() { printf '%s\\n' \"$PROBE_BUN\"; }\ntailscale() { printf '%s\\n' '{\"BackendState\":\"Running\",\"Self\":{\"DNSName\":\"fixture.invalid.\"}}'; }\nifconfig() { printf '%s\\n' 'inet6 fd7a:115c:a1e0::1'; }\nomp() { printf 'omp/18.1.20\\n'; }\nexport -f bun tailscale ifconfig omp\neval \"$1\"";
          const child = Bun.spawn(["/bin/bash", "-c", fixtures, "probe-fixture", command.at(-1)!], {
            env: { HOME: home, PATH: "/usr/bin:/bin", PROBE_BUN: fixture.bunVersion },
            stdin: "ignore", stdout: "pipe", stderr: "pipe",
          });
          const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
          if (code !== 0) throw new Error(stderr);
          return stdout.trim();
        },
      };
      const error = await rejectionMessage(runStableQualification(["--tag", TAG], runtime, {
        windows: lane, androidPush: lane, deviceCloud: lane, createPixelLease: () => createPixelLease(() => {}),
      }));
      expect(error).toBe("Stable preflight: " + (kind === "busy" ? "the host's reboot guard refused: " + busy.slice(0, 400) : "the host's reboot guard must be a regular, owner-executable file: " + guard));
      expect(laneCalls).toBe(0);
      expect(await Bun.file(join(receipts, "stable-qualification.json")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test.each([
    ["    Upstream wanted: true\n", "0", "tethering"],
    ["    wlan1 - TetheredState - lastError = 0\n    Upstream wanted: false\n", "0", "tethering"],
    ["    ncm0 - TetheredState - lastError = 0\n    Upstream wanted: false\n", "0", "tethering"],
    ["    bt-pan - TetheredState - lastError = 0\n    Upstream wanted: false\n", "0", "tethering"],
    ["Tethering: unknown output\n", "0", "tethering"],
    ["probe-failure", "0", "tethering"],
    ["    Upstream wanted: false\n", "1", "Do Not Disturb"],
    ["    Upstream wanted: false\n", "null", "Do Not Disturb"],
    ["    Upstream wanted: false\n", "probe-failure", "Do Not Disturb"],
  ] as const)("unsafe tethering/notification state refuses before provider lookup, lane admission or receipts: %s %s", async (tethering, zenMode, diagnostic) => {
    const root = await mkdtemp(join(tmpdir(), "stable-tethering-refusal-"));
    try {
      const fixture = await preflightFixture(root);
      let providerLookups = 0, laneAdmissions = 0;
      const runtime: StablePreflightRuntime = {
        ...fixture,
        loadMacTarget: async options => { providerLookups += 1; return fixture.loadMacTarget(options); },
        adb: async (serial, args) => {
          if (args.join(" ") === "shell dumpsys tethering") {
            if (tethering === "probe-failure") throw new Error("synthetic-private-device probe failure");
            return tethering;
          }
          if (args.join(" ") === "shell settings get global zen_mode") {
            if (zenMode === "probe-failure") throw new Error("synthetic-private-device settings failure");
            return zenMode;
          }
          return fixture.adb(serial, args);
        },
      };
      const fixtureLanes = admissionLanes();
      const refusal = <T extends object>(lane: ExternalLaneModule<T>): ExternalLaneModule<T> => ({
        ...lane,
        preflight: async () => { laneAdmissions += 1; throw new Error("fixture refuses external admission"); },
      });
      const lanes = { ...fixtureLanes, windows: refusal(fixtureLanes.windows), androidPush: refusal(fixtureLanes.androidPush), deviceCloud: refusal(fixtureLanes.deviceCloud) };
      const error = await rejectionMessage(runStableQualification(["--tag", TAG], runtime, lanes));
      expect(error).toContain(diagnostic);
      expect(error).not.toContain("synthetic-private-device");
      expect({ providerLookups, laneAdmissions }).toEqual({ providerLookups: 0, laneAdmissions: 0 });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["absent", "authorized Android"],
    ["unauthorized", "authorized Android"],
    ["ambiguous", "authorized Android"],
    ["bun", "local Bun"],
    ["executable", "cosign"],
    ["pin", "Keychain"],
    ["github", "GitHub CLI"],
    ["mac", "configured Mac target"],
    ["ssh", "retained Mac SSH"],
  ] as const)("%s prerequisite failure stops normal qualification before receipts or dispatch", async (failure, diagnostic) => {
    const root = await mkdtemp(join(tmpdir(), "stable-preflight-failure-"));
    try {
      const runtime = await preflightFixture(root, failure);
      const error = await rejectionMessage(runStableQualification(["--tag", TAG], runtime, admissionLanes()));
      expect(error).toContain(diagnostic);
      expect(error).not.toMatch(/private-(?:device|host|credential)/u);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["missing", "MISSING"],
    ["too old", "omp/18.1.19"],
    ["prerelease", "omp/18.4.8-rc.1"],
    ["malformed", "omp/18.4.8 private-diagnostic"],
  ] as const)("%s stock OMP refuses before lane admission, cleanup or receipts", async (_reason, banner) => {
    const root = await mkdtemp(join(tmpdir(), "stable-preflight-omp-"));
    try {
      const fixture = await preflightFixture(root);
      const pins = parseQualificationPins(await readFile(join(REPOSITORY_ROOT, "UPSTREAM.lock.json"), "utf8"));
      let laneCalls = 0;
      const refusal = async (): Promise<never> => { laneCalls += 1; throw new Error("unexpected lane effect"); };
      const lane: ExternalLaneModule = { preflight: refusal, run: refusal, cleanup: refusal, needsCleanup: () => { laneCalls += 1; return true; } };
      const runtime: StablePreflightRuntime = {
        ...fixture,
        output: command => command[0] === "ssh"
          ? Promise.resolve(MAC_ENV.OMP_STABLE_MAC_MODEL + "\nqualification-mac.example.ts.net\n" + banner + "\nguard=absent")
          : fixture.output(command),
      };
      const error = await rejectionMessage(runStableQualification(["--tag", TAG], runtime, {
        windows: lane, androidPush: lane, deviceCloud: lane, createPixelLease: () => createPixelLease(() => {}),
      }));
      expect(error).toContain("stock OMP >=18.1.20");
      expect(error).toContain("bun add --global --exact @oh-my-pi/pi-coding-agent@" + pins.version);
      expect(laneCalls).toBe(0);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stock OMP probe rejects additional output without leaking it or creating receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "stable-preflight-omp-output-"));
    try {
      const fixture = await preflightFixture(root);
      const runtime: StablePreflightRuntime = {
        ...fixture,
        output: async command => (await fixture.output(command)) + (command[0] === "ssh" ? "\nprivate-diagnostic" : ""),
      };
      const error = await rejectionMessage(runStableQualification(["--tag", TAG], runtime, admissionLanes()));
      expect(error).toContain("retained Mac SSH");
      expect(error).not.toContain("private-diagnostic");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stock OMP at the compatibility minimum passes read-only admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "stable-preflight-omp-minimum-"));
    try {
      const fixture = await preflightFixture(root);
      const runtime: StablePreflightRuntime = {
        ...fixture,
        output: command => command[0] === "ssh"
          ? Promise.resolve(MAC_ENV.OMP_STABLE_MAC_MODEL + "\nqualification-mac.example.ts.net\nomp/18.1.20\nguard=absent")
          : fixture.output(command),
      };
      expect((await runStableQualification(["--preflight", "--tag", TAG], runtime, admissionLanes())).status).toBe("preflight-passed");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["windows", "androidPush", "deviceCloud"] as const)("%s lane admission failure stops normal qualification before receipts", async lane => {
    const root = await mkdtemp(join(tmpdir(), "stable-preflight-lane-"));
    try {
      const runtime = await preflightFixture(root);
      const error = await rejectionMessage(runStableQualification(["--tag", TAG], runtime, admissionLanes(lane)));
      expect(error).toContain("lane admission failed");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--preflight accepts exact candidate arguments but never creates qualification evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "stable-preflight-pass-"));
    try {
      const runtime = await preflightFixture(root);
      const report = await runStableQualification(["--preflight", "--tag", TAG, "--previous-tag", PREVIOUS_TAG], runtime, admissionLanes());
      expect(report.status).toBe("preflight-passed");
      expect(report.notProven).toEqual(expect.arrayContaining([
        expect.stringContaining("signatures"),
        expect.stringContaining("dispatch"),
      ]));
      expect(JSON.stringify(report)).not.toMatch(/private-(?:device|host|credential)/u);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("Mac admission ignores a sysctl planted in the account's Bun directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "stable-preflight-host-"));
    const home = join(root, "home");
    const bin = join(home, ".bun", "bin");
    const planted = join(root, "planted-called");
    const measured = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "hw.model"], { stdout: "pipe", stderr: "pipe" });
    expect(measured.exitCode).toBe(0);
    const model = Buffer.from(measured.stdout).toString().trim();
    try {
      await mkdir(bin, { recursive: true });
      for (const command of ["sysctl", "uname", "sw_vers"]) {
        await writeFile(join(bin, command), "#!/bin/sh\nprintf '%s\\n' Mac99999,1\n: >\"$PLANTED_CALLED\"\n", { mode: 0o700 });
      }
      const runtime = await preflightFixture(join(root, "receipts"));
      const pins = parseQualificationPins(await readFile(join(REPOSITORY_ROOT, "UPSTREAM.lock.json"), "utf8"));
      let probeBun = pins.bunVersion;
      // Test-only shell functions provide the unavailable tailnet and pinned Bun. Hardware is real.
      const fixtures = "bun() { printf '%s\\n' \"$PROBE_BUN\"; }\ntailscale() { printf '%s\\n' '{\"BackendState\":\"Running\",\"Self\":{\"DNSName\":\"fixture.invalid.\"}}'; }\nifconfig() { printf '%s\\n' 'inet6 fd7a:115c:a1e0::1'; }\nomp() { printf 'omp/18.1.20\\n'; }\nexport -f bun tailscale ifconfig omp\neval \"$1\"";
      const hostRuntime: StablePreflightRuntime = {
        ...runtime,
        environment: { ...runtime.environment, OMP_STABLE_MAC_MODEL: model },
        output: async command => {
          if (command[0] !== "ssh") return runtime.output(command);
          const child = Bun.spawn(["/bin/bash", "-c", fixtures, "probe-fixture", command.at(-1)!], {
            env: { HOME: home, PATH: bin + ":/usr/bin:/bin", PROBE_BUN: probeBun, PLANTED_CALLED: planted },
            stdin: "ignore", stdout: "pipe", stderr: "pipe",
          });
          const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
          if (code !== 0) throw new Error(stderr);
          return stdout.trim();
        },
      };
      expect((await runStableQualification(["--preflight", "--tag", TAG], hostRuntime, admissionLanes())).status).toBe("preflight-passed");
      expect(await Bun.file(planted).exists()).toBe(false);
      await expect(stat(join(home, "qual"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(runStableQualification(["--preflight", "--tag", TAG], {
        ...hostRuntime, environment: { ...hostRuntime.environment, OMP_STABLE_MAC_MODEL: "Mac99999,1" },
      }, admissionLanes())).rejects.toThrow("Mac hardware mismatch: expected Mac99999,1, measured " + model);
      probeBun = "0.0.0";
      await expect(runStableQualification(["--preflight", "--tag", TAG], hostRuntime, admissionLanes())).rejects.toThrow("retained Mac SSH");
      expect(await Bun.file(join(root, "receipts", "stable-qualification.json")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preflight still rejects missing values, unknown flags and a different predecessor before probing", async () => {
    let probes = 0;
    const runtime = await preflightFixture("/unused-fixture");
    const guarded = { ...runtime, output: async () => { probes += 1; throw new Error("unexpected probe"); } };
    for (const argv of [
      ["--preflight"],
      ["--preflight", "--tag"],
      ["--preflight", "--tag", TAG, "--previous-tag"],
      ["--preflight", "--tag", TAG, "--previous-tag", "v0.2.1"],
      ["--preflight", "--tag", TAG, "--dispatch"],
    ]) {
      await expect(runStableQualification(argv, guarded, admissionLanes())).rejects.toThrow();
    }
    expect(probes).toBe(0);
  });
});

const lifecycleEvidence: OmpLifecycleEvidence = {
  newGeneration: { sameInstance: true, generationDelta: 1, staleRejected: true, liveLaunches: 2, noStore: true },
  fork: { sameInstance: true, generationDelta: 1, syntheticMessages: 2, staleRejected: true, liveLaunches: 2, noStore: true },
  resumed: { newInstance: true, generation: 1, sameLabel: true, liveLaunches: 2, noStore: true, revocations: 2 },
};

function availabilityReceipt() {
  const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
  receipt.status = "failed";
  receipt.macHost = MAC_ENV.OMP_STABLE_MAC_HOST;
  receipt.candidate = { tag: TAG, sourceCommit: COMMIT, archiveSha256: "b".repeat(64) };
  receipt.predecessor = { tag: PREVIOUS_TAG, sourceCommit: "c".repeat(40), archiveSha256: "d".repeat(64) };
  for (const lane of Object.values(receipt.lanes)) Object.assign(lane, { status: "passed", attempts: 1, evidence: { proven: true } });
  for (const name of ["windows", "androidPush", "deviceCloud"] as const) {
    const epoch = name === "deviceCloud" ? "11111111-2222-4333-8444-555555555555" : `epoch-${name}`;
    receipt.lanes[name].evidence = { progress: { epoch, cleanupRequired: false }, result: { passed: true } };
    receipt.lanes[`${name}Cleanup`].evidence = { epoch };
  }
  receipt.lanes.deviceCloud.status = "failed";
  receipt.lanes.deviceCloud.evidence = {
    progress: { epoch: "11111111-2222-4333-8444-555555555555", cleanupRequired: false },
    availabilityHold: [{
      kind: "device-cloud-availability", stage: "allocation", target: "ipad", vendors: ["testingbot"],
      reason: "pinned-pool-busy", waitedMs: 600_000, epoch: "11111111-2222-4333-8444-555555555555",
    }],
  };
  receipt.lanes.ompPublication.evidence = { published: true, revoked: true, lifecycle: structuredClone(lifecycleEvidence) };
  const relay = passedRelayReceipt();
  receipt.startedAt = relay.startedAt;
  receipt.lanes.relay = relay.lanes.relay;
  return receipt;
}

const resumeModules: StableQualificationLaneModules = (() => {
  const lane: ExternalLaneModule = {
    preflight: async () => {}, run: async () => { throw new Error("not a live fixture"); }, cleanup: async () => ({}),
    needsCleanup: value => typeof value !== "object" || value === null || !("cleanupRequired" in value) || value.cleanupRequired !== false,
  };
  return { windows: lane, androidPush: lane, deviceCloud: lane, createPixelLease: () => createPixelLease(() => {}) };
})();
const resumeIdentity = { tag: TAG, previousTag: PREVIOUS_TAG, orchestratorCommit: COMMIT, macHost: MAC_ENV.OMP_STABLE_MAC_HOST };

describe("explicit same-receipt cloud resumption", () => {
  test("accepts only the explicit option, separate from preflight", () => {
    expect(parseStableQualificationArgs(["--tag", TAG, "--resume-device-cloud"], MAC_ENV).resumeDeviceCloud).toBe(true);
    expect(() => parseStableQualificationArgs(["--tag", TAG, "--preflight", "--resume-device-cloud"], MAC_ENV)).toThrow("not --preflight");
    expect(() => parseStableQualificationArgs(["--tag", TAG, "--resume-device-cloud", "--resume-device-cloud"], MAC_ENV)).toThrow("only once");
  });
  test("validates a clean failed hold without changing any passed evidence", () => {
    const receipt = availabilityReceipt();
    const before = structuredClone(receipt);
    expect(assertDeviceCloudResumeEligible(receipt, resumeIdentity, resumeModules)).toMatchObject([{ stage: "allocation", target: "ipad" }]);
    expect(receipt).toEqual(before);
  });
  test.each(["dirty", "stale cleanup", "ordinary failure", "foreign commit", "foreign candidate", "foreign predecessor", "foreign host", "missing lifecycle", "other failed lane"] as const)(
    "refuses %s before admission or effects", async variant => {
      const receipt = availabilityReceipt();
      if (variant === "dirty") receipt.lanes.deviceCloud.evidence!.progress = { epoch: "11111111-2222-4333-8444-555555555555", cleanupRequired: true };
      if (variant === "stale cleanup") receipt.lanes.deviceCloudCleanup.evidence = { epoch: "another" };
      if (variant === "ordinary failure") delete receipt.lanes.deviceCloud.evidence!.availabilityHold;
      if (variant === "foreign commit") receipt.orchestratorCommit = "f".repeat(40);
      if (variant === "foreign candidate") receipt.candidate!.tag = "v0.7.7-prealpha.999";
      if (variant === "foreign predecessor") receipt.predecessor!.tag = "v0.0.1";
      if (variant === "foreign host") receipt.macHost = "other@fixture.invalid";
      if (variant === "missing lifecycle") receipt.lanes.ompPublication.evidence = { published: true };
      if (variant === "other failed lane") receipt.lanes.android.status = "failed";
      expect(() => assertDeviceCloudResumeEligible(receipt, resumeIdentity, resumeModules)).toThrow();
      const root = await mkdtemp(join(tmpdir(), "stable-cloud-resume-refusal-"));
      try {
        await writeFile(join(root, "stable-qualification.json"), JSON.stringify(receipt));
        const fixture = await preflightFixture(root);
        let calls = 0;
        const runtime: StablePreflightRuntime = { ...fixture, output: async args => {
          if (args.join(" ") === "git rev-parse HEAD") return COMMIT;
          calls += 1; throw new Error("must refuse before admission");
        } };
        await expect(runStableQualification(["--tag", TAG, "--resume-device-cloud"], runtime, resumeModules)).rejects.toThrow();
        expect(calls).toBe(0);
        expect(JSON.parse(await readFile(join(root, "stable-qualification.json"), "utf8"))).toEqual(receipt);
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  );
  test("only cloud and cleanup advance; passed publication and expensive lanes are reused unchanged", async () => {
    const receipt = availabilityReceipt();
    const before = structuredClone(receipt.lanes);
    const identity: ExternalLaneIdentity = {
      tag: TAG, previousTag: PREVIOUS_TAG, orchestratorCommit: COMMIT, receiptRoot: "/fixture",
      candidate: { ...receipt.candidate!, archivePath: "/candidate.tar" }, predecessor: { ...receipt.predecessor!, archivePath: "/previous.tar" },
      omp: { bunVersion: "1.4.0", version: "18.12.3", sourceCommit: "e".repeat(40), sourceTree: "f".repeat(40), nativeTarballSha256: "0".repeat(64), nativeBinarySha256: "1".repeat(64) },
    };
    const module: ExternalLaneModule = {
      ...resumeModules.deviceCloud,
      run: async ({ checkpoint }) => { await checkpoint({ epoch: "new-cloud-attempt", cleanupRequired: false }); return { passed: true }; },
      cleanup: async ({ progress }) => ({ epoch: (progress as { epoch: string }).epoch, restored: true }),
    };
    assertDeviceCloudResumeEligible(receipt, resumeIdentity, resumeModules);
    await runExternalLane(receipt, "deviceCloud", async () => {}, module, { identity, pixel: createPixelLease(() => {}) });
    for (const name of ["debian", "macos", "ompPublication", "android", "androidPush", "windows", "relay"] as const) {
      await executeReceiptLane(receipt, name, async () => {}, async () => { throw new Error("passed proof must not rerun"); });
      expect(receipt.lanes[name]).toEqual(before[name]);
    }
    expect(receipt.lanes.deviceCloud.attempts).toBe(2);
    expect(receipt.lanes.deviceCloudCleanup.attempts).toBe(2);
    expect(receipt.lanes.deviceCloud.evidence?.availabilityHold).toBeUndefined();
  });
  test.each(["prepareMacFixture", "waitForPublishedSession", "verifyLaunchContracts", "startTunnel", "teardown", "protected-file guard"] as const)(
    "%s failure after consuming a hold cannot retain same-receipt eligibility", async stage => {
      const receipt = availabilityReceipt();
      const publication = structuredClone(receipt.lanes.ompPublication);
      const root = await mkdtemp(join(tmpdir(), "stable-cloud-consumed-"));
      const path = join(root, "receipt.json");
      const persist = createReceiptPersister(path, receipt);
      try {
        await persist();
        const failure = await withConsumedDeviceCloudHold(receipt, persist, async () => {
          // Every setup/teardown callback is inside this production consumption boundary.
          const onDisk = JSON.parse(await readFile(path, "utf8"));
          expect(onDisk.lanes.deviceCloud.evidence.availabilityHold).toBeUndefined();
          if (stage === "teardown" || stage === "protected-file guard") {
            // Even an earlier newly typed hold may not survive an ordinary finally-path error.
            receipt.lanes.deviceCloud.evidence!.availabilityHold = parseDeviceCloudHoldSet(availabilityReceipt().lanes.deviceCloud.evidence!.availabilityHold);
            await persist();
            throw new AggregateError([
              new DeviceCloudAvailabilityHold(parseDeviceCloudHoldSet(receipt.lanes.deviceCloud.evidence!.availabilityHold)[0]!),
              new Error(`${stage} failed`),
            ]);
          }
          throw new Error(`${stage} failed`);
        }).catch((error: unknown) => error);
        expect(recognizedDeviceCloudOutcome(failure)).toBeUndefined();
        expect(receipt.lanes.deviceCloud.evidence!.availabilityHold).toBeUndefined();
        expect(JSON.parse(await readFile(path, "utf8")).lanes.deviceCloud.evidence.availabilityHold).toBeUndefined();
        expect(receipt.lanes.ompPublication).toEqual(publication);
        expect(() => assertDeviceCloudResumeEligible(receipt, resumeIdentity, resumeModules)).toThrow();
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  );
  test.each([2, 3])("a fresh all-hold admission failure records all %i leaves on the same receipt", async count => {
    const receipt = availabilityReceipt();
    const before = structuredClone(receipt.lanes);
    const holds = (["iphone", "ipad", "android"] as const).slice(3 - count).map(target => new DeviceCloudAvailabilityHold({
      kind: "device-cloud-availability", stage: "preflight", target, vendors: ["testingbot"], reason: "pinned-pool-busy", waitedMs: 0,
    }));
    const root = await mkdtemp(join(tmpdir(), "stable-cloud-fresh-holds-"));
    const path = join(root, "receipt.json"), outcomePath = join(root, "outcome.json");
    const persist = createReceiptPersister(path, receipt);
    try {
      const error = await withConsumedDeviceCloudHold(receipt, persist, async () => {
        throw await recordDeviceCloudCampaignFailure(receipt, new AggregateError(holds), resumeIdentity, persist, resumeModules, outcomePath);
      }).catch((error: unknown) => error);
      expect(recognizedDeviceCloudOutcome(error)?.availabilityHolds).toHaveLength(count);
      expect(assertDeviceCloudResumeEligible(receipt, resumeIdentity, resumeModules)).toHaveLength(count);
      expect((await readDeviceCloudOutcomeFile(outcomePath)).availabilityHolds).toEqual(holds.map(hold => hold.evidence));
      for (const name of Object.keys(before) as (keyof typeof before)[]) if (name !== "deviceCloud") expect(receipt.lanes[name]).toEqual(before[name]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test.each(["ordinary", "two holds", "three holds"] as const)("the real resume entry consumes eligibility before %s admission", async kind => {
    const root = await mkdtemp(join(tmpdir(), "stable-cloud-resume-admission-"));
    const path = join(root, "stable-qualification.json");
    const receipt = availabilityReceipt(), publication = structuredClone(receipt.lanes.ompPublication);
    try {
      await writeFile(path, JSON.stringify(receipt));
      const runtime = await preflightFixture(root);
      const count = kind === "two holds" ? 2 : 3;
      const holds = (["iphone", "ipad", "android"] as const).slice(3 - count).map(target => new DeviceCloudAvailabilityHold({
        kind: "device-cloud-availability", stage: "preflight", target, vendors: ["testingbot"], reason: "pinned-pool-busy", waitedMs: 0,
      }));
      let admitted = 0;
      const modules = { ...resumeModules, deviceCloud: { ...resumeModules.deviceCloud, preflight: async () => {
        admitted += 1;
        const consumed = JSON.parse(await readFile(path, "utf8"));
        expect(consumed.lanes.deviceCloud.evidence.availabilityHold).toBeUndefined();
        if (kind === "ordinary") throw new Error("ordinary admission diagnostic");
        throw new AggregateError(holds);
      } } };
      const error = await runStableQualification(["--tag", TAG, "--resume-device-cloud"], runtime, modules).catch((error: unknown) => error);
      expect(admitted).toBe(1);
      const saved = validateStableQualificationReceipt(JSON.parse(await readFile(path, "utf8")), TAG, COMMIT, PREVIOUS_TAG);
      expect(saved.lanes.ompPublication).toEqual(publication);
      if (kind === "ordinary") {
        expect(recognizedDeviceCloudOutcome(error)).toBeUndefined();
        expect(saved.lanes.deviceCloud.evidence!.availabilityHold).toBeUndefined();
        expect(() => assertDeviceCloudResumeEligible(saved, resumeIdentity, resumeModules)).toThrow();
      } else {
        expect(recognizedDeviceCloudOutcome(error)?.availabilityHolds).toHaveLength(count);
        expect(assertDeviceCloudResumeEligible(saved, resumeIdentity, resumeModules)).toHaveLength(count);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("an outcome-file failure is diagnostic and cannot re-establish a receipt hold", async () => {
    const receipt = availabilityReceipt();
    const hold = new DeviceCloudAvailabilityHold(parseDeviceCloudHoldSet(receipt.lanes.deviceCloud.evidence!.availabilityHold)[0]!);
    const root = await mkdtemp(join(tmpdir(), "stable-cloud-outcome-refusal-"));
    try {
      const error = await recordDeviceCloudCampaignFailure(receipt, hold, resumeIdentity, async () => {}, resumeModules, root);
      expect(recognizedDeviceCloudOutcome(error)).toBeUndefined();
      expect(receipt.lanes.deviceCloud.evidence!.availabilityHold).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("publication lifecycle receipt", () => {
  test("an availability-only live failure finishes the real lifecycle before reporting its hold", async () => {
    const receipt = availabilityReceipt();
    const lane = receipt.lanes.ompPublication;
    lane.status = "running"; lane.evidence = { published: true };
    const order: string[] = [];
    const hold = new DeviceCloudAvailabilityHold(parseDeviceCloudHoldSet(receipt.lanes.deviceCloud.evidence!.availabilityHold)[0]!);
    const error = await finishLiveQualification([hold], lane, async () => {}, async () => { order.push("relay stopped"); }, async () => {
      order.push("lifecycle"); return structuredClone(lifecycleEvidence);
    }).catch((error: unknown) => error);
    expect(order).toEqual(["relay stopped", "lifecycle"]);
    expect(deviceCloudHolds(error)).toHaveLength(1);
    expect(lane).toMatchObject({ status: "passed", evidence: { revoked: true, lifecycle: lifecycleEvidence } });
    const failed = await finishLiveQualification([hold], lane, async () => {}, async () => {}, async () => { throw new Error("lifecycle failed"); }).catch((error: unknown) => error);
    expect(deviceCloudHolds(failed)).toBeUndefined();
    expect(lane).toMatchObject({ status: "failed" });
  });
  test("cloud-only resume preserves passed publication evidence byte-for-byte", async () => {
    const receipt = availabilityReceipt();
    const lane = receipt.lanes.ompPublication;
    const before = structuredClone(lane);
    await finishLiveQualification([], lane, async () => { throw new Error("publication must not persist again"); }, async () => {}, async () => { throw new Error("lifecycle must not rerun"); }, true);
    expect(lane).toEqual(before);
  });

  test("adds lifecycle evidence without changing the receipt version or earlier publication observations", async () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    const lane = receipt.lanes.ompPublication;
    lane.evidence = { published: true, generation: 1, modes: [{ status: 200 }] };
    const checkpoints: string[] = [];
    await completeOmpPublicationLifecycle(lane, async () => { checkpoints.push(lane.status); }, async () => lifecycleEvidence);
    expect(checkpoints).toEqual(["running", "passed"]);
    expect(receipt.schemaVersion).toBe(3);
    expect(lane.evidence).toEqual({ published: true, generation: 1, modes: [{ status: 200 }], revoked: true, lifecycle: lifecycleEvidence });
    expect(lane.completedAt).toBeDefined();
  });

  test("an interrupted lifecycle checkpoint stays non-passed and resumes by rerunning the whole step", async () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    const lane = receipt.lanes.ompPublication;
    lane.evidence = { published: true, lifecycle: lifecycleEvidence, revoked: true };
    let interrupted: typeof lane | undefined;
    await expect(completeOmpPublicationLifecycle(lane, async () => {
      if (lane.status === "running") interrupted = structuredClone(lane);
    }, async () => { throw new Error("private terminal diagnostic"); })).rejects.toThrow("OMP publication lifecycle failed");
    expect(lane.status).toBe("failed");
    expect(lane.error).toBe("OMP publication lifecycle failed");
    expect(lane.completedAt).toBeUndefined();
    if (interrupted === undefined) throw new Error("missing interruption checkpoint");
    expect(interrupted.status).toBe("running");
    expect(interrupted.evidence).toEqual({ published: true });
    let reruns = 0;
    await completeOmpPublicationLifecycle(interrupted, async () => {}, async () => { reruns += 1; return lifecycleEvidence; });
    expect(reruns).toBe(1);
    expect(interrupted.status).toBe("passed");
    expect(interrupted.evidence?.lifecycle).toEqual(lifecycleEvidence);
    expect(JSON.stringify(lane)).not.toContain("private terminal diagnostic");
    // A runner failure names its fixed step, so the receipt says where the lifecycle stopped.
    await expect(completeOmpPublicationLifecycle(lane, async () => {}, async () => { throw new OmpLifecycleFailure("fork"); }))
      .rejects.toThrow("OMP lifecycle fork failed");
    expect(lane.error).toBe("OMP lifecycle fork failed");
  });
});

describe("lifecycle HTTP observations", () => {
  test("waits for the expected rotated card rather than accepting the previous generation", async () => {
    let lists = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ sessions: [{
      instanceId: "synthetic-instance", generation: ++lists === 1 ? 1 : 2, cwdLabel: "synthetic-label",
      canView: true, canControl: true, model: "synthetic-model",
    }] }, { headers: { "cache-control": "no-store" } }) });
    try {
      const session = await waitForPublishedSession(server.url.origin, "synthetic-label", { timeoutMs: 2_000, matches: card => card.generation === 2 });
      expect(session.generation).toBe(2);
      expect(lists).toBe(2);
    } finally { server.stop(true); }
  });

  test.each(["wrong-status", "wrong-code", "capability-field", "cacheable"] as const)("rejects a stale launch with %s", async fault => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({
      code: fault === "wrong-code" ? "mode_unavailable" : "generation_mismatch",
      ...(fault === "capability-field" ? { capability: "" } : {}),
    }, { status: fault === "wrong-status" ? 200 : 409, headers: fault === "cacheable" ? {} : { "cache-control": "no-store" } }) });
    try {
      await expect(verifyLaunchContracts(server.url.origin, { instanceId: "synthetic-instance", generation: 1 }, "stale")).rejects.toThrow("OMP launch contract failed");
    } finally { server.stop(true); }
  });

  test("accepts both stale role refusals and never treats an HTTP error as revocation", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => request.method === "POST"
      ? Response.json({ code: "generation_mismatch" }, { status: 409, headers: { "cache-control": "no-store" } })
      : Response.json({ code: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } }) });
    try {
      const evidence = await verifyLaunchContracts(server.url.origin, { instanceId: "synthetic-instance", generation: 1 }, "stale");
      expect(evidence.modes).toEqual(["view", "control"].map(mode => ({ mode, status: 409, keys: ["code"], valuePresent: false, noStore: true })));
      await expect(waitForRevocation(server.url.origin, "synthetic-label", 10)).rejects.toThrow("did not revoke before the deadline");
    } finally { server.stop(true); }
  });

  test.each([
    ["publication", (origin: string) => waitForPublishedSession(origin, "synthetic-label", { timeoutMs: 20 }), "did not publish before the deadline"],
    ["revocation", (origin: string) => waitForRevocation(origin, "synthetic-label", 20), "did not revoke before the deadline"],
  ] as const)("a %s read still pending at the deadline fails as that deadline", async (_kind, wait, message) => {
    // The list answers only after the wait has failed, so the read is always pending at the deadline.
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => {
      await held;
      return Response.json({ sessions: [] }, { headers: { "cache-control": "no-store" } });
    } });
    try {
      await expect(wait(server.url.origin)).rejects.toThrow(message);
    } finally { release(); server.stop(true); }
  });
});

describe("shared OMP qualification pin", () => {
  test("rejects missing pins, malformed native hashes, and a pre-mainline runtime", async () => {
    const lock = JSON.parse(await readFile(join(REPOSITORY_ROOT, "UPSTREAM.lock.json"), "utf8"));
    for (const value of [
      {},
      { ...lock, tree: "not-a-tree" },
      { ...lock, packageVersion: "18.1.19" },
      { ...lock, darwinArm64Native: { ...lock.darwinArm64Native, binarySha256: "not-a-digest" } },
    ]) {
      expect(() => parseQualificationPins(JSON.stringify(value))).toThrow("pin is invalid");
    }
  });
});

test("Mac evidence follows the exact OMP pin and rejects a stale build", async () => {
  const pins = parseQualificationPins(await readFile(join(REPOSITORY_ROOT, "UPSTREAM.lock.json"), "utf8"));
  const candidate = { tag: TAG, sourceCommit: COMMIT, archiveSha256: "b".repeat(64) };
  const output = [
    `release-info commit:                   ${candidate.sourceCommit}`,
    candidate.archiveSha256,
    "doctor                                 17/17 true",
    JSON.stringify({ version: pins.version, sourceCommit: pins.sourceCommit, sourceTree: pins.sourceTree, nativeSha256: pins.nativeBinarySha256 }),
  ].join("\n");
  assertMacBuildOutput(output, candidate, pins);
  expect(() => assertMacBuildOutput(output.replace(pins.version, "17.4.1"), candidate, pins)).toThrow("version");
  expect(() => assertMacBuildOutput(output.replace(pins.nativeBinarySha256, "c".repeat(64)), candidate, pins)).toThrow("nativeSha256");
  expect(() => assertMacBuildOutput(output.replace(pins.sourceTree, "d".repeat(40)), candidate, pins)).toThrow("sourceTree");
  expect(() => assertMacBuildOutput(output.replace("17/17 true", "16/17 true"), candidate, pins)).toThrow("doctor");
});

async function macLifecycleFixture(model = MAC_ENV.OMP_STABLE_MAC_MODEL, version = "27.0.1") {
  const pins = parseQualificationPins(await readFile(join(REPOSITORY_ROOT, "UPSTREAM.lock.json"), "utf8"));
  const candidate = { tag: TAG, sourceCommit: COMMIT, archiveSha256: "b".repeat(64) };
  const output = [
    `host:                                 macOS ${version} arm64`,
    `hardware:                              ${model}`,
    "release-info commit:                   " + candidate.sourceCommit,
    candidate.archiveSha256,
    "doctor                                 18/18 true",
    "doctor false checks                    (none)",
    "token bytes in bundle:                 0",
    "login in bundle:                       0",
    "forged header, real login allowed:     200",
    "   backend at tailnet address:            no HTTP answer (curl exit 7)",
    "   backend at ssh address:                no HTTP answer (curl exit 56)",
    "guest reboot changed: yes",
    "console login: yes",
    "gateway returned after: 1 second",
    "readiness token preserved: yes",
    "23/23 invariants PASS",
    JSON.stringify({ version: pins.version, sourceCommit: pins.sourceCommit, sourceTree: pins.sourceTree, nativeSha256: pins.nativeBinarySha256 }),
  ].join("\n");
  return { pins, candidate, output };
}

test.each([["Mac14,3", "26.6.1"], ["Mac17,14", "27.0.1"], ["VirtualMac2,1", "27.0.1"]])("Mac %s lifecycle persists measured schema-3 evidence and refuses failures", async (model, version) => {
  const { pins, candidate, output } = await macLifecycleFixture(model, version);
  const evidence = {
    hardware: model, doctor: "18/18", rollbackInvariants: "23/23", os: `macOS ${version} arm64`,
    guestRebootChanged: true, consoleLogin: true, readinessPreserved: true,
  };
  expect(assertMacLifecycleOutput(output, candidate, pins, model)).toEqual(evidence);
  expect(() => assertMacLifecycleOutput(output.replace("23/23", "22/23"), candidate, pins, model)).toThrow("rollback");
  const exposed = output.replace("no HTTP answer (curl exit 56)", "HTTP 403 — EXPOSED");
  expect(() => assertMacLifecycleOutput(exposed, candidate, pins, model)).toThrow("backend at ssh address");
  const handshakeOnly = output.replace("no HTTP answer (curl exit 7)", "refused");
  expect(() => assertMacLifecycleOutput(handshakeOnly, candidate, pins, model)).toThrow("backend at tailnet address");

  const mismatched = output + "\nhardware: Mac99,1";
  expect(() => assertMacLifecycleOutput(mismatched, candidate, pins, model)).toThrow(
    `Mac hardware mismatch: expected ${model}, measured Mac99,1`,
  );
  expect(() => assertMacLifecycleOutput(output.replace(/hardware:.*\n/u, ""), candidate, pins, model)).toThrow("hardware evidence");
  const root = await mkdtemp(join(tmpdir(), "stable-measured-mac-"));
  try {
    const path = join(root, "receipt.json");
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    const persist = createReceiptPersister(path, receipt);
    await executeReceiptLane(receipt, "macos", persist, async () => assertMacLifecycleOutput(output, candidate, pins, model));
    const restored = validateStableQualificationReceipt(JSON.parse(await readFile(path, "utf8")), TAG, COMMIT, PREVIOUS_TAG);
    expect(restored.schemaVersion).toBe(3);
    expect(restored.lanes.macos).toMatchObject({ status: "passed", evidence });
    const resumed = await executeReceiptLane<ReturnType<typeof assertMacLifecycleOutput>>(restored, "macos", createReceiptPersister(path, restored), async () => {
      throw new Error("passed schema-3 Mac evidence must not rerun");
    });
    expect(resumed).toEqual(evidence);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["guest reboot changed", "console login", "readiness token preserved"])("Mac lifecycle refuses a failed or missing %s verdict", async label => {
  const { pins, candidate, output } = await macLifecycleFixture();
  for (const rejected of [
    output.replace(`${label}: yes`, `${label}: no`),
    output.replace(`${label}: yes\n`, ""),
    `${output}\n${label}: no`,
  ]) {
    expect(() => assertMacLifecycleOutput(rejected, candidate, pins, MAC_ENV.OMP_STABLE_MAC_MODEL)).toThrow(label);
  }
});

test.skipIf(process.platform === "win32")("same-host resume cannot pass stale gateway output when the boot UUID stays unchanged", async () => {
  const { pins, candidate, output } = await macLifecycleFixture();
  const root = await mkdtemp(join(tmpdir(), "stable-mac-stale-boot-"));
  const bootUuid = "11111111-1111-4111-8111-111111111111";
  try {
    await mkdir(join(root, ".config", "omp-session-gateway"), { recursive: true });
    await writeFile(join(root, ".config", "omp-session-gateway", "readiness-token"), "synthetic-readiness-token");
    const child = Bun.spawn(["/bin/bash", "-c", `
set -euo pipefail
source "$1"
sleep() { :; }
sysctl() { [ "$*" = "-n kern.bootsessionuuid" ] || return 91; printf '%s\\n' "$BOOT_UUID"; }
sudo() { [ "$*" = "-n shutdown -r now" ] || return 92; : >"$HOME/reboot-requested"; }
lsof() { printf 'COMMAND PID\\nbun 42\\n'; }
ps() { printf '00:01\\n'; }
launchctl() { return 0; }
who() { printf 'gwqual console\\n'; }
bun() { return 0; }
export -f sysctl sudo lsof ps launchctl who bun
ssh() { /bin/bash -c "\${!#}"; }
lane_persistence
`, "test", join(REPOSITORY_ROOT, "scripts", "qualify-macos-host.sh")], {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env, HOME: root, BOOT_UUID: bootUuid,
        OMP_MAC_HOST: MAC_ENV.OMP_STABLE_MAC_HOST, OMP_MAC_TAG: TAG, OMP_MAC_PREVIOUS_TAG: PREVIOUS_TAG,
        OMP_MAC_LOGIN: "synthetic@example.invalid", OMP_MAC_SUDO_PW: "", OMP_MAC_ARCHIVE_SHA256: candidate.archiveSha256,
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/guest reboot changed:[ \t]+no/u);
    expect(stderr).toContain("a changed boot identity");
    expect(stdout + stderr).not.toContain(bootUuid);
    // The shutdown is detached from the session on purpose; its marker lands shortly after the verdict.
    const markerDeadline = Date.now() + 10_000;
    while (!(await stat(join(root, "reboot-requested")).then(() => true, () => false)) && Date.now() < markerDeadline) await Bun.sleep(100);
    expect((await stat(join(root, "reboot-requested"))).isFile()).toBe(true);
    const staleOutput = output.split("\n").filter(line => !/^(guest reboot changed|console login|readiness token preserved):/u.test(line)).join("\n") + "\n" + stdout;
    const path = join(root, "receipt.json");
    let receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    markMacCleanupRequired(receipt, MAC_ENV.OMP_STABLE_MAC_HOST);
    for (const attempt of [1, 2]) {
      await expect(executeReceiptLane(receipt, "macos", createReceiptPersister(path, receipt), async () =>
        assertMacLifecycleOutput(staleOutput, candidate, pins, MAC_ENV.OMP_STABLE_MAC_MODEL),
      )).rejects.toThrow("guest reboot changed");
      receipt = validateStableQualificationReceipt(JSON.parse(await readFile(path, "utf8")), TAG, COMMIT, PREVIOUS_TAG);
      expect(receipt.macHost).toBe(MAC_ENV.OMP_STABLE_MAC_HOST);
      expect(receipt.lanes.macos).toMatchObject({ status: "failed", attempts: attempt });
      expect(receipt.lanes.macos.evidence).toBeUndefined();
      expect(receiptNeedsMacCleanup(receipt)).toBe(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe("resumable receipt lanes", () => {
  test("availability remains failed with additive closed schema-3 evidence", async () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    const hold = new DeviceCloudAvailabilityHold({
      kind: "device-cloud-availability", stage: "allocation", target: "ipad", vendors: ["testingbot"],
      reason: "pinned-pool-busy", waitedMs: 600_000, epoch: "11111111-2222-4333-8444-555555555555",
    });
    const error = await executeReceiptLane(receipt, "deviceCloud", async () => {}, async checkpoint => {
      await checkpoint({ progress: { epoch: hold.evidence.epoch, cleanupRequired: false } });
      throw hold;
    }).catch((error: unknown) => error);
    expect(deviceCloudHolds(error)).toEqual([hold.evidence]);
    expect(receipt.schemaVersion).toBe(3);
    expect(receipt.lanes.deviceCloud).toMatchObject({ status: "failed", evidence: { availabilityHold: [hold.evidence] } });
  });

  test("checkpoints running evidence, persists a pass, and skips an already passed lane", async () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    const states: string[] = [];
    const persist = async () => {
      states.push(receipt.lanes.artifacts.status);
    };
    let calls = 0;
    const first = await executeReceiptLane(receipt, "artifacts", persist, async checkpoint => {
      calls += 1;
      await checkpoint({ runId: 7 });
      return { verified: true };
    });
    const second = await executeReceiptLane<{ verified: boolean }>(receipt, "artifacts", persist, async () => {
      calls += 1;
      throw new Error("must not run");
    });

    expect(first).toEqual({ verified: true });
    expect(second).toEqual({ verified: true });
    expect(calls).toBe(1);
    expect(receipt.lanes.artifacts).toMatchObject({ status: "passed", attempts: 1, evidence: { verified: true } });
    expect(states).toEqual(["running", "running", "passed"]);
  });

  test("records a failure and never converts it into a pass", async () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    const message = await rejectionMessage(
      executeReceiptLane(receipt, "debian", async () => {}, async () => {
        throw new Error("host lane failed");
      }),
    );
    expect(message).toContain("host lane failed");
    expect(receipt.lanes.debian).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "lane execution failed; inspect the qualification process output",
    });
  });
  test("serializes concurrent Android and relay receipt checkpoints", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-stable-receipt-concurrency-"));
    const receiptPath = join(temporaryRoot, "stable-qualification.json");
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    const persist = createReceiptPersister(receiptPath, receipt);
    try {
      await Promise.all(Array.from({ length: 32 }, () => persist()));
      const persisted = JSON.parse(await readFile(receiptPath, "utf8"));
      expect(validateStableQualificationReceipt(persisted, TAG, COMMIT, PREVIOUS_TAG)).toEqual(persisted);
      expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
      expect(await readdir(temporaryRoot)).toEqual(["stable-qualification.json"]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

test("receipt identity cannot mix passed lanes across orchestrator commits", () => {
  const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
  receipt.lanes.debian.status = "passed";
  expect(validateStableQualificationReceipt(receipt, TAG, COMMIT, PREVIOUS_TAG)).toBe(receipt);
  expect(() => validateStableQualificationReceipt(receipt, TAG, "b".repeat(40), PREVIOUS_TAG)).toThrow(
    "do not resume evidence across orchestrator commits",
  );
  expect(() => validateStableQualificationReceipt(receipt, TAG, COMMIT, "v0.2.0")).toThrow(
    "rollback predecessors",
  );
});

test("legacy schema-3 receipts have no implicit automatic retry evidence", () => {
  const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
  expect(validateStableQualificationReceipt(JSON.parse(JSON.stringify(receipt)), TAG, COMMIT, PREVIOUS_TAG)).toEqual(receipt);
  expect(Object.hasOwn(receipt, "execution")).toBe(false);
  expect(Object.hasOwn(receipt, "failureSummary")).toBe(false);
});

test("schema-3 parsing rejects malformed additive retry and readiness fields", () => {
  const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
  for (const field of ["execution", "failureSummary", "rigReadiness"]) {
    expect(() => validateStableQualificationReceipt({ ...receipt, [field]: {} }, TAG, COMMIT, PREVIOUS_TAG)).toThrow();
  }
  for (const field of ["failure", "timings"]) {
    const lanes = { ...receipt.lanes, windows: { ...receipt.lanes.windows, [field]: { host: "SYNTHETIC_PRIVATE_HOST" } } };
    expect(() => validateStableQualificationReceipt({ ...receipt, lanes }, TAG, COMMIT, PREVIOUS_TAG)).toThrow();
  }
});

function receiptExecution(): QualificationExecution {
  return { formatVersion: 1, campaignAttempt: 0, binding: {
    candidateTag: TAG, previousTag: PREVIOUS_TAG, sourceCommit: COMMIT, archiveSha256: "b".repeat(64),
    orchestratorCommit: COMMIT, policySha256: "c".repeat(64), macHostSha256: digest(MAC_ENV.OMP_STABLE_MAC_HOST),
  } };
}

test("schema-3 additive fields round trip without changing passed historical proofs", async () => {
  const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
  const failure: LaneFailure = { id: 1, lane: "windows", step: "transport_ready", class: "infra_transient",
    reason: "connection_timeout", elapsedMs: 90_000, operation: "read_only", observations: { transportFailure: true } };
  receipt.execution = receiptExecution();
  receipt.macHost = MAC_ENV.OMP_STABLE_MAC_HOST;
  receipt.candidate = { tag: TAG, sourceCommit: COMMIT, archiveSha256: receipt.execution.binding.archiveSha256 };
  receipt.status = "failed";
  receipt.lanes.debian = { status: "passed", attempts: 1, evidence: { historicalProof: true } };
  receipt.lanes.windows = { status: "failed", attempts: 1, failure: [failure], timings: { transport_ready: 90_000 } };
  receipt.failureSummary = { failures: [failure], timings: { attemptMs: 100_000, cleanupMs: 1_000 },
    containment: { proven: true, cleanupComplete: true, unresolvedMutation: false } };
  receipt.rigReadiness = { status: "failed", campaignAttempt: 0, cleanupDisposition: "restored",
    observations: { quotaObservable: false }, timings: { cleanup: 100 } };
  const root = await mkdtemp(join(tmpdir(), "qualification-receipt-contract-"));
  try {
    const path = join(root, "receipt.json");
    await createReceiptPersister(path, receipt)();
    const parsed = validateStableQualificationReceipt(JSON.parse(await readFile(path, "utf8")), TAG, COMMIT, PREVIOUS_TAG);
    expect(parsed).toEqual(receipt);
    expect(parsed.schemaVersion).toBe(3);
    expect(parsed.lanes.debian).toEqual({ status: "passed", attempts: 1, evidence: { historicalProof: true } });
    for (const mutate of [
      () => { parsed.execution = { ...receiptExecution(), binding: { ...receiptExecution().binding, sourceCommit: "d".repeat(40) } }; },
      () => { parsed.execution = { ...receiptExecution(), binding: { ...receiptExecution().binding, macHostSha256: "d".repeat(64) } }; },
    ]) {
      mutate();
      expect(() => validateStableQualificationReceipt(parsed, TAG, COMMIT, PREVIOUS_TAG)).toThrow("execution binding");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("additive receipt failures reject foreign lanes, inconsistent summaries and unbound attempts", () => {
  const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
  receipt.execution = receiptExecution();
  receipt.status = "failed";
  const failure: LaneFailure = { id: 1, lane: "windows", step: "transport_ready", class: "harness",
    reason: "unclassified_failure", elapsedMs: 1, operation: "unknown", observations: {} };
  receipt.lanes.windows = { status: "failed", attempts: 1, failure: [failure] };
  receipt.failureSummary = { failures: [{ ...failure, elapsedMs: 2 }], timings: { attemptMs: 10, cleanupMs: 1 },
    containment: { proven: false, cleanupComplete: false, unresolvedMutation: true } };
  expect(() => validateStableQualificationReceipt(receipt, TAG, COMMIT, PREVIOUS_TAG)).toThrow("differs");
  delete receipt.failureSummary;
  receipt.lanes.android = { status: "failed", attempts: 1, failure: [failure] };
  expect(() => validateStableQualificationReceipt(receipt, TAG, COMMIT, PREVIOUS_TAG)).toThrow("identity");
  delete receipt.lanes.android.failure;
  delete receipt.execution;
  expect(() => validateStableQualificationReceipt(receipt, TAG, COMMIT, PREVIOUS_TAG)).toThrow();
});

test("readiness fields and outcome evidence cannot persist identifiers or fabricated quota metadata", async () => {
  const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
  receipt.execution = receiptExecution();
  const root = await mkdtemp(join(tmpdir(), "qualification-receipt-private-"));
  const path = join(root, "receipt.json");
  try {
    for (const observations of [{ host: "SYNTHETIC_PRIVATE_HOST" }, { quotaObservable: false, quotaAvailable: 10 }]) {
      Object.assign(receipt, { rigReadiness: { status: "failed", campaignAttempt: 0, cleanupDisposition: "restored", observations, timings: {} } });
      expect(() => validateStableQualificationReceipt(receipt, TAG, COMMIT, PREVIOUS_TAG)).toThrow();
      await expect(createReceiptPersister(path, receipt)()).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    }
    Object.assign(receipt, { rigReadiness: { status: "failed", campaignAttempt: 1, cleanupDisposition: "restored", observations: {}, timings: {} } });
    expect(() => validateStableQualificationReceipt(receipt, TAG, COMMIT, PREVIOUS_TAG)).toThrow("unbound");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("receipt-driven Mac cleanup survives restarts and reopens before renewed effects", () => {
  const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
  expect(receiptNeedsMacCleanup(receipt)).toBe(false);
  expect(markMacCleanupRequired(receipt, MAC_ENV.OMP_STABLE_MAC_HOST)).toBe(true);
  receipt.lanes.macos.attempts = 1;
  receipt.lanes.macos.status = "failed";
  expect(receiptNeedsMacCleanup(receipt)).toBe(true);
  receipt.lanes.cleanup.attempts = 1;
  receipt.lanes.cleanup.status = "failed";
  expect(receiptNeedsMacCleanup(receipt)).toBe(true);
  receipt.lanes.cleanup.status = "passed";
  receipt.lanes.cleanup.completedAt = "2026-08-22T00:00:00.000Z";
  receipt.lanes.cleanup.evidence = { gatewayProcesses: 0 };
  expect(receiptNeedsMacCleanup(receipt)).toBe(false);
  expect(markMacCleanupRequired(receipt, MAC_ENV.OMP_STABLE_MAC_HOST)).toBe(true);
  expect(receipt.lanes.cleanup).toMatchObject({ status: "pending", attempts: 1 });
  expect(receipt.lanes.cleanup.completedAt).toBeUndefined();
  expect(receipt.lanes.cleanup.evidence).toBeUndefined();
  expect(receiptNeedsMacCleanup(receipt)).toBe(true);
});

describe("Debian workflow dispatch resume", () => {
  const dispatchId = "11111111-1111-4111-8111-111111111111";
  const options = parseStableQualificationArgs(["--tag", TAG], MAC_ENV);

  test("persists dispatch intent before creating one discoverable run", async () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    const commands: string[][] = [];
    let dispatched = false;
    const checkpoint = async (evidence: Record<string, unknown>) => {
      receipt.lanes.debian.evidence = { ...(receipt.lanes.debian.evidence ?? {}), ...evidence };
    };
    const runtime: DebianQualificationRuntime = {
      output: async command => {
        commands.push([...command]);
        if (command[1] === "api") {
          return JSON.stringify({
            workflow_runs: dispatched
              ? [{ id: 77, display_title: `Stable qualification ${dispatchId}`, head_sha: COMMIT, status: "queued", conclusion: null, html_url: "https://example.invalid/runs/77" }]
              : [],
          });
        }
        return JSON.stringify({
          status: "completed",
          conclusion: "success",
          headSha: COMMIT,
          url: "https://example.invalid/runs/77",
          jobs: [{ name: "Qualify on disposable droplet", conclusion: "success" }],
        });
      },
      execute: async command => {
        commands.push([...command]);
        if (command[1] === "workflow") {
          expect(receipt.lanes.debian.evidence).toMatchObject({
            dispatchId,
            dispatchRequestedAt: expect.any(String),
            runId: null,
          });
          dispatched = true;
        }
      },
      sleep: async () => {},
      createDispatchId: () => dispatchId,
    };

    const evidence = await qualifyDebian(options, receipt, checkpoint, "feat/stable", runtime);
    expect(commands.filter(command => command[1] === "workflow")).toHaveLength(1);
    expect(evidence).toMatchObject({
      dispatchId,
      dispatchRequestedAt: expect.any(String),
      runId: 77,
      url: "https://example.invalid/runs/77",
    });
  });

  test("never redispatches after a durable request whose run is not yet visible", async () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    receipt.lanes.debian.evidence = { dispatchId, dispatchRequestedAt: "2026-08-22T00:00:00.000Z" };
    let dispatches = 0;
    const runtime: DebianQualificationRuntime = {
      output: async () => JSON.stringify({ workflow_runs: [] }),
      execute: async command => {
        if (command[1] === "workflow") dispatches += 1;
      },
      sleep: async () => {},
      createDispatchId: () => { throw new Error("must reuse durable id"); },
    };
    const message = await rejectionMessage(
      qualifyDebian(
        options,
        receipt,
        async evidence => { receipt.lanes.debian.evidence = { ...(receipt.lanes.debian.evidence ?? {}), ...evidence }; },
        "feat/stable",
        runtime,
      ),
    );
    expect(message).toContain("refusing to dispatch again");
    expect(dispatches).toBe(0);
  });
});

test.skipIf(process.platform === "win32")("mainline OMP helper refuses missing pins before host mutation", async () => {
  const child = Bun.spawn(["/bin/bash", "scripts/qualify-macos-omp.sh", "build"], {
    cwd: REPOSITORY_ROOT,
    env: { PATH: process.env.PATH },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("OMP_QUAL_GATEWAY_ROOT is required");
});

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("mainline OMP helper names a failed clone instead of dying silently", async () => {
  // A silenced `git clone` under set -e once ended a campaign's build lane with a bare exit 128.
  const home = await mkdtemp(join(tmpdir(), "omp-helper-clone-"));
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  // The helper pins its own PATH, so git cannot be stubbed; route the clone to a closed local port instead.
  await writeFile(join(home, ".gitconfig"), '[url "http://127.0.0.1:1/"]\n\tinsteadOf = https://github.com/can1357/oh-my-pi.git\n');
  await writeFile(join(bin, "bun"), `#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.0; fi\nexit 0\n`, { mode: 0o755 });
  try {
    const child = Bun.spawn(["/bin/bash", "scripts/qualify-macos-omp.sh", "build"], {
      cwd: REPOSITORY_ROOT,
      env: {
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: home,
        OMP_QUAL_GATEWAY_ROOT: home,
        OMP_PIN_SOURCE_COMMIT: "a".repeat(40),
        OMP_PIN_SOURCE_TREE: "b".repeat(40),
        OMP_PIN_VERSION: "0.0.0",
        OMP_PIN_BUN_VERSION: "1.4.0",
        OMP_PIN_NATIVE_TARBALL_SHA256: "c".repeat(64),
        OMP_PIN_NATIVE_BINARY_SHA256: "d".repeat(64),
        OMP_QUAL_SESSION_LABEL: "synthetic",
        OMP_PIN_BUN_EXECUTABLE: join(bin, "bun"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("mainline OMP clone failed (git exit 128)");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("mainline OMP helper rejects path-special labels before cleanup", async () => {
  for (const sessionLabel of ["..", ".ssh"]) {
    const child = Bun.spawn(["/bin/bash", "scripts/qualify-macos-omp.sh", "clean"], {
      cwd: REPOSITORY_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: "/tmp/omp-path-guard-never-used",
        OMP_QUAL_GATEWAY_ROOT: "/tmp/omp-candidate-never-used",
        OMP_PIN_SOURCE_COMMIT: "1".repeat(40),
        OMP_PIN_SOURCE_TREE: "2".repeat(40),
        OMP_PIN_VERSION: "17.4.1",
        OMP_PIN_BUN_VERSION: "1.3.14",
        OMP_PIN_NATIVE_TARBALL_SHA256: "3".repeat(64),
        OMP_PIN_NATIVE_BINARY_SHA256: "4".repeat(64),
        OMP_QUAL_SESSION_LABEL: sessionLabel,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("safe single path component");
  }
});

test("protected release state guard detects implicit ledger promotion", async () => {
  const root = await mkdtemp(join(tmpdir(), "stable-qualification-guard-"));
  const stable = "pending\n";
  const ledger = "not promoted\n";
  const snapshots: ProtectedFileSnapshot[] = [
    { path: "STABLE_RELEASE.lock.json", sha256: digest(stable) },
    { path: "docs/RELEASE_STATUS.md", sha256: digest(ledger) },
  ];
  try {
    await writeFile(join(root, "STABLE_RELEASE.lock.json"), stable);
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs/RELEASE_STATUS.md"), ledger);
    await assertProtectedFilesUnchanged(snapshots, root);

    await writeFile(join(root, "STABLE_RELEASE.lock.json"), "qualified\n");
    const message = await rejectionMessage(assertProtectedFilesUnchanged(snapshots, root));
    expect(message).toContain("qualification modified protected release state");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a schema 2 receipt cannot resume into the campaign that adds the real-device cloud lane", () => {
  const receipt = { ...createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG), schemaVersion: 2 };
  expect(() => validateStableQualificationReceipt(receipt, TAG, COMMIT, PREVIOUS_TAG)).toThrow(
    "predates the real-device cloud lane",
  );
});

test("the Pixel lease runs one action at a time and survives a failed holder", async () => {
  const lease = createPixelLease(() => {});
  const order: string[] = [];
  let started!: () => void;
  let release!: () => void;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const firstMayEnd = new Promise<void>(resolve => { release = resolve; });
  const first = lease("android", async () => {
    order.push("start android");
    started();
    await firstMayEnd;
    order.push("end android");
    throw new Error("android failed");
  });
  const second = lease("androidPush", async () => { order.push("androidPush"); });
  const third = lease("windows", async () => { order.push("windows"); });
  await firstStarted;
  // The holder has not finished, so neither waiter may have started.
  expect(order).toEqual(["start android"]);
  release();
  const results = await Promise.allSettled([first, second, third]);
  expect(order).toEqual(["start android", "end android", "androidPush", "windows"]);
  expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
});

test("a Pixel left unrestored refuses every later device lane", async () => {
  const lease = createPixelLease(() => {});
  let later = 0;
  const unrestored = Object.assign(new Error("keyguard restore failed"), { pixelUnrestored: true });
  const failure = new AggregateError([new Error("phase failed"), new AggregateError([unrestored], "device restoration failed")], "qualification failed");
  const [holder, waiter] = await Promise.allSettled([
    lease("windows", async () => { throw failure; }),
    lease("androidPush", async () => { later += 1; }),
  ]);
  expect(holder).toMatchObject({ status: "rejected", reason: failure });
  if (waiter?.status !== "rejected") throw new Error("the waiting lane must be refused");
  expect(String(waiter.reason)).toContain("left unrestored by windows");
  expect(later).toBe(0);
});

test("a read-only Android origin refusal leaves the Pixel lease clean for the next admission", async () => {
  const lease = createPixelLease(() => {});
  let calls = 0;
  const options = parseStableQualificationArgs(["--tag", TAG], MAC_ENV);
  await expect(lease("android", () => runAndroidAcceptance(options, {
    publicOrigin: "https://gateway-fixture.invalid",
    target: { sshDestination: "fixture.invalid", sudoPassword: "" },
    environment: {},
  }, {
    adb: async (_serial, args) => {
      calls++;
      if (args[0] === "devices") return "List of devices attached\nfixture-device device\n";
      if (args[1] === "ping -c 1 -W 2 'gateway-fixture.invalid' || true") return "ping: unknown host";
      throw new Error("unexpected mutating device command");
    },
  }))).rejects.toMatchObject({ name: "AndroidReachabilityPreconditionError", reason: "unreachable" });
  expect(calls).toBe(2);
  expect(await lease("androidPush", async () => "admitted")).toBe("admitted");
});

test("a failed or timed-out Pixel-restoring child refuses every later device lane", async () => {
  // Real children: the timeout case needs runCommand's actual SIGTERM of a live process, which fake
  // timers cannot drive. A slow start that trips the 300 ms timeout is flagged the same way.
  for (const child of [["-e", "process.exit(3)"], ["-e", "await Bun.sleep(10_000)"]]) {
    const lease = createPixelLease(() => {});
    let later = 0;
    const [holder, waiter] = await Promise.allSettled([
      lease("android", () => runPixelRestoringChild([process.execPath, ...child], { timeoutMs: 300 })),
      lease("androidPush", async () => { later += 1; }),
    ]);
    expect(holder.status).toBe("rejected");
    if (waiter?.status !== "rejected") throw new Error("the waiting lane must be refused");
    expect(String(waiter.reason)).toContain("left unrestored by android");
    expect(later).toBe(0);
  }
});

describe("resource-owning lanes", () => {
  interface LaneLog {
    readonly calls: string[];
    readonly runProgress: unknown[];
  }
  const persist = async () => {};
  const newLog = (): LaneLog => ({ calls: [], runProgress: [] });
  const holdsResources = (progress: unknown): progress is object =>
    typeof progress === "object" && progress !== null && "resources" in progress && progress.resources === 1;

  /** Records one resource, then releases it on cleanup, the way the Windows VM and Pixel lanes do. */
  function resourceLane(
    log: LaneLog,
    behaviour: {
      readonly runFails?: boolean;
      readonly cleanupFails?: boolean;
      readonly cleanupLeavesResources?: boolean;
      readonly recordsNoEpoch?: boolean;
    } = {},
  ): ExternalLaneModule {
    return {
      preflight: async () => {},
      run: async ({ progress, checkpoint }) => {
        log.calls.push(progress === undefined ? "run" : "resume");
        log.runProgress.push(progress);
        if (behaviour.recordsNoEpoch) return { verified: true };
        await checkpoint({ epoch: "epoch-new", phase: "provisioned", resources: 1 });
        if (behaviour.runFails) throw new Error("fixture lane failed after provisioning");
        await checkpoint({ epoch: "epoch-new", phase: "verified", resources: 1 });
        return { verified: true };
      },
      needsCleanup: holdsResources,
      cleanup: async ({ progress, checkpoint }) => {
        log.calls.push("cleanup");
        if (behaviour.cleanupFails) throw new Error("fixture cleanup failed");
        if (!behaviour.cleanupLeavesResources && holdsResources(progress)) {
          await checkpoint({ ...progress, resources: 0 });
        }
        return { released: true };
      },
    };
  }

  async function laneContext() {
    const omp = parseQualificationPins(await readFile(join(REPOSITORY_ROOT, "UPSTREAM.lock.json"), "utf8"));
    const release = (tag: string) => ({ tag, sourceCommit: COMMIT, archiveSha256: "b".repeat(64), archivePath: `/unused/${tag}.tar` });
    const identity: ExternalLaneIdentity = {
      tag: TAG,
      previousTag: PREVIOUS_TAG,
      orchestratorCommit: COMMIT,
      receiptRoot: "/unused",
      candidate: release(TAG),
      predecessor: release(PREVIOUS_TAG),
      omp,
    };
    return { identity, pixel: createPixelLease(() => {}) };
  }

  test("passes only with a cleanup bound to the attempt it released", async () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    const log = newLog();
    await runExternalLane(receipt, "windows", persist, resourceLane(log), await laneContext());
    expect(log.calls).toEqual(["run", "cleanup"]);
    expect(receipt.lanes.windows).toMatchObject({
      status: "passed",
      attempts: 1,
      evidence: { progress: { epoch: "epoch-new", phase: "verified", resources: 0 }, result: { verified: true } },
    });
    expect(receipt.lanes.windowsCleanup).toMatchObject({ status: "passed", evidence: { released: true, epoch: "epoch-new" } });
    expect(externalCleanupCurrent(receipt, "windows")).toBe(true);
  });

  test("cleans up a failed attempt and never converts it into a pass", async () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    const log = newLog();
    const message = await rejectionMessage(
      runExternalLane(receipt, "windows", persist, resourceLane(log, { runFails: true }), await laneContext()),
    );
    expect(message).toContain("failed after provisioning");
    expect(log.calls).toEqual(["run", "cleanup"]);
    expect(receipt.lanes.windows.status).toBe("failed");
    expect(receipt.lanes.windowsCleanup).toMatchObject({ status: "passed", evidence: { epoch: "epoch-new" } });
    expect(incompleteQualification(receipt)).toContain("did not pass");
  });

  test("releases a failed attempt before starting another, and an unreleased one blocks it", async () => {
    const failedAttempt = () => {
      const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
      receipt.lanes.windows = { status: "failed", attempts: 1, evidence: { progress: { epoch: "epoch-old", resources: 1 } } };
      receipt.lanes.windowsCleanup = { status: "failed", attempts: 1 };
      return receipt;
    };
    const blocked = failedAttempt();
    const blockedLog = newLog();
    const message = await rejectionMessage(
      runExternalLane(blocked, "windows", persist, resourceLane(blockedLog, { cleanupFails: true }), await laneContext()),
    );
    expect(message).toContain("fixture cleanup failed");
    expect(blockedLog.calls).toEqual(["cleanup"]);
    expect(blocked.lanes.windows).toMatchObject({ status: "failed", attempts: 1 });

    const receipt = failedAttempt();
    const log = newLog();
    await runExternalLane(receipt, "windows", persist, resourceLane(log), await laneContext());
    expect(log.calls).toEqual(["cleanup", "run", "cleanup"]);
    expect(log.runProgress).toEqual([undefined]);
    expect(receipt.lanes.windows).toMatchObject({ status: "passed", attempts: 2 });
    expect(externalCleanupCurrent(receipt, "windows")).toBe(true);
  });

  test("resumes the attempt a crash left running", async () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    const crashed = { epoch: "epoch-new", phase: "provisioned", resources: 1 };
    receipt.lanes.windows = { status: "running", attempts: 1, evidence: { progress: crashed } };
    const log = newLog();
    await runExternalLane(receipt, "windows", persist, resourceLane(log), await laneContext());
    expect(log.calls).toEqual(["resume", "cleanup"]);
    expect(log.runProgress).toEqual([crashed]);
    expect(receipt.lanes.windows).toMatchObject({ status: "passed", attempts: 2 });
  });

  test("leaves a current pass alone and only cleans one whose cleanup lapsed", async () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    const context = await laneContext();
    await runExternalLane(receipt, "windows", persist, resourceLane(newLog()), context);
    const again = newLog();
    await runExternalLane(receipt, "windows", persist, resourceLane(again), context);
    expect(again.calls).toEqual([]);
    receipt.lanes.windowsCleanup.status = "failed";
    const lapsed = newLog();
    await runExternalLane(receipt, "windows", persist, resourceLane(lapsed), context);
    expect(lapsed.calls).toEqual(["cleanup"]);
    expect(receipt.lanes.windows.attempts).toBe(1);
    expect(externalCleanupCurrent(receipt, "windows")).toBe(true);
  });

  test("a cleanup that leaves recorded resources fails its lane", async () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    const message = await rejectionMessage(
      runExternalLane(receipt, "windows", persist, resourceLane(newLog(), { cleanupLeavesResources: true }), await laneContext()),
    );
    expect(message).toContain("still records resources");
    expect(receipt.lanes.windows.status).toBe("passed");
    expect(receipt.lanes.windowsCleanup.status).toBe("failed");
    expect(externalCleanupCurrent(receipt, "windows")).toBe(false);
  });

  test("an attempt that never records an epoch cannot pass", async () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    const message = await rejectionMessage(
      runExternalLane(receipt, "windows", persist, resourceLane(newLog(), { recordsNoEpoch: true }), await laneContext()),
    );
    expect(message).toContain("attempt epoch");
    expect(receipt.lanes.windows.status).toBe("failed");
  });

  test("a lane that finishes with a blocked phase fails, keeps its progress, and is still released", async () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    const log = newLog();
    const blocked: ExternalLaneModule = {
      ...resourceLane(log),
      run: async ({ checkpoint }) => {
        log.calls.push("run");
        await checkpoint({ epoch: "epoch-new", phase: "network_verified", resources: 1, network: "cellular_path_unavailable" });
        return { passed: false, network: "cellular_path_unavailable" };
      },
    };
    const message = await rejectionMessage(runExternalLane(receipt, "androidPush", persist, blocked, await laneContext()));
    expect(message).toContain("without passing every phase");
    expect(log.calls).toEqual(["run", "cleanup"]);
    expect(receipt.lanes.androidPush.status).toBe("failed");
    expect(receipt.lanes.androidPush.evidence).toMatchObject({ progress: { network: "cellular_path_unavailable" } });
    expect(receipt.lanes.androidPushCleanup).toMatchObject({ status: "passed", evidence: { epoch: "epoch-new" } });
  });

  test("a campaign passes only when each cleanup covers the attempt its lane recorded", () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    for (const lane of Object.values(receipt.lanes)) Object.assign(lane, { status: "passed", attempts: 1 });
    receipt.lanes.windows.evidence = { progress: { epoch: "w1" }, result: { verified: true } };
    receipt.lanes.windowsCleanup.evidence = { epoch: "w1" };
    receipt.lanes.androidPush.evidence = { progress: { epoch: "p1" }, result: { verified: true } };
    receipt.lanes.androidPushCleanup.evidence = { epoch: "p1" };
    receipt.lanes.deviceCloud.evidence = { progress: { epoch: "c1" }, result: { passed: true } };
    receipt.lanes.deviceCloudCleanup.evidence = { epoch: "c1" };
    expect(incompleteQualification(receipt)).toBeUndefined();
    receipt.lanes.androidPushCleanup.evidence = { epoch: "p0" };
    expect(incompleteQualification(receipt)).toContain("androidPushCleanup");
    receipt.lanes.androidPushCleanup.evidence = { epoch: "p1" };
    receipt.lanes.windows.evidence = { progress: { epoch: "w1" } };
    expect(incompleteQualification(receipt)).toContain("without a result");
  });

  test("a recorded result that did not pass can never complete a campaign", () => {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    for (const lane of Object.values(receipt.lanes)) Object.assign(lane, { status: "passed", attempts: 1 });
    receipt.lanes.windows.evidence = { progress: { epoch: "w1" }, result: { verified: true } };
    receipt.lanes.windowsCleanup.evidence = { epoch: "w1" };
    receipt.lanes.androidPush.evidence = { progress: { epoch: "p1" }, result: { passed: false } };
    receipt.lanes.androidPushCleanup.evidence = { epoch: "p1" };
    expect(incompleteQualification(receipt)).toContain("did not pass");
  });
});

test("a resumed campaign that fails admission still destroys the Windows VM it recorded", async () => {
  const root = await mkdtemp(join(tmpdir(), "stable-windows-orphan-"));
  try {
    const receipt = createStableQualificationReceipt(TAG, COMMIT, PREVIOUS_TAG);
    receipt.status = "failed";
    receipt.candidate = { tag: TAG, sourceCommit: COMMIT, archiveSha256: "b".repeat(64) };
    receipt.predecessor = { tag: PREVIOUS_TAG, sourceCommit: "c".repeat(40), archiveSha256: "d".repeat(64) };
    // A crash left the lane running with a VM recorded and its cleanup never started.
    receipt.lanes.windows = { status: "running", attempts: 1, evidence: { progress: { epoch: "w1", resources: 1 } } };
    const path = join(root, "stable-qualification.json");
    await writeFile(path, JSON.stringify(receipt));
    const cleaned: unknown[] = [];
    const lanes = admissionLanes();
    const windows: ExternalLaneModule = {
      ...lanes.windows,
      needsCleanup: progress =>
        typeof progress === "object" && progress !== null && "resources" in progress && progress.resources === 1,
      cleanup: async ({ progress, checkpoint, identity }) => {
        cleaned.push({ progress, predecessor: identity.predecessor.tag });
        if (typeof progress === "object" && progress !== null) await checkpoint({ ...progress, resources: 0 });
        return { released: true };
      },
    };
    const runtime = await preflightFixture(root, "absent");
    const error = await rejectionMessage(runStableQualification(["--tag", TAG], runtime, { ...lanes, windows }));
    expect(error).toContain("authorized Android");
    expect(cleaned).toEqual([{ progress: { epoch: "w1", resources: 1 }, predecessor: PREVIOUS_TAG }]);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted.status).toBe("failed");
    expect(persisted.lanes.windowsCleanup).toMatchObject({ status: "passed", evidence: { released: true, epoch: "w1" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
