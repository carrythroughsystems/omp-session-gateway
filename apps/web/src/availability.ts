export type SourceStatus = "loading" | "fresh" | "refreshing" | "stale" | "expired" | "unavailable" | "forbidden" | "withdrawn";

export interface SourceAvailability {
  readonly status: SourceStatus;
  readonly current: boolean;
  readonly failed: boolean;
  readonly retry: boolean;
  readonly observedAt: number | undefined;
  readonly time: string | undefined;
  readonly copy: string;
}

const freshnessClock = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });

/** A successful observation, never the time a failed check happened. */
export function sourceAvailability(status: SourceStatus, freshAt?: number): SourceAvailability {
  const observedAt = status === "withdrawn" ? undefined : freshAt;
  const time = observedAt === undefined ? undefined : freshnessClock.format(observedAt);
  return {
    status,
    current: status === "fresh",
    failed: status === "stale" || status === "expired" || status === "unavailable" || status === "forbidden" || status === "withdrawn",
    retry: status === "stale" || status === "expired" || status === "unavailable",
    observedAt,
    time,
    copy: status === "withdrawn" ? "The previous session list was withdrawn."
      : time === undefined ? "No session list received yet." : `List as of ${time}.`,
  };
}

export function scopeCoverage(sources: readonly SourceAvailability[], bootstrapFailed = false) {
  const fresh = sources.filter(source => source.current).length;
  const failed = bootstrapFailed || sources.some(source => source.failed);
  return {
    complete: !bootstrapFailed && fresh === sources.length,
    failed,
    title: failed ? "Host coverage incomplete" : "Checking host coverage",
    copy: bootstrapFailed ? "The configured hosts could not be confirmed."
      : `${fresh} of ${sources.length} host${sources.length === 1 ? "" : "s"} up to date. ${failed ? "Other sessions may be missing." : "Refreshing the rest."}`,
  };
}
