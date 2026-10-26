#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AuthMode,
  captureGatewayConfigFile,
  defaultGatewayPaths,
  FLEET_CONFIG_SINCE_VERSION,
  type GatewayConfig,
  loadGatewayConfig,
  loadOrCreateReadinessToken,
  loadReadinessToken,
  loopbackHttpOrigin,
  projectPreFleetConfig,
  projectPreTernConfig,
  publicOriginHttpsPort,
  restoreGatewayConfigFile,
  removeLegacyPublisherToken,
  rotateReadinessToken,
  writeGatewayConfigFile,
  writePrivateTextFile,
} from "./config.ts";
import { createDiagnosticsBundle } from "./diagnostics.ts";
import { gatewayReady, loopbackHttpResponds, runDoctorChecks } from "./doctor.ts";
import { startHttpServer } from "./http.ts";
import {
  activateRuntime,
  activationState,
  currentInstalledRuntime,
  GATEWAY_VERSION,
  pruneSupersededRuntimes,
  resolveRollbackTarget,
  stageRuntimePayload,
} from "./installation.ts";
import { OmpHostReader, OmpLaunchResolver, startHostPoller } from "./omp-registry.ts";
import { assertQualificationLogDirectory, QualificationLogSink, SafeLogger } from "./logger.ts";
import { PushService } from "./push.ts";
import { SessionCreationService } from "./tern-creation.ts";
import { SessionRegistry } from "./registry.ts";
import {
  assertServiceInstallPreflight,
  assertUserServiceOwnership,
  installUserService,
  serviceDefinitionPath,
  uninstallUserService,
  stopUserService,
  userServiceStatus,
} from "./service.ts";
import { StaticAssetStore } from "./static.ts";

interface ParsedArguments {
  readonly command: string;
  readonly values: ReadonlyMap<string, readonly string[]>;
}

const MISSING_OPTION_VALUE = "\0";

/**
 * Cadence for confirming the registry socket path still resolves to the live listener. The OS can
 * remove it underneath a long-lived daemon (macOS reaps idle `TMPDIR` entries), which silently
 * stops every publisher from connecting while HTTP keeps serving.
 */
const ENDPOINT_WATCHDOG_INTERVAL_MS = 15_000;

/** Gap between readiness attempts while a freshly (re)installed service is still starting. */
const READINESS_POLL_INTERVAL_MS = 100;

/** Pause between the two service-status reads that distinguish "running" from "still running". */
const SERVICE_STABILITY_PAUSE_MS = 200;

/**
 * How long a newly installed service gets to answer an authenticated loopback readiness probe.
 * Linux and macOS keep the original 15 s: nothing on their startup path spawns a subprocess, so a
 * daemon that has not answered in 15 s is not slow, it is broken.
 *
 * Windows needs far more, and the figure is measured rather than padded. Every private path the
 * daemon touches is verified by spawning `powershell.exe` (`config.ts`, `applyWindowsAcl` and
 * `assertWindowsAclPrivate`), and `runServe` reaches ten of those spawns before `startHttpServer`
 * binds the listener: one for `config.json`, five for `loadOrCreateReadinessToken` (two per created
 * directory plus the token file), and four more when `PushService.open` re-verifies the same
 * directories. On the 2-vCPU Server 2025 host in `docs/WINDOWS_QUALIFICATION.md` a single cold
 * spawn averaged 1854 ms, which puts cold startup at ~18.5 s — matching the ~18 s that host's
 * daemon stayed alive without ever binding, and explaining why a 15 s budget rolled back a service
 * that was progressing normally (issue #90). Hosted CI has recorded the same spawn at 685 ms,
 * 13.7 s and >30 s, so the budget absorbs variance, not just the mean.
 *
 * 60 s is ~3.2x that measured cold startup and remains a hard ceiling: the probe itself is
 * unchanged, so a service that never binds still fails closed and still rolls back, just later.
 */
const READINESS_BUDGET_MS = 15_000;
const WINDOWS_READINESS_BUDGET_MS = 60_000;

/**
 * Exported so the budget can be asserted per platform without reassigning `process.platform`,
 * mirroring how `service.ts` threads `platform` through its own definition builders.
 */
