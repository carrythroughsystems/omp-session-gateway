/**
 * The production Windows, background Push, and real-device cloud lanes, adapted to the stable
 * orchestrator's resource-owning lane contract (`ExternalLaneModule` in stable-qualification.ts).
 *
 * The Push and device-cloud fixtures run on the retained Mac beside the candidate gateway, so their
 * fixture files are staged there over SSH and every fixture operation runs through the
 * orchestrator's remote executor.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  androidPushNeedsCleanup,
  cleanupAndroidPush,
  preflightAndroidPush,
  runAndroidPush,
  type AndroidPushIdentity,
} from "./android-push-qualification.ts";
import { createAndroidPushRuntime } from "./android-push-runtime.ts";
import { cleanupDeviceCloud, deviceCloudNeedsCleanup, runDeviceCloud } from "./device-cloud-qualification.ts";
import { admitDeviceCloud, createDeviceCloudRuntime } from "./device-cloud-runtime.ts";
import type { FixtureExecutor } from "./push-qualification-fixture.ts";
import {
  createPixelLease,
  type RetainedMacLaneContext,
  type ExternalLaneContext,
  type ExternalLaneModule,
  type RemoteExecutor,
  type StableQualificationLaneModules,
} from "./stable-qualification.ts";
import { cleanupWindows, preflightWindows, runWindows, windowsNeedsCleanup } from "./windows-stable-qualification.ts";

/** Everything the Push fixture imports, relative to `scripts/` (see push-qualification-fixture.ts). */
export const PUSH_FIXTURE_FILES = [
  "push-qualification-fixture.ts",
  "omp-fixture.ts",
  "omp-fixture.json",
  "fixtures/push-qualification-extension.ts",
] as const;
const FIXTURE_OPERATION_TIMEOUT_MS = 3 * 60 * 1_000;

async function remoteText(
  mac: RemoteExecutor,
  script: string,
  failure: string,
  options: { readonly args?: readonly string[]; readonly stdin?: Uint8Array } = {},
): Promise<string> {
  // Operands after the -c script bind from $0, so values never enter the script text.
  const result = await mac(["/bin/sh", "-c", script, ...(options.args ?? [])], options.stdin === undefined ? {} : { stdin: options.stdin });
  if (result.exitCode !== 0) throw new Error(failure);
  return result.stdout;
}

/** The retained Mac user's home, which every staged fixture path is absolute beneath. */
export async function remoteHome(mac: RemoteExecutor): Promise<string> {
  const home = (await remoteText(mac, 'printf %s "$HOME"', "the retained Mac did not report a home directory")).trim();
  if (!/^\/[A-Za-z0-9._/-]+$/u.test(home) || home.includes("..")) throw new Error("the retained Mac home directory is not a plain absolute path");
  return home;
}

/** Writes one private file on the retained Mac, atomically, from bytes on stdin. */
export async function stageRemoteFile(mac: RemoteExecutor, path: string, bytes: Uint8Array): Promise<void> {
  await remoteText(
    mac,
    'umask 077 && mkdir -p "$(dirname "$0")" && cat > "$0.tmp" && mv "$0.tmp" "$0"',
    "could not stage a fixture file on the retained Mac",
    { args: [path], stdin: bytes },
  );
}

function liveIdentity(context: ExternalLaneContext & RetainedMacLaneContext): AndroidPushIdentity {
  const { tag, candidate, omp } = context.identity;
  return { tag, candidate, omp, origin: context.origin };
}

/**
 * Whether the retained Mac's gateway service sends both standard streams to /dev/null. Each stream
 * is read by its own command, so one missing key cannot hide behind the other's success.
 */
export async function gatewayStreamsDiscarded(mac: RemoteExecutor): Promise<boolean> {
  for (const key of ["StandardOutPath", "StandardErrorPath"]) {
    const path = await remoteText(
      mac,
      'plutil -extract "$0" raw -o - "$HOME/Library/LaunchAgents/omp-session-gateway.plist"',
      "could not read the retained Mac gateway's service definition",
      { args: [key] },
    );
    if (path.trim() !== "/dev/null") return false;
  }
  return true;
}

/**
 * Stages the fixture files into one lane's own directory on the retained Mac, so two lanes never
 * write the same staged file, and returns how to run the stock-OMP fixture there.
 */
