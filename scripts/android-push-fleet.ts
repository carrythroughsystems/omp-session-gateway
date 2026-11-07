import type { PushDetailLevel, SessionMetadata } from "../packages/protocol/src/types.ts";
import { fleetNotificationTag } from "../packages/protocol/src/fleet-ordering.ts";
import { notificationTopicDigest } from "./android-notification.ts";
import type { AndroidPushPhase, AndroidPushProgress, AndroidPushRuntime, PushFixtureRole } from "./android-push-qualification.ts";
import type { PushFixtureCommand } from "./fixtures/push-qualification-extension.ts";
import type { FleetFixtureOperation } from "./fleet-push-fixture.ts";

export const FLEET_PUSH_PHASES = ["fleet_enrolled", "fleet_private_verified", "fleet_session_verified", "fleet_preview_verified",
  "fleet_race_verified", "fleet_taps_verified", "fleet_stale_taps_verified", "fleet_outage_verified", "fleet_restart_verified",
  "fleet_revocation_verified", "fleet_sinks_verified", "fleet_restored"] as const;
export const FLEET_PUSH_RESULT_FIELDS = {
  fleet_enrolled: ["selected", "covered", "distinctOrigins", "devtoolsObserver"],
  fleet_private_verified: ["local", "remote", "identity", "previewFallback", "deduplicated", "devtoolsObserver"],
  fleet_session_verified: ["local", "remote", "identity", "previewFallback", "deduplicated", "devtoolsObserver"],
  fleet_preview_verified: ["local", "remote", "identity", "previewFallback", "deduplicated", "devtoolsObserver"],
  fleet_race_verified: ["concurrent", "exactClear", "replacement", "badgeReconciled", "devtoolsObserver"],
  fleet_taps_verified: ["local", "remote", "exactRequest", "scrubbed", "devtoolsObserver"],
  fleet_stale_taps_verified: ["resolved", "replaced", "expired", "launches", "replayed", "devtoolsObserver"],
  fleet_outage_verified: ["stale", "lastKnownKept", "badgeFlag", "recovered", "devtoolsObserver"],
  fleet_restart_verified: ["exactClear", "noRepeats", "newAsk", "badgeReconciled", "devtoolsObserver"],
  fleet_revocation_verified: ["unauthorized", "cleared", "launches", "devtoolsObserver"],
  fleet_sinks_verified: ["clean", "detectable", "sinks", "findings", "devtoolsObserver"],
  fleet_restored: ["restored", "grantsRemoved", "sourceStopped", "serveRestored", "devtoolsObserver"],
} as const;

export interface FleetPushRuntime {
  readonly binding: string;
  host(operation: FleetFixtureOperation, epoch: string): Promise<void>;
  select(enabled: boolean): Promise<void>;
  /** Reads the Hosts row in the installed PWA, not a synthetic enrollment API client. */
  coverage(): Promise<{ selected: boolean; state: string; covered: boolean }>;
  /** Observes the real worker's calls; the wrapper forwards unchanged to the platform. */
  observeBadge(): Promise<{ count: number; complete: boolean;
    call?: { method: "setAppBadge" | "clearAppBadge"; arguments: number; argument?: number | "undefined" } } | undefined>;
  armBadgeObserver(): Promise<void>;
  revoke(): Promise<void>;
  audit(epoch: string): Promise<Record<string, boolean | number>>;
}
interface FleetPhaseContext {
  runtime: AndroidPushRuntime; progress: AndroidPushProgress;
  save(): Promise<void>;
  attempt(phase: AndroidPushPhase, action: () => Promise<void>): Promise<void>;
  finish(phase: AndroidPushPhase, result: Record<string, boolean | number | string>): Promise<void>;
  fixture(operation: "start" | PushFixtureCommand, role?: PushFixtureRole): Promise<void>;
  snapshot(predicate: (session: SessionMetadata) => boolean, role?: PushFixtureRole): Promise<SessionMetadata>;
  delivered(session: SessionMetadata, kind?: "attention" | "activity_stop", detail?: PushDetailLevel): Promise<void>;
  clear(timeout?: number, role?: PushFixtureRole): Promise<void>;
  wait<T>(name: string, observe: () => Promise<T | undefined>, timeout?: number): Promise<T>;
  assertion(message: string): Error;
}