export function readinessBudgetMs(platform: typeof process.platform = process.platform): number {
  return platform === "win32" ? WINDOWS_READINESS_BUDGET_MS : READINESS_BUDGET_MS;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const command = argv[0] ?? "help";
  const values = new Map<string, string[]>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || !argument.startsWith("--")) throw new Error(`unexpected argument: ${argument ?? ""}`);
    const [name, inlineValue] = argument.split("=", 2);
    if (name === undefined) throw new Error("invalid option");
    const next = argv[index + 1];
    const value = inlineValue ?? (next !== undefined && !next.startsWith("--") ? next : MISSING_OPTION_VALUE);
    if (inlineValue === undefined && value === next) index += 1;
    const existing = values.get(name) ?? [];
    existing.push(value);
    values.set(name, existing);
  }
  return { command, values };
}

function optionValues(arguments_: ParsedArguments, name: string): readonly string[] {
  const values = arguments_.values.get(name) ?? [];
  if (values.includes(MISSING_OPTION_VALUE)) throw new Error(`${name} requires a value`);
  return values;
}

const COMMAND_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  serve: new Set(["--dev-localhost", "--port", "--origin", "--readiness-instance", "--qualification-log-dir"]),
  install: new Set(["--origin", "--allow", "--port", "--no-start", "--qualification-log-dir"]),
  uninstall: new Set(["--no-stop"]),
  rollback: new Set(["--to", "--qualification-log-dir"]),
  status: new Set(),
  doctor: new Set(["--bundle", "--output"]),
  "rotate-readiness-token": new Set(["--qualification-log-dir"]),
  "serve-guidance": new Set(),
  help: new Set(),
  "--help": new Set(),
};

function validateCommandOptions(arguments_: ParsedArguments): void {
  const allowed = COMMAND_OPTIONS[arguments_.command];
  if (allowed === undefined) return;
  for (const name of arguments_.values.keys()) {
    if (!allowed.has(name)) throw new Error(`unknown option for ${arguments_.command}: ${name}`);
  }
}

function oneOption(arguments_: ParsedArguments, name: string): string | undefined {
  const values = optionValues(arguments_, name);
  if (values.length === 0) return undefined;
  if (values.length !== 1) throw new Error(`${name} may be supplied once`);
  return values[0];
}

function hasFlag(arguments_: ParsedArguments, name: string): boolean {
  const values = arguments_.values.get(name);
  if (values === undefined) return false;
  if (values.length !== 1) throw new Error(`${name} may be supplied once`);
  if (values[0] !== MISSING_OPTION_VALUE) throw new Error(`${name} does not accept a value`);
  return true;
}