async function stageRetainedMacFixture(context: ExternalLaneContext & RetainedMacLaneContext, lane: "push" | "device-cloud") {
  const home = await remoteHome(context.mac);
  const scripts = `${home}/qual-tools/${lane}/scripts`;
  for (const file of PUSH_FIXTURE_FILES) {
    await stageRemoteFile(context.mac, `${scripts}/${file}`, await readFile(fileURLToPath(new URL(file, import.meta.url))));
  }
  const { omp } = context.identity;
  const execute: FixtureExecutor = async argv => {
    const result = await context.mac(argv, { timeoutMs: FIXTURE_OPERATION_TIMEOUT_MS });
    return { exitCode: result.exitCode, stdout: result.stdout };
  };
  return {
    home,
    scripts,
    execute,
    bun: `${home}/.bun/bin/bun`,
    // The pinned stock OMP that the Mac lane's `omp-build` installs (qualify-macos-omp.sh).
    binary: `${home}/.local/lib/omp-session-gateway/omp/v${omp.version}-${omp.sourceTree.slice(0, 8)}/omp`,
  };
}

async function retainedMacPushRuntime(context: ExternalLaneContext & RetainedMacLaneContext) {
  const fixture = await stageRetainedMacFixture(context, "push");
  return createAndroidPushRuntime(liveIdentity(context), {
    execute: fixture.execute,
    fixtureBase: `${fixture.home}/qual-tools/push-fixtures`,
    fixtureBun: fixture.bun,
    fixtureBinary: fixture.binary,
    fixtureScripts: fixture.scripts,
    gatewayLogsDiscarded: () => gatewayStreamsDiscarded(context.mac),
  });
}

async function retainedMacCloudRuntime(context: ExternalLaneContext & RetainedMacLaneContext) {
  return createDeviceCloudRuntime({
    identity: liveIdentity(context),
    workspace: join(context.identity.receiptRoot, "device-cloud"),
    fixture: retainedMacCloudFixture(context),
    environment: process.env,
  });
}

/** Creating the factory performs no remote work; the runtime invokes it under the Pixel lease. */
export function retainedMacCloudFixture(context: ExternalLaneContext & RetainedMacLaneContext) {
  return async () => {
    const fixture = await stageRetainedMacFixture(context, "device-cloud");
    return { ...fixture, base: `${fixture.home}/qual-tools/device-cloud/fixtures` };
  };
}

const windows: ExternalLaneModule = {
  preflight: async () => {
    await preflightWindows({});
  },
  run: context =>
    runWindows({ identity: context.identity, progress: context.progress, checkpoint: context.checkpoint, pixel: context.pixel }),
  needsCleanup: windowsNeedsCleanup,
  cleanup: context =>
    cleanupWindows({ identity: context.identity, progress: context.progress, checkpoint: context.checkpoint, pixel: context.pixel }),
};

const androidPush: ExternalLaneModule<RetainedMacLaneContext> = {
  preflight: async context => {
    await preflightAndroidPush({ origin: context.macOrigin });
  },
  run: async context =>
    runAndroidPush({
      identity: liveIdentity(context),
      progress: context.progress,
      checkpoint: context.checkpoint,
      pixel: context.pixel,
      runtime: await retainedMacPushRuntime(context),
    }),
  needsCleanup: androidPushNeedsCleanup,
  cleanup: async context => {
    if (context.progress === undefined) return { noAttempt: true };
    return cleanupAndroidPush({
      identity: liveIdentity(context),
      progress: context.progress,
      checkpoint: context.checkpoint,
      pixel: context.pixel,
      runtime: await retainedMacPushRuntime(context),
    });
  },
};

const deviceCloud: ExternalLaneModule<RetainedMacLaneContext> = {
  preflight: async context => {
    await admitDeviceCloud(context.environment, "free");
  },
  run: async context =>
    runDeviceCloud({
      identity: liveIdentity(context),
      sessionLabel: context.sessionLabel,
      progress: context.progress,
      checkpoint: context.checkpoint,
      pixel: context.pixel,
      runtime: await retainedMacCloudRuntime(context),
    }),
  needsCleanup: deviceCloudNeedsCleanup,
  cleanup: async context => {
    if (context.progress === undefined) return { noAttempt: true };
    return cleanupDeviceCloud({
      identity: liveIdentity(context),
      sessionLabel: context.sessionLabel,
      progress: context.progress,
      checkpoint: context.checkpoint,
      pixel: context.pixel,
      runtime: await retainedMacCloudRuntime(context),
    });
  },
};

export const defaultLaneModules: StableQualificationLaneModules = {
  windows,
  androidPush,
  deviceCloud,
  createPixelLease: () => createPixelLease(),
};
