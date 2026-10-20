const PROVIDER_READ_ATTEMPTS = 5;

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
  read: () => Promise<Response>,
  options: { readonly sleep?: (milliseconds: number) => Promise<void>; readonly beforeRetry?: (response: Response) => Promise<void> } = {},
): Promise<Response> {
  const sleep = options.sleep ?? (async (milliseconds: number) => void (await Bun.sleep(milliseconds)));
  for (let attempt = 1; ; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await read();
    } catch (error) {
      if (attempt >= PROVIDER_READ_ATTEMPTS || !transientNetworkError(error)) throw error;
    }
    if (response !== undefined) {
      if (response.status < 500 || attempt >= PROVIDER_READ_ATTEMPTS) return response;
      if (options.beforeRetry !== undefined) await options.beforeRetry(response);
      await response.body?.cancel();
    }
    await sleep(2_000 * 2 ** (attempt - 1));
  }
}

/**
 * Absence is a different transient: Vultr once answered its own running instance's lookup as missing,
 * between two WinRM calls a minute apart (2026-09-27), which failed the lane with its VM healthy. An
 * owned resource is absent only when a second read, after a pause, agrees. A real deletion stays
 * absent, so a caller waiting for one sees it a pause later.
 */
export async function confirmAbsence<T>(
  read: () => Promise<T | undefined>,
  options: { readonly sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<T | undefined> {
  const first = await read();
  if (first !== undefined) return first;
  await (options.sleep ?? (async (milliseconds: number) => void (await Bun.sleep(milliseconds))))(5_000);
  return read();
}
