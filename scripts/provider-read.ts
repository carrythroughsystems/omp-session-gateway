const PROVIDER_READ_ATTEMPTS = 5;

export interface ProviderReadOptions {
  readonly signal?: AbortSignal;
  /** Monotonic absolute deadline, shared by reads, body inspection and backoff. */
  readonly deadline?: number;
  readonly budgetMs?: number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly beforeRetry?: (response: Response) => Promise<void>;
}

/** An owned timer, not a race which leaves a sleeping or reading operation behind. */
export function abortablePause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return Bun.sleep(milliseconds);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function withReadBudget<T>(options: ProviderReadOptions, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const deadline = Math.min(options.deadline ?? Infinity, performance.now() + (options.budgetMs ?? Infinity));
  if (Number.isNaN(deadline) || (options.budgetMs !== undefined && (!Number.isFinite(options.budgetMs) || options.budgetMs < 0))) {
    throw new Error("invalid provider read budget");
  }
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]);
  const expire = () => controller.abort(new DOMException("provider read budget exhausted", "TimeoutError"));
  const timer = Number.isFinite(deadline) ? setTimeout(expire, Math.max(0, deadline - performance.now())) : undefined;
  if (deadline <= performance.now()) expire();
  try {
    signal.throwIfAborted();
    // The callback must pass this signal to its owned read; await its actual termination.
    const value = await run(signal);
    signal.throwIfAborted();
    return value;
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

const NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND",
  "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "ConnectionRefused",
]);

function transientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== undefined && NETWORK_CODES.has(code)) return true;
  // Fetch uses TypeError for transport failures AND invalid input. Do not replay arbitrary
  // TypeErrors (or caller AbortErrors); recognize only the transport messages/cause codes.
  return error instanceof TypeError && (
    /^(?:fetch failed|Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/u.test(error.message) ||
    (error.cause instanceof Error && NETWORK_CODES.has((error.cause as NodeJS.ErrnoException).code ?? ""))
  );
}

/**
 * Qualification drives third-party control planes (Vultr, Tailscale) whose APIs answer an
 * occasional transient 5xx or transport failure. Vultr returned HTTP 502 twice in one day: once at Windows admission, and
 * once on the instance lookup after the lane's reboot, which failed the attempt with its VM running.
 * On 2026-09-29 it returned 502 to three reads spanning six seconds while the lane staged its guest,
 * so reads now back off 2, 4, 8 and 16 seconds, about half a minute in all.
 * A read is idempotent, so it gets a bounded retry. A create, change, or delete never comes through
 * here, because a write that reached the provider must not run twice. HTTP and thrown network
 * failures share five attempts; the last response is returned or the last error is thrown.
 * Programming errors and caller cancellation are final. Each caller keeps its own status handling.
 * Retained-surface callers may inspect a retry body before cancellation; a failed inspection is final.
 */
export async function readProvider(
  read: (signal: AbortSignal) => Promise<Response>,
  options: ProviderReadOptions = {},
): Promise<Response> {
  return withReadBudget(options, async signal => {
  const sleep = options.sleep ?? abortablePause;
  for (let attempt = 1; ; attempt += 1) {
    signal.throwIfAborted();
    let response: Response | undefined;
    try {
      response = await read(signal);
    } catch (error) {
      signal.throwIfAborted();
      if (attempt >= PROVIDER_READ_ATTEMPTS || !transientNetworkError(error)) throw error;
    }
    if (response !== undefined) {
      if (signal.aborted) { await response.body?.cancel(); signal.throwIfAborted(); }
      if (response.status < 500 || attempt >= PROVIDER_READ_ATTEMPTS) return response;
      try { if (options.beforeRetry !== undefined) await options.beforeRetry(response); }
      finally { await response.body?.cancel(); }
    }
    signal.throwIfAborted();
    await sleep(2_000 * 2 ** (attempt - 1), signal);
  }
  });
}

/**
 * Absence is a different transient: Vultr once answered its own running instance's lookup as missing,
 * between two WinRM calls a minute apart (2026-09-27), which failed the lane with its VM healthy. An
 * owned resource is absent only when a second read, after a pause, agrees. A real deletion stays
 * absent, so a caller waiting for one sees it a pause later.
 */
export async function confirmAbsence<T>(
  read: (signal: AbortSignal) => Promise<T | undefined>,
  options: ProviderReadOptions = {},
): Promise<T | undefined> {
  return withReadBudget(options, async signal => {
  const first = await read(signal);
  signal.throwIfAborted();
  if (first !== undefined) return first;
  await (options.sleep ?? abortablePause)(5_000, signal);
  signal.throwIfAborted();
  return read(signal);
  });
}
