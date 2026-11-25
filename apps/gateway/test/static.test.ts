import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { StaticAssetStore } from "../src/static.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "static-realpath-")));
  roots.push(root);
  return root;
}

const textAssets = {
  "index.html": `<!doctype html>${"<p>Synthetic session directory</p>".repeat(64)}`,
  "service-worker.js": "// Synthetic worker script\n".repeat(64),
  "manifest.webmanifest": JSON.stringify({ name: "Synthetic Sessions", description: "Session directory ".repeat(64) }),
  "assets/app.0123456789ab.js": "// Synthetic application bundle\n".repeat(64),
  "assets/app.0123456789ab.css": ".fixture { color: blue; }\n".repeat(64),
  "config.json": JSON.stringify({ names: Array(64).fill("Synthetic entry") }),
  "icon.svg": `<svg xmlns="http://www.w3.org/2000/svg">${'<path d="M0 0h1v1z"/>'.repeat(64)}</svg>`,
};

async function compressionFixture(): Promise<string> {
  const root = await fixture();
  await mkdir(join(root, "assets"));
  await Promise.all(Object.entries(textAssets).map(([path, text]) => writeFile(join(root, path), text)));
  return root;
}

test("negotiates supported encodings by weight and falls back to identity for Range", async () => {
  const store = await StaticAssetStore.load(await compressionFixture());
  for (const [accept, encoding] of [
    [null, null],
    ["", null],
    ["identity", null],
    ["zstd", null],
    ["gzip", "gzip"],
    ["GZIP, bR", "br"],
    ["br;q=0.2, gzip;q=0.7", "gzip"],
    ["gzip;q=0.7, br;q=0.7", "br"],
    ["br;q=0, gzip;q=0", null],
    ["br;q=0, *", "gzip"],
    ["*;q=0.8, br;Q=0.5", "gzip"],
    ["*", "br"],
    ["*;q=0, identity;q=0", null],
    ["*;q=0, br;q=0.7", "br"],
    ["identity;q=1, br;q=0.7", null],
    ["identity;q=0.7, gzip;q=0.7", "gzip"],
    ["br;q=1.001, gzip;q=0.5", "gzip"],
    ["br;q=0.1234, gzip;q=.5", null],
    [`${"zstd,".repeat(63)}br`, "br"],
    [`${"zstd,".repeat(64)}br`, null],
  ] as const) {
    const headers = new Headers();
    if (accept !== null) headers.set("Accept-Encoding", accept);
    const response = store.response("/", headers)!;
    expect(response.headers.get("Content-Encoding")).toBe(encoding);
    expect(response.headers.get("Vary")).toBe("Accept-Encoding");
  }

  const range = store.response("/", new Headers({ Range: "bytes=0-7", "Accept-Encoding": "br, gzip" }))!;
  expect(range.status).toBe(200);
  expect(range.headers.has("Content-Encoding")).toBeFalse();
  expect(range.headers.get("Vary")).toBe("Accept-Encoding");
  expect(await range.text()).toBe(textAssets["index.html"]);
});

test("repeated compressed responses contain the complete identity bytes of every text asset", async () => {
  const store = await StaticAssetStore.load(await compressionFixture());
  for (const [path, text] of Object.entries(textAssets)) {
    const identity = Buffer.from(await store.response(`/${path}`, new Headers())!.arrayBuffer());
    expect(identity).toEqual(Buffer.from(text));
    for (const [encoding, decompress] of [["br", brotliDecompressSync], ["gzip", gunzipSync]] as const) {
      const headers = new Headers({ "Accept-Encoding": encoding });
      for (let i = 0; i < 2; i++) {
        const response = store.response(`/${path}`, headers)!;
        expect(response.headers.get("Content-Encoding")).toBe(encoding);
        const wire = Buffer.from(await response.arrayBuffer());
        expect(response.headers.get("Content-Length")).toBe(String(wire.byteLength));
        expect(wire.byteLength).toBeLessThan(identity.byteLength);
        expect(decompress(wire)).toEqual(identity);
      }
    }
  }
});

