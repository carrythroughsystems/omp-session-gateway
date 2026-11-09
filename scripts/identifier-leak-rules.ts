/**
 * Patterns for personal and infrastructure identifiers that must not enter this public repository.
 *
 * This is a sibling of `capability-leak-rules.ts`, which guards secrets. This file guards a
 * different class: values that are not credentials but still identify a person, a machine, or a
 * private network. Nothing here would grant access; publishing it is a privacy failure rather than
 * a security one, which is exactly why it is easy to be careless with.
 *
 * It exists because I published a workstation hostname, a phone's hardware serial, a home directory
 * path, a private tailnet address, a tailnet node id, and a production VPS address into a public
 * repository and its pull requests, then had to rewrite history and delete three releases to get
 * them back out. Every one of those was avoidable by a reviewer noticing. A check does not get
 * tired.
 *
 * The rules are shape-based rather than a denylist of known values. A denylist only catches the
 * values already leaked, which is precisely the set that no longer matters.
 */

export interface IdentifierFinding {
  readonly label: string;
  readonly match: string;
  readonly line: number;
}

/** Extensions worth scanning. Binary and lockfile noise is skipped by the caller. */
export const IDENTIFIER_TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".yml", ".yaml", ".sh", ".ps1", ".hujson", ".patch", ".html", ".css", ".xml", ".txt"]);

/**
 * Literals that look like an identifier but are documentation, reserved, or otherwise safe.
 * Keep this list short and justified; every entry is a hole in the check.
 */
const ALLOWED = [
  /^127\./, // loopback, which this project binds to deliberately
  /^0\.0\.0\.0$/,
  /^255\./,
  /^10\./, // RFC1918
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT, which Tailscale uses; addresses are not routable
  // RFC 5737 reserves these three ranges so documentation and tests never name a real host. They
  // identify nobody by construction, which is a stronger guarantee than the ad-hoc literals below:
  // `8.8.8.8` and `93.184.216.34` are real addresses that convention merely tolerates.
  /^192\.0\.2\./, // TEST-NET-1
  /^198\.51\.100\./, // TEST-NET-2
  /^203\.0\.113\./, // TEST-NET-3
  /^(1\.2\.3\.4|8\.8\.8\.8|93\.184\.216\.34)$/, // conventional documentation addresses
  /^\d+\.\d+\.\d+\.\d+$/u.source === "" ? /^$/ : /^(?:0|1)\.\d+\.\d+\.\d+$/, // version-like leading 0./1.
];

function isAllowed(value: string): boolean {
  return ALLOWED.some(rule => rule.test(value));
}

/** A dotted quad that is a plausible public address rather than a version string or loopback. */
function looksLikePublicIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  if (parts.some(p => p.length > 3 || !/^\d+$/u.test(p) || Number(p) > 255)) return false;
  // A leading octet of 0 is not a host address, and semantic versions rarely reach four octets.
  if (Number(parts[0]) === 0) return false;
  // `151.0.0.0` is a browser version, not a host; no real address ends in three zero octets.
  if (parts.slice(1).every(p => Number(p) === 0)) return false;
  return !isAllowed(value);
}

interface Rule {
  readonly label: string;
  readonly pattern: RegExp;
  readonly accept?: (match: string) => boolean;
}

const RULES: readonly Rule[] = [
  { label: "public IPv4 address", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, accept: looksLikePublicIpv4 },
  // Tailscale MagicDNS names embed the machine name and the tailnet, so they identify both.
  {
    label: "tailnet hostname",
    pattern: /\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/giu,
    // Documentation placeholders are the whole point of having placeholders.
    accept: value => !/(^|\.)(example|tailnet|invalid)\./iu.test(value),
  },
  // Tailscale node identifiers.
  { label: "tailnet node id", pattern: /\b[A-Za-z0-9]{10,20}CNTRL\b/gu },
  // A macOS or Linux home directory reveals the account name.
  {
    label: "absolute home path",
    // Case-sensitive on the account segment: `$HOME/Library` is a system path, not a username.
    pattern: /\/(?:Users|home)\/(?!runner\b|test\b|user\b|you\b|ompqual\b|alice\b|bob\b|me\b|someone\b)[a-z][a-z0-9_-]{1,31}\b/gu,
  },
  // Android/Apple hardware serials: long uppercase alphanumerics with digits and letters mixed.
  { label: "device serial", pattern: /\b(?=[0-9A-Z]{10,20}\b)(?=.*\d)(?=.*[A-Z])[0-9A-Z]{10,20}\b/gu },
];

/** Matches that the serial rule would otherwise flag: hex digests, base32, and shouty constants. */
const SERIAL_FALSE_POSITIVE = /^(?:[0-9A-F]+|[A-Z]+|[A-Z0-9]*(?:SHA|HMAC|UUID|HTTP|JSON|TTL|API|URL|CI|OMP|UPSTREAM)[A-Z0-9]*)$/u;

/** Real hardware serials carry several digits; a shouty token with one or two does not. */
function hasSerialDigitDensity(value: string): boolean {
  return (value.match(/\d/gu) ?? []).length >= 3;
}

export function findIdentifierLeaks(text: string): IdentifierFinding[] {
  const findings: IdentifierFinding[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    // A line may explicitly opt out where a real identifier is unavoidable and reviewed.
    if (line.includes("identifier-leak-allow")) continue;
    for (const rule of RULES) {
      for (const match of line.matchAll(rule.pattern)) {
        const value = match[0];
        if (rule.accept && !rule.accept(value)) continue;
        if (rule.label === "device serial" && (SERIAL_FALSE_POSITIVE.test(value) || !hasSerialDigitDensity(value))) continue;
        findings.push({ label: rule.label, match: value, line: index + 1 });
      }
    }
  }
  return findings;
}
