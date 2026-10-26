import { expect, test } from "bun:test";
import { everyError, pixelUnrestored, runWithRestoration } from "./restoration.ts";
import { QualificationFailure, normalizeQualificationFailures } from "./qualification-failure.ts";

test("a successful body returns its value after ordered restoration", async () => {
  const order: string[] = [];
  const value = { complete: true };
  expect(await runWithRestoration("qualification", async () => { order.push("body"); return value; }, [
    async () => { order.push("radios"); },
    () => { order.push("battery"); },
  ])).toBe(value);
  expect(order).toEqual(["body", "radios", "battery"]);
});

test("successful restoration rethrows the primary object with its properties unchanged", async () => {
  const primary = Object.assign(new Error("phase failed"), { pixelUnrestored: true });
  await expect(runWithRestoration("qualification", () => { throw primary; }, [() => {}])).rejects.toBe(primary);
});

test("restoration failures after success are collected without a fabricated primary error", async () => {
  const restore = new Error("reset failed");
  await expect(runWithRestoration("qualification", () => 42, [() => { throw restore; }])).rejects.toMatchObject({
    message: "qualification restoration failed", errors: [restore],
  });
});

test("the primary precedes ordered restoration failures and every later step still runs", async () => {
  const primary = new Error("phase failed");
  const first = new Error("radios failed"), last = new Error("battery failed");
  const attempts: string[] = [];
  let failure: unknown;
  try {
    await runWithRestoration("qualification", () => { throw primary; }, [
      () => { attempts.push("radios"); throw first; },
      async () => { attempts.push("doze"); },
      () => { attempts.push("battery"); throw last; },
    ]);
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).message).toBe("qualification and restoration failed");
  expect((failure as AggregateError).errors).toEqual([primary, first, last]);
  expect(attempts).toEqual(["radios", "doze", "battery"]);
});

test("throwing undefined is still a primary failure", async () => {
  const restore = new Error("cleanup failed");
  const result = await Promise.allSettled([runWithRestoration("qualification", () => { throw undefined; }, [])]);
  expect(result).toEqual([{ status: "rejected", reason: undefined }]);
  await expect(runWithRestoration("qualification", () => { throw undefined; }, [() => { throw restore; }])).rejects.toMatchObject({
    errors: [undefined, restore],
  });
});

test("recovery classification rejects an aggregate containing another restoration failure", () => {
  class Recoverable extends Error {}
  const matches = (error: unknown) => error instanceof Recoverable;
  expect(everyError(new AggregateError([new AggregateError([new Recoverable()])]), matches)).toBe(true);
  expect(everyError(new AggregateError([new Recoverable(), new Error("restoration failed")]), matches)).toBe(false);
  expect(everyError(new AggregateError([]), matches)).toBe(false);
});

test("typed roots survive cleanup aggregation without losing Pixel poisoning or identity", async () => {
  const root = new QualificationFailure({ id: 1, lane: "windows", step: "transport_ready", reason: "connection_timeout",
    class: "infra_transient", elapsedMs: 90_000, operation: "read_only", observations: { transportFailure: true } });
  const cleanup = Object.assign(new QualificationFailure({ id: 2, lane: "windowsCleanup", step: "pixelRestore",
    reason: "containment_unproven", class: "harness", elapsedMs: 1, operation: "unknown", observations: {} }), { pixelUnrestored: true });
  const error = await runWithRestoration("typed", () => { throw root; }, [() => { throw cleanup; }]).catch((error: unknown) => error);
  expect((error as AggregateError).errors[0]).toBe(root);
  expect((error as AggregateError).errors[1]).toBe(cleanup);
  expect(everyError(error, leaf => leaf instanceof QualificationFailure)).toBe(true);
  expect(pixelUnrestored(error)).toBe(true);
  expect(normalizeQualificationFailures(error).map(leaf => leaf.class)).toEqual(["infra_transient", "harness"]);
});
