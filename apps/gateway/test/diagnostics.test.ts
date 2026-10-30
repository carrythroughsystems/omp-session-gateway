import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GatewayConfig } from "../src/config.ts";
import { createDiagnosticsBundle, diagnosticsBundleBytes } from "../src/diagnostics.ts";
import {
  funnelConfigurationDisabled,
  gatewayReady,
  loopbackHttpResponds,
  serveConfigurationMatches,
  tailscaleSelfIp,
} from "../src/doctor.ts";
import { HANG_DEADLINE_MS } from "./test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

const roots: string[] = [];

function config(): GatewayConfig {
  return {
    http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "https://gateway.example.ts.net", trustedDashboardOrigins: [] },
    fleet: { label: "gateway", targets: [] },
    speech: { browserRecognition: false },
    auth: { mode: "tailscale-serve", allowedLogins: ["allowed@example.com"] },
    omp: { discoveryDir: "/private/omp/run/collab-hosts", queryTimeoutMs: 1_500 },
    registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 10 },
    paths: {
      configDir: "/private/config",
      stateDir: "/private/state",
      runtimeDir: "/private/run",
      tokenPath: "/private/config/readiness-token",
      configPath: "/private/config/config.json",
    },
  };
}

function tarEntries(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/su, "");
    if (name === "") break;
    const sizeText = header.subarray(124, 136).toString("ascii").replaceAll("\0", "").trim();
    const size = Number.parseInt(sizeText, 8);
    const bodyStart = offset + 512;
    entries.set(name, archive.subarray(bodyStart, bodyStart + size));
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("redacted diagnostics", () => {
  test("creates a deterministic manifest-only archive and ignores extra sensitive fields", async () => {
    const source = {
      service: "omp-session-gateway" as const,
      checks: { zeta: false, alpha: true },
      capability: "DIAGNOSTIC_CONTROL_CANARY_0000000000000000",
      fullPath: "/Users/alice/secret-project",
      identity: "alice@example.com",
      creationLedger: "CREATION_LEDGER_DIAGNOSTIC_CANARY",
      argv: ["CREATION_ARGV_DIAGNOSTIC_CANARY"],
      env: { SECRET: "CREATION_ENV_DIAGNOSTIC_CANARY" },
      ternInspection: "TERN_INSPECTION_DIAGNOSTIC_CANARY",
    };
    const first = diagnosticsBundleBytes(source);
    const second = diagnosticsBundleBytes(source);
    expect(first).toEqual(second);
    const entries = tarEntries(first);
    expect([...entries.keys()]).toEqual(["manifest.json", "doctor.json"]);
    expect(entries.get("doctor.json")?.toString("utf8")).toContain('"alpha": true');
    const archiveText = first.toString("utf8");
    expect(archiveText).not.toContain(source.capability);
    expect(archiveText).not.toContain(source.fullPath);
    expect(archiveText).not.toContain(source.identity);
    for (const excluded of [source.creationLedger, ...source.argv, source.env.SECRET, source.ternInspection]) {
      expect(archiveText).not.toContain(excluded);
    }
    expect(entries.get("manifest.json")?.toString("utf8")).toContain("session creation ledgers and request payloads");
    expect(entries.get("manifest.json")?.toString("utf8")).toContain("raw Tern inspection output");

    const root = await mkdtemp(join(tmpdir(), "omp-diagnostics-"));
    roots.push(root);
    const firstPath = join(root, "first.tar");
    const secondPath = join(root, "second.tar");
    const firstResult = await createDiagnosticsBundle(source, firstPath);
    const secondResult = await createDiagnosticsBundle(source, secondPath);
    expect(await readFile(firstPath)).toEqual(await readFile(secondPath));
    expect(firstResult.sha256).toBe(secondResult.sha256);
    if (process.platform !== "win32") expect((await stat(firstPath)).mode & 0o077).toBe(0);
  });

  test("requires a new diagnostics destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-diagnostics-"));
    roots.push(root);
    const path = join(root, "bundle.tar");
    const report = { service: "omp-session-gateway" as const, checks: { config: true } };
    await createDiagnosticsBundle(report, path);
    await expect(createDiagnosticsBundle(report, path)).rejects.toThrow();
  });
});

test("rejects an unauthenticated ready response from a loopback port squatter", async () => {
  const squatter = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ status: "ready" }) });
  try {
    const base = config();
    const gatewayConfig: GatewayConfig = {
      ...base,
      http: { ...base.http, port: squatter.port ?? 0 },
    };
    expect(await gatewayReady(gatewayConfig, "T".repeat(43))).toBe(false);
    expect(await loopbackHttpResponds(gatewayConfig)).toBe(true);
  } finally {
    squatter.stop(true);
  }
});

