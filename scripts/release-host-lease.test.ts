import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearReleaseHostLease, withReleaseHostLease } from "./release-host-lease.ts";

function campaign(directory: string, owner: string) {
  const source = `
    import { withReleaseHostLease } from ${JSON.stringify(join(import.meta.dir, "release-host-lease.ts"))};
    try {
      await withReleaseHostLease(${JSON.stringify(owner)}, async () => {
        console.log("held");
        const command = await Bun.stdin.text();
        if (command === "fail") throw new Error("campaign failed");
      }, ${JSON.stringify(directory)});
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  `;
  const child = Bun.spawn([process.execPath, "--eval", source], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const firstOutput = child.stdout.getReader().read().then(chunk => new TextDecoder().decode(chunk.value).trim());
  const error = new Response(child.stderr).text();
  return { child, firstOutput, error };
}

describe.skipIf(process.platform === "win32")("cross-process release-host ownership", () => {
  test("self-clear requires verified cleanup and the exact inactive owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-host-self-clear-"));
    try {
      await expect(withReleaseHostLease("candidate-a", async () => { throw new Error("failed"); }, root)).rejects.toThrow("failed");
      await expect(clearReleaseHostLease("candidate-a", async () => { throw new Error("cleanup incomplete"); }, root)).rejects.toThrow("cleanup incomplete");
      await expect(clearReleaseHostLease("candidate-b", async () => {}, root)).rejects.toThrow("owner");
      let receipts = 0;
      expect(await clearReleaseHostLease("candidate-a", async () => { receipts++; }, root)).toBe("cleared");
      expect(receipts).toBe(1);
      expect(await clearReleaseHostLease("candidate-a", async () => { throw new Error("already cleared"); }, root)).toBe("absent");
      await withReleaseHostLease("candidate-b", async () => {}, root);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("self-clear cannot steal a live OS lock even from the same owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-host-self-clear-live-"));
    const holder = campaign(root, "candidate-a");
    try {
      expect(await holder.firstOutput).toBe("held");
      await expect(clearReleaseHostLease("candidate-a", async () => { throw new Error("must not reach cleanup"); }, root)).rejects.toThrow("busy");
    } finally {
      holder.child.stdin.end();
      await holder.child.exited;
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["qualification:v1:receipt-a", "qualification:v1:receipt-a"],
    ["qualification:v1:receipt-a", "qualification:v2:receipt-b"],
    ["qualification:v1:receipt-a", "smoke:repository:v1"],
  ])("only one simultaneous campaign holds the host: %s / %s", async (first, second) => {
    const root = await mkdtemp(join(tmpdir(), "gateway-host-lease-"));
    const directory = join(root, "lease");
    const contenders = [campaign(directory, first), campaign(directory, second)];
    try {
      const output = await Promise.all(contenders.map(entry => entry.firstOutput));
      if (!output.includes("held")) {
        throw new Error(`no contender acquired the lease: ${JSON.stringify(await Promise.all(contenders.map(entry => entry.error)))}`);
      }
      expect(output.filter(value => value === "held")).toHaveLength(1);
      const winner = contenders[output.indexOf("held")]!;
      const loser = contenders[output.findIndex(value => value !== "held")]!;
      expect(await loser.child.exited).toBe(1);
      expect(await loser.error).toContain("release host is busy");
      winner.child.stdin.end();
      expect(await winner.child.exited).toBe(0);
      expect((await stat(join(directory, "lease.sqlite"))).mode & 0o777).toBe(0o600);
      await withReleaseHostLease("next campaign", async () => {}, directory);
    } finally {
      for (const entry of contenders) entry.child.kill();
      await Promise.all(contenders.map(entry => entry.child.exited));
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a crashed holder is recoverable only by its campaign, never stolen while live", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-host-crash-"));
    const directory = join(root, "lease");
    const holder = campaign(directory, "candidate-a");
    const children = [holder];
    try {
      expect(await holder.firstOutput).toBe("held");
      const liveRecovery = campaign(directory, "candidate-a");
      children.push(liveRecovery);
      expect(await liveRecovery.child.exited).toBe(1);
      expect(await liveRecovery.error).toContain("release host is busy");
      holder.child.kill("SIGKILL");
      await holder.child.exited;

      const other = campaign(directory, "candidate-b");
      children.push(other);
      expect(await other.child.exited).toBe(1);
      expect(await other.error).toContain("recovery by its previous campaign");
      const recovery = campaign(directory, "candidate-a");
      children.push(recovery);
      expect(await recovery.firstOutput).toBe("held");
      recovery.child.stdin.end();
      expect(await recovery.child.exited).toBe(0);
      await withReleaseHostLease("candidate-b", async () => {}, directory);
    } finally {
      for (const entry of children) entry.child.kill();
      await Promise.all(children.map(entry => entry.child.exited));
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a second call in the same process cannot unlock its first lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-host-reentrant-"));
    try {
      await withReleaseHostLease("candidate-a", async () => {
        await expect(withReleaseHostLease("candidate-a", async () => {}, root)).rejects.toThrow("release host is busy");
        const contender = campaign(root, "candidate-a");
        expect(await contender.child.exited).toBe(1);
        expect(await contender.error).toContain("release host is busy");
      }, root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("caught failures retain recovery ownership until that campaign succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-host-failure-"));
    try {
      await expect(withReleaseHostLease("candidate-a", async () => { throw new Error("failed"); }, root)).rejects.toThrow("failed");
      await expect(withReleaseHostLease("candidate-b", async () => {}, root)).rejects.toThrow("recovery by its previous campaign");
      expect(await withReleaseHostLease("candidate-a", async () => 42, root)).toBe(42);
      await withReleaseHostLease("candidate-b", async () => {}, root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a symlink cannot redirect the permanent lock inode", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-host-symlink-"));
    try {
      const unrelated = join(root, "unrelated");
      await writeFile(unrelated, "unchanged");
      await symlink(unrelated, join(root, "lease.sqlite"));
      let ran = false;
      await expect(withReleaseHostLease("candidate-a", async () => { ran = true; }, root)).rejects.toThrow();
      expect(ran).toBe(false);
      expect(await readFile(unrelated, "utf8")).toBe("unchanged");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