/** Additional phases of androidPush, sharing its checkpoints, failure typing and restoration owner. */
export async function runFleetPushPhases(c: FleetPhaseContext): Promise<void> {
  const { runtime: r, progress: p, fixture, snapshot, delivered, clear, wait, assertion } = c;
  const f = r.fleet;
  let observerAttached = false;
  let sinkAudit: Record<string, boolean | number> | undefined;
  let activePhase: AndroidPushPhase = "fleet_enrolled";
  const attempt: FleetPhaseContext["attempt"] = (phase, action) => {
    activePhase = phase;
    return c.attempt(phase, action);
  };
  const finish: FleetPhaseContext["finish"] = (phase, result) => c.finish(phase, { ...result, devtoolsObserver: observerAttached });
  const badge = async (step: string, count: number, complete: boolean) => {
    let last: Awaited<ReturnType<FleetPushRuntime["observeBadge"]>>;
    try {
      await wait(`fleet badge reconciliation: ${activePhase}/${step}`, async () => {
        last = await f.observeBadge();
        // A numeric badge cannot express completeness; the Hosts row proves that separately.
        return last?.count === count && (count > 0 || last.complete === complete) ? true : undefined;
      });
    } catch (error) {
      if (error instanceof Error) {
        const diagnostic = new Error(`Fleet badge ${activePhase}/${step} expected ${JSON.stringify({ count, complete })}; last observation ${JSON.stringify(last ?? null)}`);
        error.cause = error.cause === undefined ? diagnostic : new AggregateError([error.cause, diagnostic], "Fleet badge private diagnostics");
      }
      throw error;
    }
  };
  const ask = async (role: "primary" | "remote", detail: PushDetailLevel = "session") => {
    await fixture("ask", role);
    const session = await snapshot(s => s.inputRequired, role);
    await delivered(session, "attention", detail);
    return session;
  };
  const cold = async (detail: PushDetailLevel = "session") => {
    await r.detail(detail); await f.armBadgeObserver(); observerAttached = true; await r.closePwa(); await r.lock();
  };
  const expiredTap = async (session: SessionMetadata) => {
    await r.replay(session);
    const tap = await r.tap(session, "attention", true);
    if (tap.launches !== 0 || tap.successful !== 0 || !tap.scrubbedBeforeNetwork || !tap.expired || tap.writable || tap.readOnly) {
      throw assertion("Fleet remote stale tap issued a launch or did not expire");
    }
  };
  await attempt("fleet_enrolled", async () => {
    p.fleetPrepared = true;
    await c.save();
    await f.host("prepare", p.epoch);
    await fixture("start", "remote");
    const remote = await snapshot(s => s.canControl && !s.inputRequired, "remote");
    p.remoteNotificationTopicDigest = notificationTopicDigest(fleetNotificationTag(f.binding, remote.instanceId));
    await c.save();
    await r.beginNotificationPhase(p.epoch, "fleet_enrolled");
    await f.select(true);
    const coverage = await f.coverage();
    if (!coverage.selected || coverage.state !== "current" || !coverage.covered) throw assertion("Fleet Hosts toggle did not enroll the source");
    await finish("fleet_enrolled", { selected: true, covered: true, distinctOrigins: true });
  });
  for (const detail of ["private", "session", "preview"] as const) {
    await attempt(`fleet_${detail}_verified`, async () => {
      await cold(detail);
      await Promise.all([fixture("ask"), fixture("ask", "remote")]);
      const local = await snapshot(s => s.inputRequired), remote = await snapshot(s => s.inputRequired, "remote");
      await delivered(local, "attention", detail); await delivered(remote, "attention", detail);
      await badge("concurrent", 2, true);
      await r.pause(21_000);
      // observe() also compares OS post timestamps: replacing the same request fails deduplication.
      await delivered(local, "attention", detail); await delivered(remote, "attention", detail);
      if (detail === "private") {
        // Private rows deliberately have identical title/body. Keep the concurrent OS/tag/badge
        // proof above, then prove each lock-screen row alone instead of guessing which row is which.
        await clear(60_000, "remote");
        if (!await r.presentation(local, detail)) throw assertion("Fleet home Private presentation differed");
        await clear(); await cold(detail);
        const isolatedRemote = await ask("remote", detail);
        if (!await r.presentation(isolatedRemote, detail)) throw assertion("Fleet remote Private presentation differed");
        await clear(60_000, "remote");
      } else {
        if (!await r.presentation(local, detail) || !await r.presentation(remote, detail)) throw assertion("Fleet host identity or privacy presentation differed");
        await clear(); await clear(60_000, "remote");
      }
      await badge("settled", 0, true);
      await finish(`fleet_${detail}_verified`, { local: true, remote: true, identity: true, previewFallback: detail === "preview", deduplicated: true });
    });
  }
  await attempt("fleet_race_verified", async () => {
    await cold();
    const local = await ask("primary"), old = await ask("remote");
    await badge("concurrent", 2, true);
    // Replacement on a shared tag cannot prove the old request's clear.
    await clear(60_000, "remote"); await delivered(local); await badge("old-remote-cleared", 1, true);
    const fresh = await ask("remote");
    if (fresh.ask?.requestId === old.ask?.requestId) throw assertion("Fleet race did not replace its request");
    await r.pause(21_000);
    await delivered(fresh); await delivered(local); await badge("replacement", 2, true);
    await clear(); await delivered(fresh); await badge("local-cleared", 1, true);
    await r.openPwa(); await delivered(fresh); await badge("foreground", 1, true);
    await clear(60_000, "remote"); await badge("settled", 0, true);
    await finish("fleet_race_verified", { concurrent: true, exactClear: true, replacement: true, badgeReconciled: true });
  });
  await attempt("fleet_taps_verified", async () => {
    for (const role of ["primary", "remote"] as const) {
      await cold(); const session = await ask(role);
      const tap = await r.tap(session, "attention", false);
      if (tap.launches !== 1 || tap.successful !== 1 || !tap.currentGeneration || !tap.currentRequest || !tap.scrubbedBeforeNetwork || !tap.writable) {
        throw assertion("Fleet tap did not launch the exact source and request");
      }
      await r.answer(); await snapshot(s => !s.inputRequired, role); await clear(60_000, role);
      // Scan the same live Control capability the installed PWA just handled, before the
      // delayed-tap phase replaces/stops this remote fixture and invalidates that material.
      if (role === "remote") sinkAudit = await f.audit(p.epoch);
    }
    await finish("fleet_taps_verified", { local: true, remote: true, exactRequest: true, scrubbed: true });
  });
  await attempt("fleet_stale_taps_verified", async () => {
    await cold(); const resolved = await ask("remote"); await clear(60_000, "remote");
    await expiredTap(resolved);
    await cold(); const replaced = await ask("remote"); await clear(60_000, "remote");
    await fixture("replace", "remote");
    await snapshot(s => s.generation === replaced.generation + 1, "remote");
    await r.openPwa(); await ask("remote"); await expiredTap(replaced); await clear(60_000, "remote");
    await cold(); const gone = await ask("remote");
    await fixture("stop", "remote");
    await wait("remote unpublication", async () => await r.snapshot(p.epoch, "remote") === undefined ? true : undefined, 90_000);
    await wait("remote removal clear", async () => await r.notificationCleared(gone) ? true : undefined);
    await expiredTap(gone);
    await wait("stopped remote replay close", async () => await r.notificationCleared(gone) ? true : undefined);
    await fixture("start", "remote");
    const fresh = await snapshot(s => s.canControl && !s.inputRequired, "remote");
    // Keep both notification ownership digests until the old tag's cleanup was observed above.
    p.remoteNotificationTopicDigest = notificationTopicDigest(fleetNotificationTag(f.binding, fresh.instanceId)); await c.save();
    await r.beginNotificationPhase(p.epoch, "fleet_stale_taps_verified");
    await finish("fleet_stale_taps_verified", { resolved: true, replaced: true, expired: true, launches: 0, replayed: true });
  });
  await attempt("fleet_outage_verified", async () => {
    await cold(); const remote = await ask("remote");
    // Last-known asks belong to the open page's observed directory, not a fresh offline page.
    await r.openPwa();
    await wait("visible fleet ask before outage", async () => (await r.triage()).waiting.includes(remote.instanceId) ? true : undefined);
    await f.host("source-down", p.epoch);
    await wait("stale fleet source", async () => (await f.coverage()).state === "stale" ? true : undefined);
    if (!(await r.triage()).waiting.includes(remote.instanceId)) throw assertion("Fleet stale directory dropped its last-known waiting row");
    await delivered(remote); await badge("stale-waiting", 1, false);
    await f.host("source-up", p.epoch);
    await wait("fleet source recovery", async () => (await f.coverage()).state === "current" ? true : undefined, 90_000);
    await clear(60_000, "remote");
    // A push clear can zero the worker badge before this page receives the settled snapshot.
    // Establish the page's empty last-known state before making the source unreachable again.
    await wait("settled fleet directory before outage", async () => {
      const view = await r.triage();
      return !view.waiting.includes(remote.instanceId) && view.working.includes(remote.instanceId) ? true : undefined;
    });
    await badge("recovered-settled", 0, true);
    await f.host("source-down", p.epoch);
    await wait("stale empty fleet source", async () => (await f.coverage()).state === "stale" ? true : undefined);
    await badge("stale-empty", 0, false);
    await f.host("source-up", p.epoch);
    await wait("fleet source recovery", async () => (await f.coverage()).state === "current" ? true : undefined, 90_000);
    await badge("recovered-empty", 0, true);
    await finish("fleet_outage_verified", { stale: true, lastKnownKept: true, badgeFlag: true, recovered: true });
  });
  await attempt("fleet_restart_verified", async () => {
    await cold(); const local = await ask("primary"), old = await ask("remote");
    await f.host("coordinator-down", p.epoch);
    // Answer without a replacement while no coordinator can send. Only a restart-time
    // clear can now remove the old remote alert; the local alert must remain unchanged.
    await r.fixture("answer", p.epoch, "remote"); await snapshot(s => !s.inputRequired, "remote");
    await f.host("coordinator-up", p.epoch);
    await wait("restart remote exact clear", async () => await r.notificationCleared(old) ? true : undefined);
    await delivered(local);
    const quietWindow = await r.beginDeliveryTelemetry?.("fleet_restart_verified").catch(() => undefined);
    await badge("restart-exact-clear", 1, true);
    await r.pause(21_000); await delivered(local);
    const quiet = quietWindow === undefined ? undefined : await r.deliveryTelemetry?.(quietWindow).catch(() => undefined);
    // A complete, healthy coordinator log window with zero sends globally is stronger
    // than zero sends to this subscription. With the page still closed, retain the badge
    // verified inside this window; any push activity or unavailable log reads it fresh.
    if (quiet?.sends !== 0 || quiet.acknowledgements !== 0 || quiet.failures !== 0) await badge("restart-no-repeat", 1, true);
    const fresh = await ask("remote");
    if (fresh.ask?.requestId === old.ask?.requestId) throw assertion("Fleet restart did not replace its request");
    await delivered(local); await badge("new-ask", 2, true);
    await clear(); await delivered(fresh); await badge("local-cleared", 1, true);
    await clear(60_000, "remote"); await badge("settled", 0, true);
    await finish("fleet_restart_verified", { exactClear: true, noRepeats: true, newAsk: true, badgeReconciled: true });
  });
  await attempt("fleet_revocation_verified", async () => {
    await cold(); const remote = await ask("remote");
    await f.revoke();
    await wait("fleet authorization revocation", async () => (await f.coverage()).state === "unauthorized" ? true : undefined);
    await wait("revoked fleet clear", async () => await r.notificationCleared(remote) ? true : undefined);
    await expiredTap(remote);
    await fixture("answer", "remote"); await snapshot(s => !s.inputRequired, "remote");
    await finish("fleet_revocation_verified", { unauthorized: true, cleared: true, launches: 0 });
  });
  await attempt("fleet_sinks_verified", async () => {
    const audit = sinkAudit;
    if (audit === undefined) throw assertion("Fleet sink sweep did not observe the PWA's live remote Control launch");
    if (audit.clean !== true || audit.detectable !== true || audit.findings !== 0) throw assertion("Fleet forbidden sink sweep failed");
    await finish("fleet_sinks_verified", audit);
  });
  await attempt("fleet_restored", async () => {
    await r.cleanup("fleet", p);
    observerAttached = false;
    await finish("fleet_restored", { restored: true, grantsRemoved: true, sourceStopped: true, serveRestored: true });
  });
}