function numericOption(arguments_: ParsedArguments, name: string): number | undefined {
  const value = oneOption(arguments_, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be an integer`);
  return Number(value);
}

async function runServe(arguments_: ParsedArguments): Promise<void> {
  const mode: AuthMode | undefined = hasFlag(arguments_, "--dev-localhost") ? "dev-localhost" : undefined;
  const port = numericOption(arguments_, "--port");
  const publicOrigin = oneOption(arguments_, "--origin");
  const readinessInstance = oneOption(arguments_, "--readiness-instance");
  if (readinessInstance !== undefined && !/^[A-Za-z0-9_-]{43}$/u.test(readinessInstance)) {
    throw new Error("--readiness-instance must be a 256-bit base64url value");
  }
  const config = await loadGatewayConfig({
    ...(mode === undefined ? {} : { mode }),
    ...(port === undefined ? {} : { port }),
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
  });
  const token = await loadOrCreateReadinessToken(config);
  const webRoot = resolve(fileURLToPath(new URL("../../web/dist/", import.meta.url)));
  const staticAssets = await StaticAssetStore.load(webRoot);
  const logDirectory = oneOption(arguments_, "--qualification-log-dir");
  const sink = logDirectory === undefined ? undefined : new QualificationLogSink(logDirectory);
  const logger = new SafeLogger(sink);
  const registry = new SessionRegistry({
    ttlSeconds: config.registry.ttlSeconds,
    maxSessions: config.registry.maxSessions,
    onListenerError: () => logger.event("warn", "registry.listener_failed"),
  });
  const reader = new OmpHostReader({
    directory: config.omp.discoveryDir,
    maxEntries: config.registry.maxSessions,
    timeoutMs: config.omp.queryTimeoutMs,
    onFault: (event, detail) => logger.event("warn", event, detail),
  });
  const launchResolver = new OmpLaunchResolver({ registry, reader });
  const pushService = await PushService.open({ config, registry, logger });
  const poller = startHostPoller({
    reader,
    registry,
    intervalMs: config.registry.heartbeatSeconds * 1_000,
    onEvent: (event, detail) => logger.event("info", event, detail),
  });
  const creationService = await SessionCreationService.open({ config, poller, registry });
  let stopping = false;
  let resolveStop: () => void = () => undefined;
  const stopped = new Promise<void>(resolve => {
    resolveStop = resolve;
  });
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    resolveStop();
  };
  let http: Bun.Server<undefined> | undefined;
  let sweeper: ReturnType<typeof setInterval> | undefined;
  const loggingHealth = sink === undefined ? undefined : setInterval(() => {
    if (!sink.healthy) { process.exitCode = 1; stop(); }
  }, 1_000);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    http = startHttpServer({
      config,
      registry,
      launchResolver,
      staticAssets,
      logger,
      pushService,
      creationService,
      readinessToken: token,
      ...(readinessInstance === undefined ? {} : { readinessInstance }),
      endpointHealthy: () => poller.discoveryHealthy,
    });
    // The poller refreshes liveness for hosts that answer; the sweeper retires the ones that stay
    // unreadable past the TTL, so a host whose socket hangs cannot linger in the directory forever.
    sweeper = setInterval(() => {
      const removed = registry.sweepExpired();
      if (removed > 0) logger.event("info", "registry.expired", { removed });
    }, Math.max(1_000, Math.floor((config.registry.ttlSeconds * 1_000) / 3)));
    await stopped;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    clearInterval(sweeper);
    clearInterval(loggingHealth);
    poller.stop();
    try {
      http?.stop(true);
    } finally {
      try {
        await creationService.stop();
      } finally {
        await pushService.stop();
      }
    }
  }
}

/**
 * Polls `probe` until it proves readiness or `budgetMs` elapses, whichever comes first. Separated
 * from `waitForGateway` purely as a test seam: the deadline is the part of install that rolled back
 * a healthy Windows service, and it is only worth trusting if it can be exercised against a virtual
 * clock instead of a real 60 s wall-clock wait. The probe is untouched by the split, so this adds no
 * retry that could make a dead service look alive — it only decides how long to keep asking.
 */
export async function pollUntilReady(
  budgetMs: number,
  probe: () => Promise<boolean>,
  clock: { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> } = {
    now: Date.now,
    sleep: Bun.sleep,
  },
): Promise<boolean> {
  const deadline = clock.now() + budgetMs;
  while (clock.now() < deadline) {
    if (await probe()) return true;
    await clock.sleep(READINESS_POLL_INTERVAL_MS);
  }
  return false;
}

async function waitForGateway(
  config: GatewayConfig,
  readinessToken: string,
  readinessInstance?: string,
  requireManagedService = false,
): Promise<void> {
  const ready = await pollUntilReady(readinessBudgetMs(), async () => {
    if (!(await gatewayReady(config, readinessToken, readinessInstance))) return false;
    if (!requireManagedService) return true;
    const service = await userServiceStatus(config);
    if (!service.installed || !service.active) return false;
    await Bun.sleep(SERVICE_STABILITY_PAUSE_MS);
    const stableService = await userServiceStatus(config);
    return stableService.installed && stableService.active && (await gatewayReady(config, readinessToken));
  });
  if (!ready) throw new Error("service installed but the loopback readiness proof did not become valid");
}

async function runInstall(arguments_: ParsedArguments): Promise<void> {
  const logDirectory = oneOption(arguments_, "--qualification-log-dir");
  if (logDirectory !== undefined) assertQualificationLogDirectory(logDirectory);
  const origin = oneOption(arguments_, "--origin");
  const allowedLogins = optionValues(arguments_, "--allow");
  if (origin === undefined) throw new Error("install requires --origin https://host.tailnet.ts.net");
  const port = numericOption(arguments_, "--port");
  const activate = !hasFlag(arguments_, "--no-start");
  await assertServiceInstallPreflight(activate);
  const configSnapshot = await captureGatewayConfigFile();
  let config: Awaited<ReturnType<typeof writeGatewayConfigFile>> | undefined;
  let runtime: Awaited<ReturnType<typeof stageRuntimePayload>> | undefined;
  let priorRuntime: Awaited<ReturnType<typeof currentInstalledRuntime>> | undefined;
  let priorService: Awaited<ReturnType<typeof userServiceStatus>> | undefined;
  let priorConfig: Awaited<ReturnType<typeof loadGatewayConfig>> | undefined;
  let repairPriorToken = false;
  if (configSnapshot.content !== undefined) {
    priorConfig = await loadGatewayConfig({ configPath: configSnapshot.path });
    priorService = await userServiceStatus(priorConfig);
    if (priorService.active && !priorService.installed) {
      throw new Error("refusing install while an unmanaged gateway service is active");
    }
    if (!activate && priorService.active) {
      throw new Error("refusing --no-start while the gateway service is active");
    }
    let priorToken: string | undefined;
    try {
      priorToken = await loadReadinessToken(priorConfig);
    } catch (error) {
      if (priorService.active) {
        throw new Error("refusing install while the active gateway readiness token is unavailable", { cause: error });
      }
      if (await loopbackHttpResponds(priorConfig)) {
        throw new Error("refusing install while the prior loopback endpoint is occupied and cannot be authenticated", {
          cause: error,
        });
      }
      repairPriorToken = true;
    }
    if (priorToken !== undefined && !priorService.active && (await gatewayReady(priorConfig, priorToken))) {
      throw new Error("refusing install while an authenticated unmanaged gateway listener is active");
    }
    priorRuntime = priorService.installed ? await currentInstalledRuntime(priorConfig) : undefined;
    if (priorService.installed && priorRuntime === undefined) {
      throw new Error("refusing install without a verified prior runtime");
    }
  }
  let serviceAttempted = false;
  try {
    config = await writeGatewayConfigFile({
      publicOrigin: origin,
      allowedLogins,
      ...(port === undefined ? {} : { port }),
    });
    const webRoot = resolve(fileURLToPath(new URL("../../web/dist/", import.meta.url)));
    await StaticAssetStore.load(webRoot);
    priorService ??= await userServiceStatus(config);
    if (configSnapshot.content === undefined && priorService.installed) {
      throw new Error("refusing install of an existing service without a prior config");
    }
    const sameEndpoint =
      priorConfig !== undefined &&
      priorConfig.http.hostname === config.http.hostname &&
      priorConfig.http.port === config.http.port;
    const readinessToken = repairPriorToken ? await rotateReadinessToken(config) : await loadOrCreateReadinessToken(config);
    // Mainline OMP never authenticates to the gateway, so a fork-era publisher credential left in
    // the config directory is a live secret with no consumer. Install is where it goes away.
    if (await removeLegacyPublisherToken(config)) {
      console.log("Removed the retired OMP publisher token; mainline OMP needs no gateway credential.");
    }
    if ((!priorService.active || !sameEndpoint) && (await gatewayReady(config, readinessToken))) {
      throw new Error("refusing install while an authenticated unmanaged gateway listener is active");
    }
    runtime = await stageRuntimePayload(config);
    serviceAttempted = true;
    const readinessInstance = randomBytes(32).toString("base64url");
    const definition = await installUserService(config, activate, runtime.cliPath, readinessInstance, undefined, runtime.qualificationLogProtocol === "structured-v1" ? logDirectory : undefined);
    if (activate) await waitForGateway(config, readinessToken, readinessInstance);
    await activateRuntime(config, runtime);
    console.log(
      `Installed ${definition.identifier} from ${runtime.directory}; loopback health ${activate ? "ready" : "not started"}.`,
    );
    console.log(
      `Configure Tailscale Serve: tailscale serve --bg --https=${publicOriginHttpsPort(config.http.publicOrigin)} ${loopbackHttpOrigin(config.http.hostname, config.http.port)}`,
    );
    console.log("Do not enable Tailscale Funnel.");
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    let restoredConfig: Awaited<ReturnType<typeof loadGatewayConfig>> | undefined;
    try {
      await restoreGatewayConfigFile(configSnapshot);
      if (configSnapshot.content !== undefined) {
        restoredConfig = await loadGatewayConfig({ configPath: configSnapshot.path });
      }
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (serviceAttempted && config !== undefined) {
      try {
        if (priorService?.installed === true && priorRuntime !== undefined && restoredConfig !== undefined) {
          const priorToken = await loadReadinessToken(restoredConfig);
          const rollbackInstance =
            priorRuntime.readinessProtocol === "instance-v1" ? randomBytes(32).toString("base64url") : undefined;
          await installUserService(restoredConfig, priorService.active, priorRuntime.cliPath, rollbackInstance, undefined, priorRuntime.qualificationLogProtocol === "structured-v1" ? logDirectory : undefined);
          if (priorService.active) {
            await waitForGateway(
              restoredConfig,
              priorToken,
              rollbackInstance,
              priorRuntime.readinessProtocol === "legacy",
            );
          }
          await activateRuntime(restoredConfig, priorRuntime);
        } else if (priorService?.installed !== true) {
          await uninstallUserService(config, true);
        } else {
          throw new Error("prior gateway service could not be restored");
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "gateway install failed and rollback was incomplete");
    }
    throw error;
  }
  // Cleanup is outside the revert boundary and only follows a readiness-proven activation.
  // --no-start commits a stopped runtime but cannot prove it is safe to discard older payloads.
  if (activate && config !== undefined) {
    const counts = await pruneSupersededRuntimes(config, serviceDefinitionPath(config));
    console.log(`Staged runtimes: retained ${counts.retained}, removed ${counts.removed}, failed ${counts.failed}.`);
  }
}

async function runUninstall(arguments_: ParsedArguments): Promise<void> {
  const servicePaths = { paths: defaultGatewayPaths() };
  await uninstallUserService(servicePaths, !hasFlag(arguments_, "--no-stop"));
  console.log("Uninstalled omp-session-gateway service. Configuration and readiness token were preserved.");
}

async function runRollback(arguments_: ParsedArguments): Promise<void> {
  const logDirectory = oneOption(arguments_, "--qualification-log-dir");
  if (logDirectory !== undefined) assertQualificationLogDirectory(logDirectory);
  const requested = oneOption(arguments_, "--to");
  const config = await loadGatewayConfig();
  const service = await userServiceStatus(config);
  if (service.active && !service.installed) {
    throw new Error("refusing rollback while an unmanaged gateway service is active");
  }
  if (!service.installed) throw new Error("refusing rollback without an installed gateway service");
  const target = await resolveRollbackTarget(config, requested);
  const readinessToken = await loadReadinessToken(config);
  const targetVersion = basename(target.runtime.directory).slice(0, -13);
  const configSnapshot = await captureGatewayConfigFile(config.paths.configPath);
  let projection = configSnapshot.content === undefined
    ? undefined : projectPreTernConfig(JSON.parse(configSnapshot.content) as unknown);
  if (projection && Bun.semver.order(targetVersion, FLEET_CONFIG_SINCE_VERSION) < 0) {
    const fleet = projectPreFleetConfig(projection.document);
    projection = { document: fleet.document, removedKeys: [...projection.removedKeys, ...fleet.removedKeys] };
  }
  const backupPath = join(config.paths.configDir, "config.pre-rollback.json");
  if (projection !== undefined && projection.removedKeys.length > 0) {
    try {
      await writePrivateTextFile(backupPath, configSnapshot.content!, { exclusive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`refusing rollback because ${backupPath} already exists; restore or move that backup first`);
      }
      throw error;
    }
  }
  let configProjected = false;
  try {
    if (projection !== undefined && projection.removedKeys.length > 0) {
      configProjected = true;
      await writePrivateTextFile(config.paths.configPath, `${JSON.stringify(projection.document, null, 2)}\n`);
      console.log(
        `Saved the full authored configuration to ${backupPath}; removed ${projection.removedKeys.join(", ")} from ${config.paths.configPath} for runtime ${targetVersion}.`,
      );
      console.log(
        `To restore: install a runtime supporting every saved configuration section, replace ${config.paths.configPath} with ${backupPath}, restart the gateway, and reload the PWA. Tern creation requires explicit re-enablement.`,
      );
    }
    // Same commit order as install: the service definition is rewritten first and `current.json`
    // only advances once the predecessor has proven readiness. See `activationState`.
    const readinessInstance =
      target.runtime.readinessProtocol === "instance-v1" ? randomBytes(32).toString("base64url") : undefined;
    const definition = await installUserService(config, service.active, target.runtime.cliPath, readinessInstance, undefined, target.runtime.qualificationLogProtocol === "structured-v1" ? logDirectory : undefined);
    if (service.active) {
      await waitForGateway(config, readinessToken, readinessInstance, target.runtime.readinessProtocol === "legacy");
    }
    await activateRuntime(config, target.runtime);
    console.log(
      `Rolled back ${definition.identifier} from ${target.from} to ${basename(target.runtime.directory)} (${target.selection}); loopback health ${service.active ? "ready" : "not started"}.`,
    );
    console.log(configProjected ? "Readiness token was preserved." : "Configuration and readiness token were preserved.");
  } catch (error) {
    // The pointer never moved, so it still names the runtime that was last proven ready. Rebuilding
    // service definition from it is the repair half of the pointer-is-authority invariant.
    const repairErrors: unknown[] = [];
    if (configProjected) {
      try {
        await restoreGatewayConfigFile(configSnapshot);
        console.log(`Rollback failed; restored the authored configuration. The backup remains at ${backupPath}.`);
      } catch (repairError) {
        repairErrors.push(repairError);
      }
    }
    try {
      const authoritative = await currentInstalledRuntime(config);
      if (authoritative === undefined) throw new Error("current.json no longer names a verified installed runtime");
      const repairInstance =
        authoritative.readinessProtocol === "instance-v1" ? randomBytes(32).toString("base64url") : undefined;
      await installUserService(config, service.active, authoritative.cliPath, repairInstance, undefined, authoritative.qualificationLogProtocol === "structured-v1" ? logDirectory : undefined);
      if (service.active) {
        await waitForGateway(config, readinessToken, repairInstance, authoritative.readinessProtocol === "legacy");
      }
    } catch (repairError) {
      repairErrors.push(repairError);
    }
    if (repairErrors.length > 0) {
      throw new AggregateError(
        [error, ...repairErrors],
        "gateway rollback failed and the service definition could not be rebuilt from current.json",
      );
    }
    throw error;
  }
}

async function runStatus(): Promise<void> {
  const config = await loadGatewayConfig();
  const readinessToken = await loadReadinessToken(config);
  const [ready, service, activation] = await Promise.all([
    gatewayReady(config, readinessToken),
    userServiceStatus(config),
    activationState(config, serviceDefinitionPath(config)),
  ]);
  console.log(
    JSON.stringify({
      service: "omp-session-gateway",
      installed: service.installed,
      active: service.active,
      ready,
      authMode: config.auth.mode,
      activeVersion: activation.pointerVersion ?? null,
      serviceVersion: activation.serviceVersion ?? null,
      diverged: activation.diverged,
    }),
  );
  if (activation.diverged) {
    console.error(
      "DIVERGED: the installed service definition does not execute the version current.json names. " +
        "status only reports this and changes nothing; run `omp-gateway rollback --to <version>` or " +
        "reinstall to rewrite the service definition from current.json.",
    );
  }
  if (!ready || !service.installed || !service.active || activation.diverged) process.exitCode = 1;
}

async function runDoctor(arguments_: ParsedArguments): Promise<void> {
  const report = await runDoctorChecks();
  const shouldBundle = hasFlag(arguments_, "--bundle");
  if (shouldBundle) {
    const destination = resolve(oneOption(arguments_, "--output") ?? "omp-gateway-diagnostics.tar");
    const bundle = await createDiagnosticsBundle(report, destination);
    console.log(
      JSON.stringify({
        ...report,
        bundle: { file: basename(destination), bytes: bundle.bytes, sha256: bundle.sha256 },
      }),
    );
  } else {
    console.log(JSON.stringify(report));
  }
  if (Object.values(report.checks).some(value => !value)) process.exitCode = 1;
}

async function runRotateToken(arguments_: ParsedArguments): Promise<void> {
  const logDirectory = oneOption(arguments_, "--qualification-log-dir");
  if (logDirectory !== undefined) assertQualificationLogDirectory(logDirectory);
  const config = await loadGatewayConfig();
  await assertUserServiceOwnership(config);
  const service = await userServiceStatus(config);
  if (service.active && !service.installed) {
    throw new Error("refusing token rotation while an unmanaged gateway service is active");
  }
  const runtime = service.active ? await currentInstalledRuntime(config) : undefined;
  if (service.active && runtime === undefined) {
    throw new Error("refusing token rotation without a verified installed runtime");
  }
  const readinessToken = await rotateReadinessToken(config);
  if (service.active && runtime !== undefined) {
    const readinessInstance =
      runtime.readinessProtocol === "instance-v1" ? randomBytes(32).toString("base64url") : undefined;
    try {
      await installUserService(config, true, runtime.cliPath, readinessInstance, undefined, runtime.qualificationLogProtocol === "structured-v1" ? logDirectory : undefined);
      await waitForGateway(config, readinessToken, readinessInstance, runtime.readinessProtocol === "legacy");
    } catch (error) {
      try {
        await stopUserService(config);
      } catch (stopError) {
        throw new AggregateError(
          [error, stopError],
          "readiness token rotated and retained, but gateway restart and fail-closed service stop both failed",
        );
      }
      throw new Error(
        "readiness token rotated and retained, but gateway restart failed; the service was stopped and must be reinstalled",
        { cause: error },
      );
    }
    console.log("Readiness token rotated. Active gateway restarted.");
  } else {
    console.log("Readiness token rotated. Start the gateway to use the new readiness credential.");
  }
}

async function runServeGuidance(): Promise<void> {
  const config = await loadGatewayConfig();
  console.log(
    `tailscale serve --bg --https=${publicOriginHttpsPort(config.http.publicOrigin)} ${loopbackHttpOrigin(config.http.hostname, config.http.port)}`,
  );
  console.log(`Allowlisted logins: ${config.auth.allowedLogins.length}. Keep tailnet grants restricted to the intended user/device.`);
  console.log("Tailscale Funnel is unsupported and must remain disabled.");
  console.log(
    "Fleet setup: the dashboard lists each target in fleet.targets; each target separately trusts the dashboard's exact origin in http.trustedDashboardOrigins and allows the Tailscale login in auth.allowedLogins. Reload the PWA after configuration changes.",
  );
}

function printHelp(): void {
  console.log(`OMP Session Gateway ${GATEWAY_VERSION}

Usage:
  omp-gateway install --origin https://host.tailnet.ts.net --allow user@example.com [--no-start]
  omp-gateway uninstall [--no-stop]
  omp-gateway rollback [--to 0.1.0-0123456789ab]
  omp-gateway status
  omp-gateway doctor [--bundle] [--output omp-gateway-diagnostics.tar]
  omp-gateway serve-guidance
  omp-gateway rotate-readiness-token
  omp-gateway serve [--dev-localhost] [--port 4317] [--origin http://127.0.0.1:4317]
  omp-gatewayd

Fleet is opt-in in config.json: the dashboard lists fleet.targets, and each target trusts the
dashboard's exact origin in http.trustedDashboardOrigins. The Tailscale login must separately be
allowed at the target. Reload the PWA after configuration changes. Browser speech recognition is
off unless speech.browserRecognition is true.
`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const daemonInvocation = basename(process.argv[1] ?? "") === "omp-gatewayd";
  const parsed = parseArguments(daemonInvocation && argv.length === 0 ? ["serve"] : argv);
  validateCommandOptions(parsed);
  if (parsed.command === "serve") await runServe(parsed);
  else if (parsed.command === "install") await runInstall(parsed);
  else if (parsed.command === "uninstall") await runUninstall(parsed);
  else if (parsed.command === "rollback") await runRollback(parsed);
  else if (parsed.command === "status") await runStatus();
  else if (parsed.command === "doctor") await runDoctor(parsed);
  else if (parsed.command === "rotate-readiness-token") await runRotateToken(parsed);
  else if (parsed.command === "serve-guidance") await runServeGuidance();
  else if (parsed.command === "help" || parsed.command === "--help") printHelp();
  else throw new Error(`unknown command: ${parsed.command}`);
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : "gateway command failed");
    process.exitCode = 1;
  });
}
