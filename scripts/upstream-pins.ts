import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readProvider } from "./provider-read.ts";

/**
 * Derives the machine-owned OMP pins in UPSTREAM.lock.json and windows-qualification-pins.json from
 * one published mainline release, replacing the commands #336 and #351 ran by hand: the tag's commit
 * and tree, the npm package versions, upstream's Bun range, and both native addon tarballs. A
 * tarball is hashed only after it matches the registry's sha512 integrity and sha1 shasum, and only
 * from the URL the Mac and Windows qualification helpers download. Every relevant path must exist at
 * the tag: the lock listed a settings schema upstream deleted before v18.4.2 through three baseline
 * moves. Notes, docs, and canary evidence stay human-owned.
 *
 *   bun scripts/upstream-pins.ts <version>          print the derived pins
 *   bun scripts/upstream-pins.ts <version> --write  also rewrite both pin files
 */

const REPOSITORY = "can1357/oh-my-pi";
const DARWIN_NATIVE_FILE = "pi_natives.darwin-arm64.node";

export interface NativePin {
  readonly tarballSha256: string;
  readonly binarySha256: string;
}

export interface UpstreamPins {
  readonly version: string;
  readonly tag: string;
  readonly commit: string;
  readonly tree: string;
  readonly collabWebVersion: string;
  readonly darwinArm64Native: NativePin;
  readonly win32X64Native: NativePin;
}

/** The UPSTREAM.lock.json fields the derivation reads; every other field passes through unchanged. */
export interface UpstreamLock {
  readonly bunVersion: string;
  readonly relevantPaths: readonly string[];
  readonly packageVersions: Readonly<Record<string, string>>;
  readonly [field: string]: unknown;
}

export interface WindowsPins {
  readonly omp: { readonly nativeFile: string; readonly [field: string]: unknown };
  readonly [field: string]: unknown;
}

/** Reads one public URL. Tests replace it; the default authenticates only GitHub API reads. */
export type PinReader = (url: string) => Promise<Response>;

export const readPublicSource: PinReader = url => {
  const token = url.startsWith("https://api.github.com/") ? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN : undefined;
  return readProvider(() => fetch(url, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } }));
};

async function readJson(read: PinReader, url: string): Promise<Record<string, unknown>> {
  const response = await read(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${url} is not a JSON object`);
  return value as Record<string, unknown>;
}

async function nativePin(read: PinReader, platform: string, version: string, file: string): Promise<NativePin> {
  const name = `@oh-my-pi/pi-natives-${platform}`;
  const { dist } = await readJson(read, `https://registry.npmjs.org/${name.replace("/", "%2F")}/${version}`) as {
    readonly dist?: { readonly tarball?: unknown; readonly integrity?: unknown; readonly shasum?: unknown };
  };
  const url = `https://registry.npmjs.org/${name}/-/pi-natives-${platform}-${version}.tgz`;
  if (dist?.tarball !== url) throw new Error(`${name}@${version} is not published at ${url}`);
  const response = await read(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const tarball = new Uint8Array(await response.arrayBuffer());
  if (`sha512-${createHash("sha512").update(tarball).digest("base64")}` !== dist.integrity ||
    createHash("sha1").update(tarball).digest("hex") !== dist.shasum) {
    throw new Error(`${name}@${version} does not match the registry integrity`);
  }
  const binary = Bun.spawnSync(["tar", "-xzOf", "-", `package/${file}`], { stdin: tarball, stdout: "pipe", stderr: "ignore" });
  if (binary.exitCode !== 0 || binary.stdout.length === 0) throw new Error(`${name}@${version} lacks package/${file}`);
  return {
    tarballSha256: createHash("sha256").update(tarball).digest("hex"),
    binarySha256: createHash("sha256").update(binary.stdout).digest("hex"),
  };
}

/** Resolves a release tag or exact source commit without downloading or executing upstream code. */
export async function resolveUpstreamCommit(
  reference: string,
  read: PinReader = readPublicSource,
): Promise<{ readonly commit: string; readonly tree: string }> {
  if (!/^v\d+\.\d+\.\d+$/u.test(reference) && !/^[0-9a-f]{40}$/u.test(reference)) {
    throw new Error("an exact upstream release tag or commit is required");
  }
  const tagged = await readJson(read, `https://api.github.com/repos/${REPOSITORY}/commits/${reference}`) as {
    readonly sha?: unknown;
    readonly commit?: { readonly tree?: { readonly sha?: unknown } };
  };
  const commit = tagged.sha;
  const tree = tagged.commit?.tree?.sha;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/u.test(commit) || typeof tree !== "string" || !/^[0-9a-f]{40}$/u.test(tree)) {
    throw new Error(`${reference} does not resolve to a commit and tree`);
  }
  if (/^[0-9a-f]{40}$/u.test(reference) && reference !== commit) {
    throw new Error(`${reference} resolves to a different commit`);
  }
  return { commit, tree };
}

