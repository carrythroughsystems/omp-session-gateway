import { expect, test, setDefaultTimeout } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQualificationPins } from "./stable-qualification.ts";
import { applyUpstreamPins, deriveUpstreamPins, type PinReader, type UpstreamLock, type WindowsPins } from "./upstream-pins.ts";
import { HANG_DEADLINE_MS } from "./test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

const VERSION = "18.9.9";
const COMMIT = "c".repeat(40);
const TREE = "d".repeat(40);
const ROOT_MANIFEST = `https://raw.githubusercontent.com/can1357/oh-my-pi/${COMMIT}/package.json`;
const WINDOWS_TARBALL = `https://registry.npmjs.org/@oh-my-pi/pi-natives-win32-x64/-/pi-natives-win32-x64-${VERSION}.tgz`;
const lock = JSON.parse(await readFile(new URL("../UPSTREAM.lock.json", import.meta.url), "utf8")) as UpstreamLock;
const windows = JSON.parse(await readFile(new URL("./windows-qualification-pins.json", import.meta.url), "utf8")) as WindowsPins;
const addons = {
  "darwin-arm64": { file: "pi_natives.darwin-arm64.node", payload: "synthetic darwin addon" },
  "win32-x64": { file: windows.omp.nativeFile, payload: "synthetic windows addon" },
};
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

