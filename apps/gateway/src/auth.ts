import { loopbackHttpOrigin, type GatewayConfig } from "./config.ts";

export interface RequestPeer {
  readonly address: string;
}

export type AuthorizationResult =
  | { readonly allowed: true; readonly identityKey: string }
  | { readonly allowed: false; readonly reason: "unauthorized" | "identity_untrustworthy" };

export function isLoopbackAddress(address: string): boolean {
  const lower = address.toLowerCase();
  const unbracketed = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
  const normalized = unbracketed.split("%")[0] ?? "";
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

/**
 * Tailscale's own ranges. A Serve-proxied request carries the tailnet source address, so an
 * forwarded-for value outside these ranges did not come from Serve.
 */
function isTailscaleAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  const unbracketed = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const host = unbracketed.split("%")[0] ?? "";
  if (host.startsWith("fd7a:115c:a1e0:")) return true;
  const octets = host.split(".");
  if (octets.length !== 4) return false;
  const parsed = octets.map(octet => (/^[0-9]{1,3}$/u.test(octet) ? Number(octet) : Number.NaN));
  if (parsed.some(octet => !Number.isInteger(octet) || octet > 255)) return false;
  // 100.64.0.0/10.
  return parsed[0] === 100 && parsed[1]! >= 64 && parsed[1]! <= 127;
}

/**
 * Evidence that something other than Tailscale Serve terminated this request, or `undefined` when
 * the request is shaped exactly as Serve produces.
 *
 * A forwarder running on this host satisfies the loopback check trivially — it *is* local — and the
 * TUN probe only establishes that the host has a tailnet, not that this request crossed it. So an
 * operator who points a tunnel at the listener turns `Tailscale-User-Login` into attacker-controlled
 * input. Nothing in the request can prove Serve *did* handle it, but an HTTP proxy in front leaves
 * marks that Serve never produces, and a remote caller cannot remove marks the proxy itself adds.
 *
 * Measured against Serve's proxy (`ipn/ipnlocal/serve.go`, `addProxyForwardedHeaders` and
 * `addTailscaleIdentityHeaders`): it sets `X-Forwarded-Host` to the inbound host, sets
 * `X-Forwarded-For` to the single tailnet source address, and deletes every inbound `Tailscale-*`
 * header before setting its own. It never sets `Forwarded`, `X-Real-IP`, or vendor headers.
 *
 * This is defence in depth and not authentication: a raw TCP forwarder inserts no headers at all and
 * remains indistinguishable from Serve. Only an authenticator the gateway can verify closes that.
 */
export function secondHopEvidence(request: Request, publicOrigin: string): string | undefined {
  const forwardedFor = request.headers.get("X-Forwarded-For");
  if (forwardedFor !== null) {
    const hops = forwardedFor.split(",");
    // Serve overwrites rather than appends, so more than one hop means another proxy appended to it.
    if (hops.length !== 1) return "forwarded_chain";
    if (!isTailscaleAddress(hops[0]!)) return "forwarded_source";
  }
  const forwardedHost = request.headers.get("X-Forwarded-Host");
  if (forwardedHost !== null) {
    let expected: string;
    try {
      expected = new URL(publicOrigin).host.toLowerCase();
    } catch {
      return "forwarded_host";
    }
    if (forwardedHost.trim().toLowerCase() !== expected) return "forwarded_host";
  }
  // Serve sets none of these. Each is inserted by a proxy the caller cannot instruct to stop.
  for (const header of ["Forwarded", "X-Real-IP", "CF-Connecting-IP", "CF-Ray", "X-Forwarded-Server"]) {
    if (request.headers.get(header) !== null) return "proxy_marker";
  }
  // Funnel is never a supported path, and Serve marks those requests explicitly.
  if (request.headers.get("Tailscale-Funnel-Request") !== null) return "funnel";
  return undefined;
}

