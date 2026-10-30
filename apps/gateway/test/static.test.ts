import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaticAssetStore } from "../src/static.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "static-realpath-")));
  roots.push(root);
  return root;
}

test("serves normal assets without admitting dot-dot or backslash escapes", async () => {
  const root = await fixture(), assets = join(root, "assets");
  await mkdir(assets);
  await writeFile(join(assets, "index.html"), "synthetic shell");
  await writeFile(join(root, "outside.txt"), "outside the asset root");
  const store = await StaticAssetStore.load(assets);
  expect(await store.response("/")!.text()).toBe("synthetic shell");
  for (const path of ["/../outside.txt", "/nested/../../outside.txt", "/..\\outside.txt", "/index.html/"]) {
    expect(store.response(path)).toBeUndefined();
  }
});

test.skipIf(process.platform === "win32")("rejects file and directory symlinks outside the asset root", async () => {
  const root = await fixture();
  await writeFile(join(root, "outside.txt"), "outside the asset root");
  for (const directory of [false, true]) {
    const assets = join(root, directory ? "directory-assets" : "file-assets");
    await mkdir(assets);
    await writeFile(join(assets, "index.html"), "synthetic shell");
    await symlink(directory ? root : join(root, "outside.txt"), join(assets, "escape"));
    await expect(StaticAssetStore.load(assets)).rejects.toThrow("static assets may not contain symlinks");
  }
});

test.skipIf(process.platform === "win32")("resolves a symlink before its parent segment when selecting the asset root", async () => {
  const root = await fixture(), target = join(root, "target");
  await mkdir(join(target, "nested"), { recursive: true });
  await writeFile(join(root, "index.html"), "lexical parent must not be served");
  await writeFile(join(target, "index.html"), "symlink target parent");
  const link = join(root, "link");
  await symlink(join(target, "nested"), link);
  const store = await StaticAssetStore.load(`${link}/..`);
  expect(await store.response("/")!.text()).toBe("symlink target parent");
});

test.skipIf(process.platform === "win32")("preserves a literal POSIX backslash in the asset root", async () => {
  const root = await fixture(), assets = join(root, "literal\\directory");
  await mkdir(assets);
  await writeFile(join(assets, "index.html"), "literal backslash shell");
  expect(await (await StaticAssetStore.load(assets)).response("/")!.text()).toBe("literal backslash shell");
});

test("refuses a regular file as the asset root even with a trailing slash", async () => {
  const root = await fixture(), file = join(root, "index.html");
  await writeFile(file, "not a directory");
  await expect(StaticAssetStore.load(`${file}/`)).rejects.toThrow();
});
