import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { PROTOCOL_VERSION } from "@omp-session-gateway/protocol";

export const DIAGNOSTICS_FORMAT_VERSION = 1 as const;
export const PRODUCT_VERSION = "0.7.6";

export interface DoctorReport {
  readonly service: "omp-session-gateway";
  readonly checks: Readonly<Record<string, boolean>>;
}

export interface DiagnosticsBundleResult {
  readonly bytes: number;
  readonly sha256: string;
}

function stableReport(report: DoctorReport): string {
  const checks = Object.fromEntries(
    Object.entries(report.checks).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  return `${JSON.stringify(
    {
      service: report.service,
      productVersion: PRODUCT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      platform: process.platform,
      architecture: process.arch,
      checks,
    },
    null,
    2,
  )}\n`;
}

function manifest(): string {
  return `${JSON.stringify(
    {
      format: "omp-session-gateway-diagnostics",
      formatVersion: DIAGNOSTICS_FORMAT_VERSION,
      entries: [
        {
          name: "doctor.json",
          fields: ["service", "productVersion", "protocolVersion", "platform", "architecture", "checks (booleans only)"],
        },
        {
          name: "manifest.json",
          fields: ["format", "formatVersion", "entries", "excluded"],
        },
      ],
      excluded: [
        "capabilities, OMP query tokens, and gateway readiness tokens",
        "authorization and identity headers",
        "account identities and tailnet DNS names",
        "session metadata, transcripts, prompts, and tool output",
        "full filesystem paths, browser storage, relay frames, and raw logs",
      ],
    },
    null,
    2,
  )}\n`;
}

function writeText(target: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > length) throw new Error("diagnostics archive field is too long");
  encoded.copy(target, offset);
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  writeText(target, offset, length, `${encoded}\0`);
}

function tarEntry(name: string, content: string): Buffer {
  const body = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512);
  writeText(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, body.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - (body.byteLength % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

export function diagnosticsBundleBytes(report: DoctorReport): Buffer {
  return Buffer.concat([
    tarEntry("manifest.json", manifest()),
    tarEntry("doctor.json", stableReport(report)),
    Buffer.alloc(1_024),
  ]);
}

export async function createDiagnosticsBundle(report: DoctorReport, path: string): Promise<DiagnosticsBundleResult> {
  const archive = diagnosticsBundleBytes(report);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(archive);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    bytes: archive.byteLength,
    sha256: createHash("sha256").update(archive).digest("hex"),
  };
}
