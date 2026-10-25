import { expect, test } from "bun:test";
import { sourceAvailability, scopeCoverage, type SourceStatus } from "../src/availability";

const observedAt = Date.parse("2026-10-25T01:30:00Z");
const states: readonly [SourceStatus, boolean, boolean, boolean][] = [
  ["loading", false, false, false],
  ["fresh", true, false, false],
  ["refreshing", false, false, false],
  ["stale", false, true, true],
  ["expired", false, true, true],
  ["unavailable", false, true, true],
  ["forbidden", false, true, false],
];

for (const [status, current, failed, retry] of states) {
  test(`${status}: observation, coverage and recovery agree`, () => {
    const source = sourceAvailability(status, observedAt);
    expect(source).toMatchObject({ status, current, failed, retry });
    expect(source.copy).toBe(`List as of ${sourceAvailability("fresh", observedAt).time}.`);
    const coverage = scopeCoverage([sourceAvailability("fresh", observedAt), source]);
    expect(coverage).toMatchObject({ complete: current, failed });
    expect(coverage.copy).toBe(`${current ? 2 : 1} of 2 hosts up to date. ${failed ? "Other sessions may be missing." : "Refreshing the rest."}`);
    expect(coverage.title).toBe(failed ? "Host coverage incomplete" : "Checking host coverage");
    expect(scopeCoverage([source], true)).toMatchObject({
      complete: false, failed: true, copy: "The configured hosts could not be confirmed.",
    });
  });
}

test("an absent observation never invents a timestamp; equal instants are byte-identical", () => {
  expect(sourceAvailability("unavailable").copy).toBe("No session list received yet.");
  expect(sourceAvailability("loading").time).toBeUndefined();
  expect(sourceAvailability("stale", observedAt).copy).toBe(sourceAvailability("expired", observedAt).copy);
  expect(scopeCoverage([sourceAvailability("refreshing", observedAt)]).copy).toBe("0 of 1 host up to date. Refreshing the rest.");
});

test("counterexample: a withdrawn observation cannot reuse its old timestamp as an empty-list certificate", () => {
  const withdrawn = sourceAvailability("withdrawn", observedAt);
  expect(withdrawn).toMatchObject({
    status: "withdrawn", current: false, failed: true, retry: false,
    copy: "The previous session list was withdrawn.",
  });
  expect(withdrawn.time).toBeUndefined();
  expect(scopeCoverage([withdrawn])).toMatchObject({ complete: false, failed: true });
});
