/**
 * Attempt every restoration step without replacing the body's error or losing its identity.
 * Keep QualificationFailure and DeviceCloudAvailabilityHold leaves intact in AggregateError.errors:
 * campaign normalization must see typed roots alongside cleanup failures, never a message/cause
 * wrapper that hides one. Do not normalize here: failure IDs belong to the whole attempt.
 */
export async function runWithRestoration<T>(
  label: string,
  body: () => T | Promise<T>,
  steps: readonly (() => unknown | Promise<unknown>)[],
  noun: "restoration" | "cleanup" = "restoration",
): Promise<T> {
  let value!: T;
  let bodyFailed = false;
  let bodyError: unknown;
  try { value = await body(); }
  catch (error) { bodyFailed = true; bodyError = error; }
  const failures: unknown[] = [];
  for (const restore of steps) {
    try { await restore(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length > 0) {
    if (bodyFailed) throw new AggregateError([bodyError, ...failures], `${label} and ${noun} failed`);
    throw new AggregateError(failures, `${label} ${noun} failed`);
  }
  if (bodyFailed) throw bodyError;
  return value;
}

/** A recoverable error must not hide an unrelated failure collected during restoration. */
export function everyError(error: unknown, predicate: (error: unknown) => boolean): boolean {
  return error instanceof AggregateError
    ? error.errors.length > 0 && error.errors.every(nested => everyError(nested, predicate))
    : predicate(error);
}

/** Safety flags must survive nesting when more than one restoration owner reports a failure. */
export function pixelUnrestored(error: unknown): boolean {
  if (error !== null && typeof error === "object" && "pixelUnrestored" in error && error.pixelUnrestored === true) return true;
  return error instanceof AggregateError && error.errors.some(pixelUnrestored);
}
