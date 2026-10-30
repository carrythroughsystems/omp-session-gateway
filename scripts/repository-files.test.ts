import { expect, test, setDefaultTimeout } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { repositoryFiles } from "./repository-files.ts";
import { HANG_DEADLINE_MS } from "../apps/gateway/test/test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

async function git(root: string, ...args: string[]): Promise<void> {
  const subprocess = Bun.spawn(
    ["git", "-C", root, "-c", "user.name=probe", "-c", "user.email=probe@example.com", "-c", "commit.gpgsign=false", ...args],
    { stdout: "ignore", stderr: "pipe" },
  );
  const stderr = await new Response(subprocess.stderr).text();
  if ((await subprocess.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
}

test("lists what a commit could carry: tracked plus unignored untracked, never ignored or deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-repository-files-"));
  try {
    await git(root, "init", "-q");
    await writeFile(join(root, ".gitignore"), "exports/\n*.tmp\n");
    await writeFile(join(root, "tracked.md"), "tracked\n");
    await writeFile(join(root, "gone.md"), "will be deleted from the working tree only\n");
    await git(root, "add", ".gitignore", "tracked.md", "gone.md");
    await git(root, "commit", "-q", "-m", "seed");
    await rm(join(root, "gone.md"));
    await writeFile(join(root, "new-untracked.ts"), "untracked but committable\n");
    await mkdir(join(root, "exports"), { recursive: true });
    await writeFile(join(root, "exports", "plan.md"), "ignored directory\n");
    await writeFile(join(root, "scratch.tmp"), "ignored pattern\n");
    await mkdir(join(root, "nested"), { recursive: true });
    await git(join(root, "nested"), "init", "-q");
    await writeFile(join(root, "nested", "inner.md"), "belongs to the nested repository\n");

    const listed = (await repositoryFiles(root)).map(path => relative(root, path)).sort();
    expect(listed).toEqual([".gitignore", "new-untracked.ts", "tracked.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