export function normalizeTailscaleLogin(value: string): string | undefined {
  const normalized = value.normalize("NFC").trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 320 || /[\0\r\n,]/u.test(normalized)) return undefined;
  return normalized;
}

/**
 * @param serveOwnsIdentityHeaders whether Tailscale Serve is still the only way a request can reach
 * this loopback listener. False means tailscaled has no TUN device, so its netstack forwards inbound
 * tailnet connections to localhost and any tailnet peer can present a forged identity as a loopback
 * peer (#98). Callers pass a measured value; there is no default, because a caller that forgot this
 * argument would be reintroducing the bypass.
 */
export function authorizeHttpRequest(
  request: Request,
  peer: RequestPeer | undefined,
  config: GatewayConfig,
  serveOwnsIdentityHeaders: boolean,
): AuthorizationResult {
  if (peer === undefined || !isLoopbackAddress(peer.address)) return { allowed: false, reason: "unauthorized" };
  // Dispatch on the mode explicitly and fall through to a refusal. Reading the Tailscale identity
  // header used to be the implicit default for "not dev-localhost", so a mode added later — a
  // browser authenticator, say — would have inherited header trust by omission rather than by
  // decision. A new mode now denies until it is given an arm here.
  switch (config.auth.mode) {
    case "dev-localhost":
      return authorizeDevLocalhost(request, config);
    case "tailscale-serve":
      return authorizeTailscaleServe(request, config, serveOwnsIdentityHeaders);
    default:
      return { allowed: false, reason: "identity_untrustworthy" };
  }
}

function authorizeDevLocalhost(request: Request, config: GatewayConfig): AuthorizationResult {
  try {
    const origin = new URL(request.url).origin;
    return origin === config.http.publicOrigin && origin === loopbackHttpOrigin(config.http.hostname, config.http.port)
      ? { allowed: true, identityKey: "dev-localhost" }
      : { allowed: false, reason: "unauthorized" };
  } catch {
    return { allowed: false, reason: "unauthorized" };
  }
}

function authorizeTailscaleServe(
  request: Request,
  config: GatewayConfig,
  serveOwnsIdentityHeaders: boolean,
): AuthorizationResult {
  // Identity here is asserted only by Serve, which overwrites whatever the caller sent. That
  // guarantee is a property of the topology rather than of the request, so it is checked before the
  // header is read at all. Refusing costs nothing when the signal is absent: without a tailnet
  // interface, Serve cannot be routing tailnet requests to this process in the first place.
  if (!serveOwnsIdentityHeaders) return { allowed: false, reason: "identity_untrustworthy" };
  // A second HTTP hop means this request reached the listener by some route other than Serve, and
  // its identity header is therefore whatever the caller typed.
  if (secondHopEvidence(request, config.http.publicOrigin) !== undefined) {
    return { allowed: false, reason: "identity_untrustworthy" };
  }
  const header = request.headers.get("Tailscale-User-Login");
  if (header === null) return { allowed: false, reason: "unauthorized" };
  const login = normalizeTailscaleLogin(header);
  if (login === undefined || !config.auth.allowedLogins.includes(login)) {
    return { allowed: false, reason: "unauthorized" };
  }
  return { allowed: true, identityKey: login };
}

export function requestHasValidMutationContext(request: Request, expectedOrigin: string): boolean {
  if (request.headers.get("Origin") !== expectedOrigin) return false;
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  return fetchSite === null || fetchSite === "same-origin";
}

/** A narrowly opted-in dashboard may launch, but never inherits the local mutation context. */
export function requestHasTrustedDashboardContext(
  request: Request,
  trustedOrigins: readonly string[],
): string | undefined {
  const origin = request.headers.get("Origin");
  if (origin === null || !trustedOrigins.includes(origin)) return undefined;
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite !== null && fetchSite !== "same-site" && fetchSite !== "cross-site") return undefined;
  if (request.headers.get("Content-Type") !== "application/json") return undefined;
  return origin;
}