export async function deriveUpstreamPins(
  version: string,
  lock: UpstreamLock,
  windowsNativeFile: string,
  read: PinReader = readPublicSource,
): Promise<UpstreamPins> {
  if (!/^\d+\.\d+\.\d+$/u.test(version) || !Bun.semver.satisfies(version, ">=18.1.20")) {
    throw new Error("a published mainline OMP version >=18.1.20 is required");
  }
  const tag = `v${version}`;
  const { commit, tree } = await resolveUpstreamCommit(tag, read);
  for (const name of ["pi-coding-agent", "pi-wire"]) {
    const published = await readJson(read, `https://registry.npmjs.org/@oh-my-pi%2F${name}/${version}`);
    if (published.version !== version) throw new Error(`@oh-my-pi/${name}@${version} is not published`);
  }
  const source = `https://raw.githubusercontent.com/${REPOSITORY}/${commit}`;
  const { packageManager } = await readJson(read, `${source}/package.json`);
  const bunRange = typeof packageManager === "string" ? /^bun@(.+)$/u.exec(packageManager)?.[1] : undefined;
  if (bunRange === undefined || !Bun.semver.satisfies(lock.bunVersion, bunRange)) {
    throw new Error(`${tag} declares packageManager ${String(packageManager)}, which the pinned Bun ${lock.bunVersion} does not satisfy`);
  }
  const collabWebVersion = (await readJson(read, `${source}/packages/collab-web/package.json`)).version;
  if (typeof collabWebVersion !== "string" || collabWebVersion === "") throw new Error(`${tag} has no collab-web version`);
  for (const path of lock.relevantPaths) {
    const url = `https://api.github.com/repos/${REPOSITORY}/contents/${path}?ref=${commit}`;
    const response = await read(url);
    await response.body?.cancel();
    if (response.status === 404) throw new Error(`relevant path ${path} does not exist at ${tag}; correct relevantPaths first`);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  }
  return {
    version,
    tag,
    commit,
    tree,
    collabWebVersion,
    darwinArm64Native: await nativePin(read, "darwin-arm64", version, DARWIN_NATIVE_FILE),
    win32X64Native: await nativePin(read, "win32-x64", version, windowsNativeFile),
  };
}

/** Rewrites only the derived fields; Windows qualification refuses pins that disagree with the lock. */
export function applyUpstreamPins<Lock extends UpstreamLock, Windows extends WindowsPins>(
  lock: Lock,
  windows: Windows,
  pins: UpstreamPins,
  observedAt: string,
): { readonly lock: Lock; readonly windows: Windows } {
  return {
    lock: {
      ...lock,
      observedAt,
      tag: pins.tag,
      commit: pins.commit,
      packageVersion: pins.version,
      packageVersions: {
        ...lock.packageVersions,
        "@oh-my-pi/pi-coding-agent": pins.version,
        "@oh-my-pi/pi-wire": pins.version,
        "@oh-my-pi/collab-web": pins.collabWebVersion,
      },
      tree: pins.tree,
      darwinArm64Native: pins.darwinArm64Native,
    },
    windows: {
      ...windows,
      omp: {
        ...windows.omp,
        version: pins.version,
        sourceCommit: pins.commit,
        sourceTree: pins.tree,
        nativeTarballSha256: pins.win32X64Native.tarballSha256,
        nativeBinarySha256: pins.win32X64Native.binarySha256,
      },
    },
  };
}

if (import.meta.main) {
  const [version, ...flags] = process.argv.slice(2);
  if (version === undefined || flags.some(flag => flag !== "--write")) {
    console.error("usage: bun scripts/upstream-pins.ts <version> [--write]");
    process.exit(2);
  }
  const lockPath = join(import.meta.dir, "../UPSTREAM.lock.json");
  const windowsPath = join(import.meta.dir, "windows-qualification-pins.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as UpstreamLock;
  const windows = JSON.parse(await readFile(windowsPath, "utf8")) as WindowsPins;
  const pins = await deriveUpstreamPins(version, lock, windows.omp.nativeFile);
  if (flags.includes("--write")) {
    const next = applyUpstreamPins(lock, windows, pins, new Date().toISOString().slice(0, 10));
    await writeFile(lockPath, `${JSON.stringify(next.lock, null, 2)}\n`);
    await writeFile(windowsPath, `${JSON.stringify(next.windows, null, 2)}\n`);
  }
  console.log(JSON.stringify(pins, null, 2));
}