test("omits non-saving encodings, never encodes binaries, and never validates hashed assets", async () => {
  const root = await compressionFixture();
  const binary = new Uint8Array(1024);
  await Promise.all([
    writeFile(join(root, "tiny.js"), "x"),
    writeFile(join(root, "icon.png"), binary),
    writeFile(join(root, "assets/fixture.0123456789ab.woff2"), binary),
  ]);
  const store = await StaticAssetStore.load(root);
  const headers = new Headers({ "Accept-Encoding": "br, gzip" });
  const tiny = store.response("/tiny.js", headers)!;
  expect(tiny.headers.has("Content-Encoding")).toBeFalse();
  expect(tiny.headers.get("Vary")).toBe("Accept-Encoding");
  expect(await tiny.text()).toBe("x");
  for (const path of ["/icon.png", "/assets/fixture.0123456789ab.woff2"]) {
    const response = store.response(path, headers)!;
    expect(response.headers.has("Content-Encoding")).toBeFalse();
    expect(response.headers.has("Vary")).toBeFalse();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(binary);
  }
  const icon = store.response("/icon.png", new Headers({ "If-None-Match": "*" }))!;
  expect(icon.status).toBe(304);
  expect(icon.headers.get("ETag")).toBe(store.response("/icon.png", headers)!.headers.get("ETag"));
  expect(icon.headers.has("Vary")).toBeFalse();
  for (const path of ["/assets/app.0123456789ab.js", "/assets/fixture.0123456789ab.woff2"]) {
    const response = store.response(path, new Headers({ "Accept-Encoding": "br", "If-None-Match": "*" }))!;
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.has("ETag")).toBeFalse();
  }
});

test("revalidates an unhashed shell against any current tag and returns the negotiated tag", async () => {
  const store = await StaticAssetStore.load(await compressionFixture());
  for (const path of ["/", "/service-worker.js", "/manifest.webmanifest"]) {
    const tags = ["identity", "br", "gzip"].map(encoding => {
      const response = store.response(path, new Headers({ "Accept-Encoding": encoding }))!;
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
      const tag = response.headers.get("ETag");
      expect(tag).toMatch(/^"[^"]+"$/u);
      return tag!;
    });
    expect(new Set(tags).size).toBe(3);
    const [identity, br, gzip] = tags as [string, string, string];
    for (const condition of [identity, `"stale,opaque", W/${gzip}`, "*"]) {
      const response = store.response(path, new Headers({ "Accept-Encoding": "br", "If-None-Match": condition }))!;
      expect(response.status).toBe(304);
      expect(response.body).toBeNull();
      expect(response.headers.get("ETag")).toBe(br);
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
      expect(response.headers.get("Vary")).toBe("Accept-Encoding");
      for (const header of ["Content-Type", "Content-Encoding", "Content-Length"]) {
        expect(response.headers.has(header)).toBeFalse();
      }
    }
    const stale = store.response(path, new Headers({ "Accept-Encoding": "gzip", "If-None-Match": '"stale"' }))!;
    expect(stale.status).toBe(200);
    expect(stale.headers.get("ETag")).toBe(gzip);
    const tooLong = store.response(path, new Headers({ "If-None-Match": `${identity}, "${"x".repeat(4_096)}"` }))!;
    expect(tooLong.status).toBe(200);
  }
});

test("keeps validators stable for the loaded bytes and changes them for rebuilt content", async () => {
  const root = await compressionFixture();
  const first = await StaticAssetStore.load(root);
  const second = await StaticAssetStore.load(root);
  await writeFile(join(root, "index.html"), `${textAssets["index.html"]}<p>New revision</p>`);
  const updated = await StaticAssetStore.load(root);
  expect(await first.response("/", new Headers())!.text()).toBe(textAssets["index.html"]);
  for (const encoding of ["identity", "br", "gzip"]) {
    const headers = new Headers({ "Accept-Encoding": encoding });
    const tag = first.response("/", headers)!.headers.get("ETag");
    expect(tag).not.toBeNull();
    expect(second.response("/", headers)!.headers.get("ETag")).toBe(tag);
    const response = updated.response("/", new Headers({ "Accept-Encoding": encoding, "If-None-Match": tag! }))!;
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).not.toBe(tag);
  }
});

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
