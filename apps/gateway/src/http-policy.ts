import type { GatewayConfig } from "./config.ts";
import { SESSION_CREATION_UUID_PATTERN } from "@omp-session-gateway/protocol";

const CSP_PREFIX =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' wss://my.omp.sh";
const CSP_SUFFIX = "; manifest-src 'self'; worker-src 'self'";
const PERMISSIONS_PREFIX = "camera=(), microphone=";
const PERMISSIONS_SUFFIX = ", geolocation=(), payment=(), usb=(), serial=(), bluetooth=()";

function securityHeaders(targets: readonly string[], microphone: boolean): Record<string, string> {
  return {
    "Content-Security-Policy": `${CSP_PREFIX}${targets.map(origin => ` ${origin}`).join("")}${CSP_SUFFIX}`,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": `${PERMISSIONS_PREFIX}${microphone ? "(self)" : "()"}${PERMISSIONS_SUFFIX}`,
  };
}

export function documentSecurityHeaders(config: GatewayConfig): Record<string, string> {
  return securityHeaders(config.fleet.targets.map(target => target.origin), config.speech.browserRecognition);
}

export function apiSecurityHeaders(): Record<string, string> {
  return {
    ...securityHeaders([], false),
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
  };
}

function corsRouteMethod(request: Request): "GET" | "POST" | undefined {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/v1/sessions") return "GET";
  if (pathname === "/api/v1/session-creation-options") return "GET";
  if (pathname === "/api/v1/session-creations") return "POST";
  const creation = /^\/api\/v1\/session-creations\/([^/]+)$/u.exec(pathname);
  if (creation && SESSION_CREATION_UUID_PATTERN.test(creation[1]!)) return "GET";
  if (/^\/api\/v1\/sessions\/[^/]{1,384}\/launch$/u.test(pathname)) return "POST";
  return undefined;
}

export function corsAdmission(request: Request, config: GatewayConfig): string | undefined {
  const method = corsRouteMethod(request);
  if (method === undefined || (request.method !== method && request.method !== "OPTIONS")) return undefined;
  const origin = request.headers.get("Origin");
  if (origin === null || !config.http.trustedDashboardOrigins.includes(origin)) return undefined;
  return origin;
}

export type PreflightDecision =
  | { readonly allowed: true; readonly origin: string; readonly method: "GET" | "POST" }
  | { readonly allowed: false };

/** Identity authorization remains the handler's responsibility, including for OPTIONS. */
export function preflightDecision(request: Request, config: GatewayConfig): PreflightDecision {
  if (request.method !== "OPTIONS" || new URL(request.url).search !== "") return { allowed: false };
  const origin = corsAdmission(request, config);
  const method = corsRouteMethod(request);
  if (origin === undefined || method === undefined || request.headers.get("Access-Control-Request-Method") !== method) {
    return { allowed: false };
  }
  const requestedHeaders = request.headers.get("Access-Control-Request-Headers");
  if (requestedHeaders !== null && (method !== "POST" || requestedHeaders.toLowerCase() !== "content-type")) {
    return { allowed: false };
  }
  return { allowed: true, origin, method };
}

/** Finalize every response once with fresh headers; never alter an asset store's shared policy. */
export function finalizeHttpResponse(
  response: Response,
  config: GatewayConfig,
  options: {
    readonly document: boolean;
    readonly noStore: boolean;
    readonly corsOrigin?: string;
    readonly preflight?: Extract<PreflightDecision, { allowed: true }>;
  },
): Response {
  const headers = new Headers(response.headers);
  const policy = options.document ? documentSecurityHeaders(config) : securityHeaders([], false);
  for (const [name, value] of Object.entries(policy)) headers.set(name, value);
  if (options.noStore) {
    const api = apiSecurityHeaders();
    headers.set("Cache-Control", api["Cache-Control"]!);
    headers.set("Pragma", api.Pragma!);
  }
  const origin = options.preflight?.origin ?? options.corsOrigin;
  if (origin !== undefined) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", options.preflight === undefined
      ? "Origin"
      : "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  }
  if (options.preflight !== undefined) {
    headers.set("Access-Control-Allow-Methods", options.preflight.method);
    if (options.preflight.method === "POST") headers.set("Access-Control-Allow-Headers", "Content-Type");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
