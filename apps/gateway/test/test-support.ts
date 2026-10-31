/**
 * Hang detection only, never a product latency assertion or a settling sleep. Recent hosted
 * `gh run view --log` samples (2026-10-30, Compatibility runs 41142971233 and 41142942509)
 * reached 30,045.06 ms for the admission helper and 9,407.65 ms for cold Node/Percy startup;
 * the install-pruning CLI was killed by its 5 s race at 6,640.29 ms including teardown.
 * 120 s gives almost 4x the longest observation and also covers two 45 s Windows ACL cold
 * attempts plus teardown. Race completion/readiness against this budget: success never waits.
 * Outer test timeouts must additionally cover setup, sequential attempts, and cleanup (normally
 * at least 2 * HANG_DEADLINE_MS). Keep short behavioral deadlines explicit and annotated with
 * `hang-deadline: behavior-under-test -- reason`; do not increase product timeouts to fix tests.
 * Evidence: https://github.com/carrythroughsystems/omp-session-gateway/actions/runs/41142971233
 *           https://github.com/carrythroughsystems/omp-session-gateway/actions/runs/41142942509
 */
export const HANG_DEADLINE_MS = 120_000;