test("rejects an authenticated prior instance during managed startup", async () => {
  const token = "T".repeat(43);
  const priorInstance = "P".repeat(43);
  const squatter = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: request => {
      const challenge = request.headers.get("X-OMP-Readiness-Challenge") ?? "";
      const proof = createHmac("sha256", token)
        .update(challenge)
        .update("\0")
        .update(priorInstance)
        .digest("base64url");
      return Response.json({ status: "ready", instance: priorInstance, proof });
    },
  });
  try {
    const base = config();
    const gatewayConfig: GatewayConfig = {
      ...base,
      http: { ...base.http, port: squatter.port ?? 0 },
    };
    expect(await gatewayReady(gatewayConfig, token)).toBe(true);
    expect(await gatewayReady(gatewayConfig, token, "N".repeat(43))).toBe(false);
  } finally {
    squatter.stop(true);
  }
});

test("recognizes a legacy same-token gateway only outside instance-bound startup", async () => {
  const token = "T".repeat(43);
  const legacy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: request => {
      const challenge = request.headers.get("X-OMP-Readiness-Challenge") ?? "";
      return Response.json({
        status: "ready",
        proof: createHmac("sha256", token).update(challenge).digest("base64url"),
      });
    },
  });
  try {
    const base = config();
    const gatewayConfig = { ...base, http: { ...base.http, port: legacy.port ?? 0 } };
    expect(await gatewayReady(gatewayConfig, token)).toBe(true);
    expect(await gatewayReady(gatewayConfig, token, "N".repeat(43))).toBe(false);
  } finally {
    legacy.stop(true);
  }
});

test("rejects oversized readiness responses before parsing", async () => {
  const squatter = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(513));
            controller.close();
          },
        }),
      ),
  });
  try {
    const base = config();
    expect(
      await gatewayReady(
        { ...base, http: { ...base.http, port: squatter.port ?? 0 } },
        "T".repeat(43),
        "N".repeat(43),
      ),
    ).toBe(false);
  } finally {
    squatter.stop(true);
  }
});

