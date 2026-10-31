import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, setDefaultTimeout } from "bun:test";
import { HANG_DEADLINE_MS } from "../apps/gateway/test/test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

const WINDOWS = process.platform === "win32";
const guestScript = fileURLToPath(new URL("./windows-qualification-guest.ps1", import.meta.url));
const settled = "[pscustomobject]@{ ready = $true; installed = $true; active = $true; diverged = $false; authMode = 'tailscale-serve'; activeVersion = '0.7.0-abc'; serviceVersion = '0.7.0-abc' }";

/** Loads the real guest script in Windows PowerShell, as WinRM runs it, with `status` scripted. */
async function runGuest(status: string, body: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const root = await mkdtemp(join(tmpdir(), "omp-winqual-guest-"));
  try {
    await writeFile(join(root, "config.json"), JSON.stringify({ auth: { mode: "tailscale-serve", allowedLogins: ["owner@example.invalid"] } }));
    const harness = `
$ErrorActionPreference = 'Stop'
try { . '${guestScript}' @{ action = 'none'; epoch = '00000000-0000-0000-0000-000000000000'; login = 'owner@example.invalid' } }
catch { if ($_.Exception.Message -ne 'unknown qualification action') { throw } }
$base = '${root}'
$statusSettleSeconds = 6
function Preserved { @{ configPreserved = $true; readinessPreserved = $true } }
function State { @{ loopbackOnly = $true } }
${status}
${body}
`;
    const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", harness], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout: stdout.trim(), stderr };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test.skipIf(!WINDOWS)("a post-install status that trails readiness settles within the window", async () => {
  const result = await runGuest(
    `$script:reads = 0; function Status { $script:reads += 1; if ($script:reads -lt 3) { @{ ready = $false } } else { ${settled} } }`,
    "$r = Installed '0.7.0'; 'reads=' + $r.statusReads + ' ready=' + $r.ready",
  );
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("reads=3 ready=True");
}, 2 * HANG_DEADLINE_MS);

test.skipIf(!WINDOWS)("a status that never settles fails naming every field that did not", async () => {
  const result = await runGuest(
    "function Status { @{ ready = $false } }",
    "try { Installed '0.7.0' | Out-Null; 'passed' } catch { $_.Exception.Message }",
  );
  expect(result.stdout).toBe("status mismatch: ready,installed,active,authMode,activeVersion");
}, 2 * HANG_DEADLINE_MS);

test.skipIf(!WINDOWS)("a failing native call names its step, or its executable when unnamed", async () => {
  const result = await runGuest(
    "",
    "foreach ($call in @({ Run 'cmd.exe' @('/c', 'exit 3') 'bun-install' }, { Run 'cmd.exe' @('/c', 'exit 2') })) { try { & $call | Out-Null; 'passed' } catch { $_.Exception.Message } }",
  );
  expect(result.stdout.split(/\r?\n/u)).toEqual(["native command failed: bun-install exit 3", "native command failed: cmd.exe exit 2"]);
}, 2 * HANG_DEADLINE_MS);

test.skipIf(!WINDOWS)("stopping OMP leaves a process that reused its stored ID and reports it stopped", async () => {
  const result = await runGuest(
    "",
    `$other = Start-Process -FilePath ping.exe -ArgumentList @('-n', '60', '127.0.0.1') -PassThru -WindowStyle Hidden
try {
  $stopped = . '${guestScript}' @{ action = 'stopOmp'; epoch = '00000000-0000-0000-0000-000000000000'; login = 'owner@example.invalid'; ompPid = $other.Id; ompPath = 'C:\\omp-winqual-absent\\omp.exe' }
  $stopped + ' alive=' + (-not $other.HasExited)
} finally { Stop-Process -Id $other.Id -Force -ErrorAction SilentlyContinue }`,
  );
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe('{"stopped":true} alive=True');
}, 2 * HANG_DEADLINE_MS);
