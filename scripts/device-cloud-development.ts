/** Isolated Tested-only journey runner. Never starts a stable campaign or approves a release. */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cleanupDeviceCloud, runDeviceCloud, type DeviceCloudProgress, type DeviceCloudTargetAttempt } from "./device-cloud-qualification.ts";
import { DeviceCloudAvailabilityHold, deviceCloudMachineOutcome } from "./device-cloud-availability.ts";
import { createDeviceCloudRuntime } from "./device-cloud-runtime.ts";
import { retainedMacCloudFixture } from "./stable-lanes.ts";
import { createPixelLease, remoteCommandLine, type ExternalLaneContext, type ExternalLaneIdentity, type RetainedMacLaneContext } from "./stable-qualification.ts";

export async function runDeviceCloudDevelopment(argv: readonly string[]) {
  let identityPath: string | undefined;
  let macHost: string | undefined;
  let origin: string | undefined;
  let sessionLabel: string | undefined;
  let holdAfterIphone = false;
  let mixedVendors = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--identity") identityPath = argv[++index];
    else if (arg === "--mac-host") macHost = argv[++index];
    else if (arg === "--origin") origin = argv[++index];
    else if (arg === "--session-label") sessionLabel = argv[++index];
    else if (arg === "--hold-after-iphone") holdAfterIphone = true;
    else if (arg === "--mixed-vendors") mixedVendors = true;
    else throw new Error("unknown development-runner argument");
  }
  if (identityPath === undefined || macHost === undefined || origin === undefined || sessionLabel === undefined ||
    !/^[A-Za-z_][A-Za-z0-9._-]*@[A-Za-z0-9.-]+$/u.test(macHost) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(sessionLabel) || new URL(origin).origin !== origin || !origin.startsWith("https://")) {
    throw new Error("usage: device-cloud-development --identity <private-json> --mac-host <user@host> --origin <https-origin> --session-label <isolated-label> [--hold-after-iphone | --mixed-vendors]");
  }
  if (holdAfterIphone && mixedVendors) throw new Error("choose either a hold proof or a mixed-vendor journey");
  const identity = JSON.parse(await readFile(resolve(identityPath), "utf8")) as ExternalLaneIdentity;
  if (typeof identity.receiptRoot !== "string" || !identity.receiptRoot.includes("device-cloud-development") ||
    identity.candidate?.archivePath === undefined || identity.tag !== identity.candidate.tag || !/^[a-f0-9]{64}$/u.test(identity.candidate.archiveSha256)) {
    throw new Error("development identity needs a separate device-cloud-development directory and a candidate archive");
  }
  const archive = await readFile(identity.candidate.archivePath);
  if (createHash("sha256").update(archive).digest("hex") !== identity.candidate.archiveSha256) throw new Error("development archive digest mismatch");
  const root = resolve(identity.receiptRoot);
  const path = join(root, "device-cloud-development.json");
  if (await Bun.file(path).exists()) throw new Error("use a fresh development directory; old evidence must not be overwritten");
  const pixel = createPixelLease(() => {});
  let progress: DeviceCloudProgress | undefined;
  const checkpoint = async (value: Record<string, unknown>) => {
    progress = value as DeviceCloudProgress;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ evidenceClass: "Tested", progress })}\n`, { mode: 0o600 });
    await rename(temporary, path);
  };
  const target = macHost;
  const context: ExternalLaneContext & RetainedMacLaneContext = {
    identity, origin, sessionLabel, progress: undefined, checkpoint, pixel,
    mac: async (args, options = {}) => {
      const child = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ClearAllForwardings=yes", target, remoteCommandLine(args)], {
        stdin: options.stdin ?? "ignore", stdout: "pipe", stderr: "ignore",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 180_000);
      try { return { exitCode: await child.exited, stdout: await new Response(child.stdout).text(), stderr: "" }; }
      finally { clearTimeout(timer); }
    },
  };
  const runtime = await createDeviceCloudRuntime({
    identity: { tag: identity.tag, candidate: identity.candidate, omp: identity.omp, origin }, workspace: join(root, "work"),
    fixture: retainedMacCloudFixture(context), environment: process.env,
    ...(mixedVendors ? { developmentForceFallback: true as const } : {}),
  });
  let sessions = 0;
  let expired = false;
  const deadline = setTimeout(() => { expired = true; }, 40 * 60_000);
  const input = {
    identity: { tag: identity.tag, candidate: identity.candidate, omp: identity.omp, origin },
    sessionLabel, progress: undefined, checkpoint, pixel,
    runtime: {
      ...runtime,
      verify: async (target: "iphone" | "ipad" | "android", attempt: DeviceCloudTargetAttempt) => {
        if (expired) throw new Error("development allocation deadline elapsed");
        if (holdAfterIphone && target === "ipad") throw new DeviceCloudAvailabilityHold({
          kind: "device-cloud-availability", stage: "allocation", target, vendors: ["testingbot"], reason: "pinned-pool-busy", waitedMs: 0, epoch: attempt.epoch,
        });
        if (sessions >= 3) throw new Error("development session bound exceeded");
        return runtime.verify(target, { ...attempt, created: async id => { sessions += 1; await attempt.created(id); } });
      },
    },
  };
  let result: Record<string, unknown> | undefined;
  let failure: unknown;
  try { result = await runDeviceCloud(input); }
  catch (error) { failure = error; }
  clearTimeout(deadline);
  if (progress?.cleanupRequired) {
    try { await cleanupDeviceCloud({ ...input, progress }); }
    catch (error) { failure = new AggregateError(failure === undefined ? [error] : [failure, error], "development attempt cleanup failed"); }
  }
  if (failure !== undefined) throw failure;
  return { evidenceClass: "Tested", maximumSessions: 3, sessions, result };
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await runDeviceCloudDevelopment(Bun.argv.slice(2)))); }
  catch (error) {
    const hold = deviceCloudMachineOutcome(error);
    console.log(JSON.stringify(hold ?? { outcome: "diagnostic-failure" }));
    process.exitCode = hold === undefined ? 1 : 75;
  }
}
