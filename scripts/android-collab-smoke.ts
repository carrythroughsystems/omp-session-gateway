import { isProtectedLabel, targetEligibility } from "./acceptance-target.ts";
import { withAndroidChrome, type AndroidExecution } from "./android-device.ts";
import { ANDROID_COLLAB_STAGES, announceAndroidStage } from "./android-stages.ts";
import { APP_ASSET_PATTERN, runCollaborationJourney } from "./browser-journey.ts";

const PROMPT_MARKER = "OMP_POST_RELEASE_ANDROID_CONTROL_SMOKE";

export interface AndroidCollabSmokeOptions {
  readonly origin: string;
  readonly label: string;
  readonly expectedAppAsset?: string;
  readonly allowDisposableTarget: boolean;
  readonly execution?: AndroidExecution;
}

export interface AndroidCollabSmokeResult {
  readonly packageName: string;
  readonly androidPackageVersion: string;
  /** The supplied archive expectation, absent for an unpinned development smoke. */
  readonly appAsset?: string;
  readonly viewReadOnly: true;
  readonly controlWritable: true;
  readonly promptAccepted: true;
  readonly returnedToDirectory: true;
}
interface SessionMetadata {
  readonly cwdLabel: string;
  readonly canView: boolean;
  readonly canControl: boolean;
  readonly startedAt?: string;
}


export function parseAndroidCollabSmokeArgs(argv: readonly string[]): AndroidCollabSmokeOptions {
  const positional: string[] = [];
  let expectedAppAsset: string | undefined;
  let allowDisposableTarget = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--disposable-target") {
      allowDisposableTarget = true;
      continue;
    }
    if (value === "--expected-app-asset") {
      expectedAppAsset = argv[++index];
      if (!expectedAppAsset) throw new Error("--expected-app-asset requires a path");
      continue;
    }
    if (value.startsWith("--")) throw new Error(`unknown option: ${value}`);
    positional.push(value);
  }

  if (positional.length !== 2) {
    throw new Error(
      "usage: bun scripts/android-collab-smoke.ts <origin> <disposable-label> [--expected-app-asset /assets/app.<hash>.js] [--disposable-target]",
    );
  }
  const [origin, label] = positional as [string, string];
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.protocol !== "https:" || parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash) {
    throw new Error("origin must be an HTTPS origin without a path, query, or fragment");
  }
  if (isProtectedLabel(label)) throw new Error("refusing protected or soak target label");
  if (expectedAppAsset !== undefined && !APP_ASSET_PATTERN.test(expectedAppAsset)) {
    throw new Error("expected app asset must be a hashed /assets/app.*.js path");
  }

  return {
    origin: parsedOrigin.origin,
    label,
    ...(expectedAppAsset === undefined ? {} : { expectedAppAsset }),
    allowDisposableTarget,
  };
}

async function assertEligibleTarget(options: AndroidCollabSmokeOptions): Promise<void> {
  options.execution?.signal.throwIfAborted();
  if (options.execution !== undefined && performance.now() >= options.execution.deadline) throw new Error("physical client deadline exceeded");
  const response = await fetch(`${options.origin}/api/v1/sessions`, {
    cache: "no-store",
    credentials: "omit",
    headers: { Accept: "application/json" },
    ...(options.execution === undefined ? {} : {
      signal: AbortSignal.any([options.execution.signal, AbortSignal.timeout(Math.max(1, Math.ceil(options.execution.deadline - performance.now())))]),
    }),
  });
  if (!response.ok) throw new Error(`session-list preflight failed with HTTP ${response.status}`);
  const payload = (await response.json()) as { sessions?: SessionMetadata[] };
  const matches = (payload.sessions ?? []).filter(session => session.cwdLabel === options.label);
  if (matches.length !== 1) throw new Error(`expected exactly one disposable target; found ${matches.length}`);
  const target = matches[0]!;
  if (!target.canView || !target.canControl) throw new Error("disposable target lacks View or Control capability");
  const eligibility = targetEligibility(options.label, target.startedAt, Date.now(), options.allowDisposableTarget);
  if (!eligibility.eligible) throw new Error(eligibility.reason ?? "disposable target is ineligible");
}

export async function runAndroidCollabSmoke(options: AndroidCollabSmokeOptions): Promise<AndroidCollabSmokeResult> {
  announceAndroidStage(ANDROID_COLLAB_STAGES, "target preflight");
  await assertEligibleTarget(options);

  announceAndroidStage(ANDROID_COLLAB_STAGES, "Android Chrome");
  return withAndroidChrome(async driver => {
    await driver.openTab();
    const journeyResult = await runCollaborationJourney(driver, {
      origin: options.origin,
      label: options.label,
      promptMarker: PROMPT_MARKER,
      ...(options.expectedAppAsset === undefined ? {} : { expectedAppAsset: options.expectedAppAsset }),
      announce: (announceAndroidStage<typeof ANDROID_COLLAB_STAGES>).bind(null, ANDROID_COLLAB_STAGES),
    });
    return {
      packageName: driver.packageName,
      androidPackageVersion: driver.androidPackageVersion,
      ...journeyResult,
    };
  }, options.execution === undefined ? {} : { execution: options.execution });
}

if (import.meta.main) {
  const result = await runAndroidCollabSmoke(parseAndroidCollabSmokeArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
