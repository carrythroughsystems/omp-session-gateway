import { ProtocolValidationError } from "./secret.ts";
import {
  FLEET_DIGEST_PATTERN,
  FLEET_SESSION_SUFFIX_LENGTH,
  FLEET_SOURCE_ID_PATTERN,
  INSTANCE_ID_PATTERN,
  SESSION_CREATION_UUID_PATTERN,
} from "./types.ts";

/**
 * Fleet-notification derivations shared by the gateway, the page, and the service worker
 * (ADR-048). Each digest is domain-separated and NUL-delimited; every input is NUL-free by its own
 * validation, so the encodings are unambiguous. Web Crypto runs in Bun, pages, and workers alike.
 */
const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

async function digest(domain: string, ...parts: readonly string[]): Promise<string> {
  for (const part of parts) if (part.includes("\0")) throw new ProtocolValidationError();
  const bytes = encoder.encode([domain, ...parts].join("\0"));
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/**
 * Opaque name of one configured remote source in push payloads, notification data, and routes. It
 * identifies a binding, not a principal: the page and worker recompute it from their own client
 * configuration and treat an unmatched binding as expired, so a changed origin invalidates it.
 */
export async function fleetSourceBinding(sourceId: string, origin: string): Promise<string> {
  if (!FLEET_SOURCE_ID_PATTERN.test(sourceId) || origin.length === 0) throw new ProtocolValidationError();
  return (await digest("omp-fleet-binding-v1", sourceId, origin)).slice(0, 22);
}

/** What a source stores in place of a grant secret; only the coordinator ever holds the secret. */
export async function fleetGrantVerifier(grantId: string, secret: string): Promise<string> {
  if (!SESSION_CREATION_UUID_PATTERN.test(grantId) || !FLEET_DIGEST_PATTERN.test(secret)) {
    throw new ProtocolValidationError();
  }
  return digest("omp-fleet-grant-v1", grantId, secret);
}

/**
 * Lets a coordinator confirm that a source authorized the same owner its grant names. Binding the
 * coordinator origin keeps one owner's digest from correlating across coordinators.
 */
export async function fleetOwnerDigest(coordinatorOrigin: string, login: string): Promise<string> {
  if (coordinatorOrigin.length === 0 || login.length === 0) throw new ProtocolValidationError();
  return digest("omp-fleet-owner-v1", coordinatorOrigin, login);
}

/** A 256-bit grant secret in the unpadded base64url form the feed's bearer credential carries. */
export function newFleetGrantSecret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The opaque, non-content session label fleet Session detail may show beside a host label. */
export function fleetSessionSuffix(instanceId: string): string {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) throw new ProtocolValidationError();
  return instanceId.slice(-FLEET_SESSION_SUFFIX_LENGTH);
}