describe("Tailscale doctor parsing", () => {
  test("requires the configured HTTPS host and exact loopback proxy", () => {
    const value = {
      Web: {
        "gateway.example.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:4317" } },
        },
      },
    };
    expect(serveConfigurationMatches(value, config())).toBe(true);
    expect(
      serveConfigurationMatches(
        { Web: { "other.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4317" } } } } },
        config(),
      ),
    ).toBe(false);
    expect(
      serveConfigurationMatches(
        { Web: { "gateway.example.ts.net:443": { Handlers: { "/": { Proxy: "http://0.0.0.0:4317" } } } } },
        config(),
      ),
    ).toBe(false);
  });

  test("requires the exact configured external HTTPS port", () => {
    const customPortConfig: GatewayConfig = {
      ...config(),
      http: { ...config().http, publicOrigin: "https://gateway.example.ts.net:8443" },
    };
    const handlers = { "/": { Proxy: "http://127.0.0.1:4317" } };
    expect(serveConfigurationMatches({ Web: { "gateway.example.ts.net:8443": { Handlers: handlers } } }, customPortConfig)).toBe(
      true,
    );
    expect(serveConfigurationMatches({ Web: { "gateway.example.ts.net:443": { Handlers: handlers } } }, customPortConfig)).toBe(
      false,
    );
  });

  test("matches an exact bracketed IPv6 loopback proxy", () => {
    const ipv6Config: GatewayConfig = {
      ...config(),
      http: { ...config().http, hostname: "::1" },
    };
    expect(
      serveConfigurationMatches(
        { Web: { "gateway.example.ts.net:443": { Handlers: { "/": { Proxy: "http://[::1]:4317" } } } } },
        ipv6Config,
      ),
    ).toBe(true);
    expect(
      serveConfigurationMatches(
        { Web: { "gateway.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4317" } } } } },
        ipv6Config,
      ),
    ).toBe(false);
  });

  test("selects a validated Tailscale self address for direct HTTPS diagnostics", () => {
    expect(
      tailscaleSelfIp({
        Self: { TailscaleIPs: ["fd7a:115c:a1e0::1234", "100.64.0.7"] },
      }),
    ).toBe("100.64.0.7");
    expect(tailscaleSelfIp({ Self: { TailscaleIPs: ["not-an-ip"] } })).toBeUndefined();
  });

  // `tailscale funnel status --json` on a gateway node that also publishes another local service, as
  // captured on the Studio release host on 2026-10-08 (names replaced).
  const sharedNode = {
    TCP: { "10000": { HTTPS: true }, "443": { HTTPS: true }, "8443": { HTTPS: true } },
    Web: {
      "gateway.example.ts.net:10000": { Handlers: { "/": { Proxy: "http://127.0.0.1:18080" } } },
      "gateway.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4317" } } },
      "gateway.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:18080" } } },
    },
    AllowFunnel: { "gateway.example.ts.net:10000": true, "gateway.example.ts.net:8443": true },
  };

  test("passes when no Funnel reaches the gateway, including Funnels for other services on its node", () => {
    expect(funnelConfigurationDisabled({}, config())).toBe(true);
    expect(funnelConfigurationDisabled({ ...sharedNode, AllowFunnel: { "gateway.example.ts.net:443": false } }, config())).toBe(
      true,
    );
    expect(serveConfigurationMatches(sharedNode, config())).toBe(true);
    expect(funnelConfigurationDisabled(sharedNode, config())).toBe(true);
  });

  test("fails when Funnel is enabled for the gateway's own Serve authority", () => {
    const funneled = { ...sharedNode, AllowFunnel: { ...sharedNode.AllowFunnel, "gateway.example.ts.net:443": true } };
    expect(funnelConfigurationDisabled(funneled, config())).toBe(false);
    const customPortConfig: GatewayConfig = {
      ...config(),
      http: { ...config().http, publicOrigin: "https://gateway.example.ts.net:8443" },
    };
    expect(funnelConfigurationDisabled(sharedNode, customPortConfig)).toBe(false);
  });

  test("fails when a Funnel proxies or forwards to the gateway's backend port in any tailscaled form", () => {
    for (const proxy of ["http://127.0.0.1:4317", "http://localhost:4317/", "https+insecure://[::1]:4317", "localhost:4317", "4317"]) {
      const web = {
        ...sharedNode.Web,
        "gateway.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:18080" }, "/gateway": { Proxy: proxy } } },
      };
      expect(funnelConfigurationDisabled({ ...sharedNode, Web: web }, config())).toBe(false);
    }
    const forwarded = (target: string) => ({ ...sharedNode, TCP: { ...sharedNode.TCP, "10000": { TCPForward: target } } });
    expect(funnelConfigurationDisabled(forwarded("127.0.0.1:4317"), config())).toBe(false);
    expect(funnelConfigurationDisabled(forwarded("127.0.0.1:5432"), config())).toBe(true);
    expect(funnelConfigurationDisabled(forwarded("unix:/var/run/app.sock"), config())).toBe(true);
  });

  test("R5 ignores remote services using the gateway port but refuses local targets", () => {
    const proxy = (target: string) => ({ ...sharedNode, Web: { ...sharedNode.Web, "gateway.example.ts.net:8443": { Handlers: { "/": { Proxy: target } } } } });
    expect(funnelConfigurationDisabled(proxy("http://192.0.2.1:4317"), config())).toBe(true);
    expect(funnelConfigurationDisabled({ ...sharedNode, TCP: { "8443": { TCPForward: "192.0.2.1:4317" } } }, config())).toBe(true);
    for (const target of ["http://127.0.0.1:4317", "http://localhost:4317", "http://[::1]:4317", "4317"]) expect(funnelConfigurationDisabled(proxy(target), config())).toBe(false);
  });

  test("checks foreground funnel sessions, which tailscaled merges with the persistent configuration", () => {
    // `tailscale funnel 443` without --bg on the gateway's own authority; no persistent Funnel exists.
    const foregroundFunnel = {
      TCP: sharedNode.TCP,
      Web: sharedNode.Web,
      Foreground: { session: { AllowFunnel: { "gateway.example.ts.net:443": true } } },
    };
    expect(funnelConfigurationDisabled(foregroundFunnel, config())).toBe(false);
    // A foreground handler takes precedence over the persistent one for an already funneled authority.
    const foregroundHandler = {
      ...sharedNode,
      Foreground: {
        session: {
          TCP: { "8443": { HTTPS: true } },
          Web: { "gateway.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4317" } } } },
        },
      },
    };
    expect(funnelConfigurationDisabled(foregroundHandler, config())).toBe(false);
  });

  test("fails closed on a Funnel entry or target it cannot parse", () => {
    expect(funnelConfigurationDisabled(null, config())).toBe(false);
    expect(funnelConfigurationDisabled({ ...sharedNode, Foreground: "unparseable" }, config())).toBe(false);
    expect(funnelConfigurationDisabled({ ...sharedNode, Web: { "gateway.example.ts.net:8443": { Handlers: "unparseable" } } }, config())).toBe(false);
    expect(funnelConfigurationDisabled({ ...sharedNode, TCP: { "8443": "unparseable" } }, config())).toBe(false);
    expect(funnelConfigurationDisabled({ AllowFunnel: true }, config())).toBe(false);
    expect(funnelConfigurationDisabled({ ...sharedNode, AllowFunnel: { "gateway.example.ts.net:8443": "unknown" } }, config())).toBe(false);
    expect(funnelConfigurationDisabled({ AllowFunnel: { "not a host:8443": true } }, config())).toBe(false);
    const web = { ...sharedNode.Web, "gateway.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://[::1" } } } };
    expect(funnelConfigurationDisabled({ ...sharedNode, Web: web }, config())).toBe(false);
  });
});