// npm-shaped tarballs, packed by the same `tar` the derivation extracts with.
const tarballs: Record<string, Uint8Array> = {};
const scratch = await mkdtemp(join(tmpdir(), "upstream-pins-"));
try {
  for (const [platform, { file, payload }] of Object.entries(addons)) {
    await mkdir(join(scratch, platform, "package"), { recursive: true });
    await writeFile(join(scratch, platform, "package", file), payload);
    const packed = Bun.spawnSync(["tar", "-czf", "-", "-C", join(scratch, platform), "package"], { stdout: "pipe", stderr: "ignore" });
    if (packed.exitCode !== 0) throw new Error("synthetic native tarball failed");
    tarballs[platform] = packed.stdout;
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

/**
 * Synthetic GitHub and npm answers for VERSION. Registry metadata describes `served`; `changes`
 * replaces single routes afterwards, and an undefined route answers 404.
 */
function publicSource(changes: Record<string, unknown> = {}, served = tarballs): PinReader {
  const routes: Record<string, unknown> = {
    [`https://api.github.com/repos/can1357/oh-my-pi/commits/v${VERSION}`]: { sha: COMMIT, commit: { tree: { sha: TREE } } },
    [`https://registry.npmjs.org/@oh-my-pi%2Fpi-coding-agent/${VERSION}`]: { version: VERSION },
    [`https://registry.npmjs.org/@oh-my-pi%2Fpi-wire/${VERSION}`]: { version: VERSION },
    [ROOT_MANIFEST]: { packageManager: "bun@>=1.4" },
    [`https://raw.githubusercontent.com/can1357/oh-my-pi/${COMMIT}/packages/collab-web/package.json`]: { version: "16.3.6" },
  };
  for (const path of lock.relevantPaths) routes[`https://api.github.com/repos/can1357/oh-my-pi/contents/${path}?ref=${COMMIT}`] = {};
  for (const [platform, tarball] of Object.entries(served)) {
    const url = `https://registry.npmjs.org/@oh-my-pi/pi-natives-${platform}/-/pi-natives-${platform}-${VERSION}.tgz`;
    routes[`https://registry.npmjs.org/@oh-my-pi%2Fpi-natives-${platform}/${VERSION}`] = { dist: {
      tarball: url,
      integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
      shasum: createHash("sha1").update(tarball).digest("hex"),
    } };
    routes[url] = tarball;
  }
  Object.assign(routes, changes);
  return async url => {
    const body = routes[url];
    if (body === undefined) return new Response(null, { status: 404 });
    return body instanceof Uint8Array ? new Response(body.slice()) : Response.json(body);
  };
}

test("hashes each native addon only from the tarball the registry vouches for", async () => {
  expect(await deriveUpstreamPins(VERSION, lock, windows.omp.nativeFile, publicSource())).toEqual({
    version: VERSION,
    tag: `v${VERSION}`,
    commit: COMMIT,
    tree: TREE,
    collabWebVersion: "16.3.6",
    darwinArm64Native: { tarballSha256: sha256(tarballs["darwin-arm64"]!), binarySha256: sha256(addons["darwin-arm64"].payload) },
    win32X64Native: { tarballSha256: sha256(tarballs["win32-x64"]!), binarySha256: sha256(addons["win32-x64"].payload) },
  });
  await expect(deriveUpstreamPins(VERSION, lock, windows.omp.nativeFile, publicSource({ [WINDOWS_TARBALL]: tarballs["darwin-arm64"] })))
    .rejects.toThrow(`@oh-my-pi/pi-natives-win32-x64@${VERSION} does not match the registry integrity`);
  // The Windows guest downloads only the registry's canonical URL, so a pin from elsewhere binds nothing it installs.
  await expect(deriveUpstreamPins(VERSION, lock, windows.omp.nativeFile, publicSource({
    [`https://registry.npmjs.org/@oh-my-pi%2Fpi-natives-win32-x64/${VERSION}`]: { dist: { tarball: "https://mirror.example.invalid/native.tgz" } },
  }))).rejects.toThrow(`is not published at ${WINDOWS_TARBALL}`);
  // A renamed addon must fail rather than pin the hash of nothing.
  await expect(deriveUpstreamPins(VERSION, lock, windows.omp.nativeFile, publicSource({}, { ...tarballs, "win32-x64": tarballs["darwin-arm64"]! })))
    .rejects.toThrow(`lacks package/${windows.omp.nativeFile}`);
});

test("refuses a version, Bun range, or relevant path the pins could not honor", async () => {
  const unread: PinReader = async url => {
    throw new Error(`unexpected read of ${url}`);
  };
  for (const version of ["18.1.19", `${VERSION}-rc.1`, `v${VERSION}`]) {
    await expect(deriveUpstreamPins(version, lock, windows.omp.nativeFile, unread)).rejects.toThrow("a published mainline OMP version >=18.1.20 is required");
  }
  await expect(deriveUpstreamPins(VERSION, lock, windows.omp.nativeFile, publicSource({ [ROOT_MANIFEST]: { packageManager: "bun@>=1.5" } })))
    .rejects.toThrow(`which the pinned Bun ${lock.bunVersion} does not satisfy`);
  const path = lock.relevantPaths.at(-1)!;
  await expect(deriveUpstreamPins(VERSION, lock, windows.omp.nativeFile, publicSource({
    [`https://api.github.com/repos/can1357/oh-my-pi/contents/${path}?ref=${COMMIT}`]: undefined,
  }))).rejects.toThrow(`relevant path ${path} does not exist at v${VERSION}`);
});

test("rewrites only derived fields, leaving pins the qualification lanes accept", async () => {
  const pins = await deriveUpstreamPins(VERSION, lock, windows.omp.nativeFile, publicSource());
  const next = applyUpstreamPins(lock, windows, pins, "2026-10-03");
  for (const field of ["status", "repository", "bunVersion", "relevantPaths", "notes"]) expect(next.lock[field]).toEqual(lock[field]);
  expect({ ...next.windows, omp: undefined }).toEqual({ ...windows, omp: undefined });
  // The Mac and Debian lanes read the lock through this parser; Windows refuses pins that disagree with it.
  expect(parseQualificationPins(JSON.stringify(next.lock))).toEqual({
    bunVersion: lock.bunVersion,
    sourceCommit: COMMIT,
    sourceTree: TREE,
    version: VERSION,
    nativeTarballSha256: pins.darwinArm64Native.tarballSha256,
    nativeBinarySha256: pins.darwinArm64Native.binarySha256,
  });
  expect(next.windows.omp).toEqual({
    ...windows.omp,
    version: VERSION,
    sourceCommit: COMMIT,
    sourceTree: TREE,
    nativeTarballSha256: pins.win32X64Native.tarballSha256,
    nativeBinarySha256: pins.win32X64Native.binarySha256,
  });
});
