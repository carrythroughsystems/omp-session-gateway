import { expect, test } from "bun:test";
import { join } from "node:path";
import { windowsUploadStep, windowsWinrmDiagnostic } from "./windows-qualification-runtime";

test("WinRM failures preserve legacy classification and actionable sanitized helper evidence", () => {
  const diagnostic = windowsWinrmDiagnostic({
    diagnostic: "LookupError",
    exception: {
      type: "LookupError", message: "unknown encoding: synthetic-codec; [REDACTED]", uploadStep: "stream",
      frames: [{ file: "protocol.py", line: 197, function: "open_shell" }],
    },
  });
  expect(diagnostic).toContain("LookupError");
  expect(diagnostic).toContain("unknown encoding: synthetic-codec");
  expect(diagnostic).toContain('"file":"protocol.py"');
  expect(diagnostic).toContain('"uploadStep":"stream"');
  expect(windowsWinrmDiagnostic({ diagnostic: "ConnectionError HTTP 400" })).toBe("ConnectionError HTTP 400");
});

test("each upload failure names its exact sub-step without replaying the operation", async () => {
  for (const step of ["existence/hash", "remove", "stream"] as const) {
    let attempts = 0;
    await expect(windowsUploadStep(step, async observed => {
      expect(observed).toBe(step);
      attempts += 1;
      throw new Error("WinRM transport not yet ready: LookupError");
    })).rejects.toThrow(`Windows upload ${step}: WinRM transport not yet ready: LookupError`);
    expect(attempts).toBe(1);
  }
});

// The WinRM adapter is Python, so its standard-library suite (fake transport, no pywinrm or network)
// runs from here to join every `bun test` instead of depending on someone running it by hand.
test("the WinRM adapter's standard-library suite passes", async () => {
  const interpreter = process.platform === "win32" ? "python" : "python3";
  const child = Bun.spawn([interpreter, join(import.meta.dir, "windows-winrm.test.py")], { stdout: "pipe", stderr: "pipe" });
  const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, summary: stderr.trim().split(/\r?\n/u).at(-1) }).toEqual({ code: 0, summary: "OK" });
});
