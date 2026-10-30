import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDoctorChecks } from "../src/doctor.ts";
import { HANG_DEADLINE_MS } from "./test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

/**
 * The report is the operator contract: an unsafe topology or an unsupported OMP must stay visible
 * even when config declares trust. The version and tunnel probes isolate those inputs, while the
 * discovery checks read actual files under a temporary HOME rather than the operator's registry.
 */
describe("doctor reports mainline compatibility and discovery health", () => {
  const saved = { ...process.env };
  const roots: string[] = [];

  afterEach(async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  async function isolatedRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "gateway-doctor-"));
    roots.push(root);
    process.env.HOME = join(root, "home");
    process.env.USERPROFILE = join(root, "home");
    process.env.PI_CONFIG_DIR = ".omp-test";
    for (const part of ["config/omp-session-gateway", "state/omp-session-gateway", "run/omp-session-gateway"]) {
      await mkdir(join(root, part), { recursive: true, mode: 0o700 });
    }
    const configPath = join(root, "config/omp-session-gateway/config.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        http: { hostname: "127.0.0.1", port: 4399, publicOrigin: "https://gateway.example.ts.net" },
        auth: { mode: "tailscale-serve", allowedLogins: ["doctor@example.com"] },
        registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 10 },
      })}\n`,
    );
    await chmod(configPath, 0o600);
    const tokenPath = join(root, "config/omp-session-gateway/readiness-token");
    await writeFile(tokenPath, "D".repeat(43));
    await chmod(tokenPath, 0o600);

    process.env.XDG_CONFIG_HOME = join(root, "config");
    process.env.XDG_STATE_HOME = join(root, "state");
    process.env.XDG_RUNTIME_DIR = join(root, "run");
    return root;
  }

  test("withholds trust without a tunnel device and compatibility without a reachable OMP", async () => {
    await isolatedRoot();
  
    const report = await runDoctorChecks({ tunDevicePresent: () => false, ompVersion: async () => undefined,
      ternAvailable: async () => { throw new Error("unconfigured probe must not run"); } });
  
    expect(report.service).toBe("omp-session-gateway");
    expect(report.checks).toMatchObject({
      config: true,
      loopbackTrustSound: false,
      compatibility: false,
      discoveryReadable: true,
      sessionHealth: false,
    });
    expect(Object.values(report.checks).every(value => typeof value === "boolean")).toBe(true);
    expect(Object.hasOwn(report.checks, "ternAvailable")).toBe(false);
    // Deliberately no assertion on listenerLoopbackOnly: no daemon runs in this isolated root, so
    // false would discriminate nothing about whether topology withholds that secondary claim.
  }, 2 * HANG_DEADLINE_MS);

  test("reports configured Tern availability as an injected boolean without starting a command", async () => {
    const root = await isolatedRoot();
    const path = join(root, "config/omp-session-gateway/config.json");
    const document = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...document, tern: {} }));
    let probes = 0;
    const report = await runDoctorChecks({ ompVersion: async () => "18.1.20",
      ternAvailable: async () => { probes++; throw new Error("TERN_DOCTOR_PRIVATE_CANARY"); } });
    expect(probes).toBe(1);
    expect(report.checks.ternAvailable).toBe(false);
    expect(JSON.stringify(report)).not.toContain("TERN_DOCTOR_PRIVATE_CANARY");
  }, 2 * HANG_DEADLINE_MS);

  test("reports sound trust and compatibility at the minimum mainline release", async () => {
    await isolatedRoot();
  
    const report = await runDoctorChecks({ tunDevicePresent: () => true, ompVersion: async () => "omp/18.1.20\n" });
  
    expect(report.checks.loopbackTrustSound).toBe(true);
    expect(report.checks.compatibility).toBe(true);
  }, 2 * HANG_DEADLINE_MS);

  test("does not let declared trust hide an unsafe topology or an unsupported OMP", async () => {
    const root = await isolatedRoot();
    const configPath = join(root, "config/omp-session-gateway/config.json");
    const document = JSON.parse(await readFile(configPath, "utf8")) as {
      auth: { trustIdentityWithoutTailnetDevice?: boolean };
    };
    document.auth.trustIdentityWithoutTailnetDevice = true;
    await writeFile(configPath, `${JSON.stringify(document)}\n`);
    await chmod(configPath, 0o600);
  
    const report = await runDoctorChecks({ tunDevicePresent: () => false, ompVersion: async () => "18.1.19" });
  
    // The flag asserts trust; it does not establish it. A host that sets it while running
    // userspace-mode tailscaled must still fail here, or the escape hatch would hide the exposure.
    expect(report.checks.loopbackTrustSound).toBe(false);
    expect(report.checks.compatibility).toBe(false);
  }, 2 * HANG_DEADLINE_MS);

  test("reports an unreadable service manager as failed service checks, not a failed report", async () => {
    await isolatedRoot();
  
    const report = await runDoctorChecks({
      tunDevicePresent: () => true,
      ompVersion: async () => "18.1.20",
      serviceStatus: async () => {
        throw new Error("cannot read the Windows gateway task's state");
      },
    });
  
    // Checks computed after the service probe still report, so one unreadable manager costs two checks.
    expect(report.checks).toMatchObject({
      config: true,
      serviceInstalled: false,
      serviceActive: false,
      loopbackTrustSound: true,
      compatibility: true,
    });
  }, 2 * HANG_DEADLINE_MS);

  test("reports a symlinked discovery directory as unreadable without following or removing it", async () => {
    if (process.platform === "win32") return;
    const root = await isolatedRoot();
    const directory = join(root, "home", ".omp-test", "run", "collab-hosts");
    const target = join(root, "external-discovery");
    await mkdir(join(root, "home", ".omp-test", "run"), { recursive: true, mode: 0o700 });
    await mkdir(target, { mode: 0o700 });
    await symlink(target, directory);
  
    // A fresh runtime receives HOME before any homedir lookup, so this check cannot inherit the
    // runner's original home and mistake an absent directory for the symlink under examination.
    const subprocess = Bun.spawn([
      process.execPath,
      "--eval",
      `import { runDoctorChecks } from ${JSON.stringify(new URL("../src/doctor.ts", import.meta.url).href)};
       import { loadGatewayConfig } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};
       const config = await loadGatewayConfig();
       if (config.omp.discoveryDir !== process.env.EXPECTED_DISCOVERY_DIRECTORY) throw new Error("discovery path escaped sandbox");
       console.log(JSON.stringify(await runDoctorChecks({ tunDevicePresent: () => true, ompVersion: async () => "18.1.20" })));`,
    ], {
      env: { ...process.env, EXPECTED_DISCOVERY_DIRECTORY: directory },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const report = JSON.parse(stdout) as { checks: Record<string, boolean> };
    expect(report.checks).toMatchObject({ compatibility: true, discoveryReadable: false, permissions: false });
    expect((await lstat(directory)).isSymbolicLink()).toBe(true);
    expect((await lstat(target)).isDirectory()).toBe(true);
  }, 2 * HANG_DEADLINE_MS);
});
