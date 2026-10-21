import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findCapabilityLeaks } from "./capability-leak-rules.ts";

export const PRODUCT_VERSION = "0.7.8";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultReleaseRoot = join(root, "dist", "release");
const archiveBase = `omp-session-gateway-${PRODUCT_VERSION}-bun`;
const BUNDLED_WORKSPACES = ["apps/gateway", "apps/web", "packages/collab-client"] as const;
const COLLAB_WEB_LICENSE_PATH = "licenses/collab-web/LICENSE";

export interface ArchiveFile {
  readonly path: string;
  readonly content: Buffer;
  readonly executable: boolean;
}

type BunLockPackage = readonly [
  resolution: string,
  registry?: string,
  metadata?: Readonly<Record<string, unknown>>,
  integrity?: string,
];

interface BunLockWorkspace {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

export interface BunLockfile {
  readonly workspaces: Readonly<Record<string, BunLockWorkspace>>;
  readonly packages: Readonly<Record<string, BunLockPackage>>;
}

export interface RuntimeDependency {
  readonly name: string;
  readonly version: string;
  readonly integrity?: string;
}

export interface ReleaseSource {
  readonly commit: string;
  readonly created: string;
}

export interface UpstreamLockfile {
  readonly commit: string;
  readonly tag: string;
  readonly packageVersions: Readonly<Record<string, string>>;
}

export interface VendoredClientLockfile {
  readonly commit: string;
  readonly tag: string;
  readonly packageVersion: string;
}

interface RuntimeLicenseMetadata {
  readonly version: string;
  readonly source: string;
  readonly licenseDeclared: string;
  readonly licenseConcluded: string;
  readonly copyrightText: string;
  readonly licensePath: string;
}

export const RUNTIME_LICENSES: Readonly<Record<string, RuntimeLicenseMetadata>> = {
  "@oh-my-pi/pi-wire": {
    version: "18.4.2",
    source: "https://github.com/can1357/oh-my-pi/tree/v18.4.2/packages/wire",
    licenseDeclared: "MIT",
    licenseConcluded: "MIT",
    copyrightText: "Copyright (c) 2025-2026 Can Bölük\nCopyright (c) 2026 Stencil Labs, Inc.",
    licensePath: "licenses/runtime/@oh-my-pi__pi-wire/LICENSE",
  },
  "agent-base": {
    version: "7.1.4",
    source: "https://github.com/TooTallNate/proxy-agents/tree/agent-base%407.1.4/packages/agent-base",
    licenseDeclared: "MIT",
    licenseConcluded: "MIT",
    copyrightText: "Copyright (c) 2013 Nathan Rajlich",
    licensePath: "licenses/runtime/agent-base/LICENSE",
  },
  "asn1.js": {
    version: "5.4.1",
    source: "https://github.com/indutny/asn1.js/tree/v5.4.1",
    licenseDeclared: "MIT",
    licenseConcluded: "MIT",
    copyrightText: "Copyright (c) 2017 Fedor Indutny",
    licensePath: "licenses/runtime/asn1.js/LICENSE",
  },
  "bn.js": {
    version: "4.12.5",
    source: "https://github.com/indutny/bn.js/tree/v4.12.5",
    licenseDeclared: "MIT",
    licenseConcluded: "MIT",
    copyrightText: "Copyright Fedor Indutny, 2015",
    licensePath: "licenses/runtime/bn.js/LICENSE",
  },
  "buffer-equal-constant-time": {
    version: "1.0.1",
    source: "https://github.com/goinstant/buffer-equal-constant-time/tree/v1.0.1",
    licenseDeclared: "BSD-3-Clause",
    licenseConcluded: "BSD-3-Clause",
    copyrightText: "Copyright (c) 2013, GoInstant Inc., a salesforce.com company",
    licensePath: "licenses/runtime/buffer-equal-constant-time/LICENSE",
  },
  commander: {
    version: "15.0.0",
    source: "https://github.com/tj/commander.js/tree/v15.0.0",
    licenseDeclared: "MIT",
    licenseConcluded: "MIT",
    copyrightText: "Copyright (c) 2011 TJ Holowaychuk <tj@vision-media.ca>",
    licensePath: "licenses/runtime/commander/LICENSE",
  },
  debug: {
    version: "4.4.3",
    source: "https://github.com/debug-js/debug/tree/4.4.3",
    licenseDeclared: "MIT",
    licenseConcluded: "MIT",
    copyrightText:
      "Copyright (c) 2014-2017 TJ Holowaychuk\nCopyright (c) 2018-2021 Josh Junon",
    licensePath: "licenses/runtime/debug/LICENSE",
  },
  "ecdsa-sig-formatter": {
    version: "1.0.11",
    source: "https://github.com/Brightspace/node-ecdsa-sig-formatter/tree/v1.0.11",
    licenseDeclared: "Apache-2.0",
    licenseConcluded: "Apache-2.0",
    copyrightText: "Copyright 2015 D2L Corporation",
    licensePath: "licenses/runtime/ecdsa-sig-formatter/LICENSE",
  },
  http_ece: {
    version: "1.2.0",
    source: "https://github.com/martinthomson/encrypted-content-encoding/tree/v1.2.0",
    licenseDeclared: "MIT",
    licenseConcluded: "MIT",
    copyrightText: "Copyright (c) 2015 Martin Thomson",
    licensePath: "licenses/runtime/http_ece/LICENSE",
  },
  "https-proxy-agent": {
    version: "7.0.6",
    source: "https://github.com/TooTallNate/proxy-agents/tree/https-proxy-agent%407.0.6/packages/https-proxy-agent",
    licenseDeclared: "MIT",
    licenseConcluded: "MIT",
    copyrightText: "Copyright (c) 2013 Nathan Rajlich",
    licensePath: "licenses/runtime/https-proxy-agent/LICENSE",
  },
  inherits: {
    version: "2.0.4",
    source: "https://github.com/isaacs/inherits/tree/v2.0.4",
    licenseDeclared: "ISC",
    licenseConcluded: "ISC",
    copyrightText: "Copyright (c) Isaac Z. Schlueter",
    licensePath: "licenses/runtime/inherits/LICENSE",
  },
  jwa: {
    version: "2.0.1",
    source: "https://github.com/brianloveswords/node-jwa/tree/2.0.1",
    licenseDeclared: "MIT",
    licenseConcluded: "MIT",
    copyrightText: "Copyright (c) 2013 Brian J. Brennan",
    licensePath: "licenses/runtime/jwa/LICENSE",
  },
  jws: {
    version: "4.0.1",
    source: "https://github.com/brianloveswords/node-jws/tree/v4.0.1",
    licenseDeclared: "MIT",
    licenseConcluded: "MIT",
    copyrightText: "Copyright (c) 2013 Brian J. Brennan",
    licensePath: "licenses/runtime/jws/LICENSE",
  },
  katex: {
    version: "0.18.5",
    source: "https://github.com/KaTeX/KaTeX/tree/v0.18.5",
    licenseDeclared: "MIT",
    licenseConcluded: "MIT",
    copyrightText: "Copyright (c) 2013-2020 Khan Academy and other contributors",
    licensePath: "licenses/runtime/katex/LICENSE",
  },
  "minimalistic-assert": {
    version: "1.0.1",
    source: "https://github.com/calvinmetcalf/minimalistic-assert/tree/v1.0.1",
    licenseDeclared: "ISC",
    licenseConcluded: "ISC",
    copyrightText: "Copyright 2015 Calvin Metcalf",
    licensePath: "licenses/runtime/minimalistic-assert/LICENSE",
  },
  minimist: {
    version: "1.2.8",
    source: "https://github.com/minimistjs/minimist/tree/v1.2.8",
    licenseDeclared: "MIT",
    licenseConcluded: "MIT",
    copyrightText: "NOASSERTION",
    licensePath: "licenses/runtime/minimist/LICENSE",
  },
  ms: {
    version: "2.1.3",
    source: "https://github.com/vercel/ms/tree/2.1.3",
    licenseDeclared: "MIT",
    licenseConcluded: "MIT",
    copyrightText: "Copyright (c) 2020 Vercel, Inc.",
    licensePath: "licenses/runtime/ms/LICENSE",
  },
  "safe-buffer": {
    version: "5.2.1",
    source: "https://github.com/feross/safe-buffer/tree/v5.2.1",
    licenseDeclared: "MIT",
    licenseConcluded: "MIT",
    copyrightText: "Copyright (c) Feross Aboukhadijeh",
    licensePath: "licenses/runtime/safe-buffer/LICENSE",
  },
  "safer-buffer": {
    version: "2.1.2",
    source: "https://github.com/ChALkeR/safer-buffer/tree/v2.1.2",
    licenseDeclared: "MIT",
    licenseConcluded: "MIT",
    copyrightText: "Copyright (c) 2018 Nikita Skovoroda",
    licensePath: "licenses/runtime/safer-buffer/LICENSE",
  },
  "web-push": {
    version: "3.6.7",
    source: "https://github.com/web-push-libs/web-push/tree/v3.6.7",
    licenseDeclared: "MPL-2.0",
    licenseConcluded: "MPL-2.0",
    copyrightText: "Copyright 2015 Marco Castelluccio",
    licensePath: "licenses/runtime/web-push/LICENSE",
  },
  "lucide-react": {
    version: "1.31.0",
    source: "https://github.com/lucide-icons/lucide/tree/1.31.0/packages/lucide-react",
    licenseDeclared: "ISC",
    licenseConcluded: "ISC AND MIT",
    copyrightText:
      "Copyright (c) 2026 Lucide Icons and Contributors\nCopyright (c) 2013-present Cole Bemis",
    licensePath: "licenses/runtime/lucide-react/LICENSE",
  },
  marked: {
    version: "18.0.9",
    source: "https://github.com/markedjs/marked/tree/8e858a4f8e7f53ffeae7392a4c9f455e693aa737",
    licenseDeclared: "MIT",
    licenseConcluded: "MIT AND BSD-3-Clause",
    copyrightText:
      "Copyright (c) 2018+, MarkedJS\nCopyright (c) 2011-2018, Christopher Jeffrey\nCopyright (c) 2004, John Gruber",
    licensePath: "licenses/runtime/marked/LICENSE",
  },
  react: {
    version: "19.2.7",
    source: "https://github.com/facebook/react/tree/6117d7cca4906492c51fe6a03381e35adfd86e7d/packages/react",
    licenseDeclared: "MIT",
    licenseConcluded: "MIT",
    copyrightText: "Copyright (c) Meta Platforms, Inc. and affiliates.",
    licensePath: "licenses/runtime/react/LICENSE",
  },
  "react-dom": {
    version: "19.2.7",
    source: "https://github.com/facebook/react/tree/6117d7cca4906492c51fe6a03381e35adfd86e7d/packages/react-dom",
    licenseDeclared: "MIT",
    licenseConcluded: "MIT",
    copyrightText: "Copyright (c) Meta Platforms, Inc. and affiliates.",
    licensePath: "licenses/runtime/react-dom/LICENSE",
  },
  scheduler: {
    version: "0.27.0",
    source: "https://github.com/facebook/react/tree/861811347b8fa936b4a114fc022db9b8253b3d86/packages/scheduler",
    licenseDeclared: "MIT",
    licenseConcluded: "MIT",
    copyrightText: "Copyright (c) Meta Platforms, Inc. and affiliates.",
    licensePath: "licenses/runtime/scheduler/LICENSE",
  },
};

function objectKeys(value: unknown, field: string): string[] {
  if (typeof value !== "object" || value === null) return [];
  const dependencies = (value as Readonly<Record<string, unknown>>)[field];
  return typeof dependencies === "object" && dependencies !== null ? Object.keys(dependencies) : [];
}

export function runtimeDependenciesFromLock(lock: BunLockfile): RuntimeDependency[] {
  const pending = BUNDLED_WORKSPACES.flatMap(path => {
    const workspace = lock.workspaces[path];
    if (workspace === undefined) throw new Error(`bun.lock is missing bundled workspace ${path}`);
    return [...objectKeys(workspace, "dependencies"), ...objectKeys(workspace, "optionalDependencies")];
  });
  const visited = new Set<string>();
  const dependencies = new Map<string, RuntimeDependency>();

  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || visited.has(name)) continue;
    visited.add(name);
    const entry = lock.packages[name];
    if (entry === undefined) throw new Error(`bun.lock is missing runtime dependency ${name}`);
    const workspacePath = entry[0].match(/@workspace:(.+)$/)?.[1];
    if (workspacePath !== undefined) {
      const workspace = lock.workspaces[workspacePath];
      if (workspace === undefined) throw new Error(`bun.lock is missing workspace ${workspacePath}`);
      pending.push(...objectKeys(workspace, "dependencies"), ...objectKeys(workspace, "optionalDependencies"));
      continue;
    }

    const version = entry[0].slice(entry[0].lastIndexOf("@") + 1);
    dependencies.set(name, {
      name,
      version,
      ...(entry[3] === undefined ? {} : { integrity: entry[3] }),
    });
    pending.push(...objectKeys(entry[2], "dependencies"), ...objectKeys(entry[2], "optionalDependencies"));
  }

  return [...dependencies.values()].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

function runtimeLicense(dependency: RuntimeDependency): RuntimeLicenseMetadata {
  const metadata = RUNTIME_LICENSES[dependency.name];
  if (metadata === undefined) {
    throw new Error(`no reviewed license metadata exists for bundled dependency ${dependency.name}@${dependency.version}`);
  }
  if (metadata.version !== dependency.version) {
    throw new Error(
      `license metadata for ${dependency.name} covers ${metadata.version}, not locked version ${dependency.version}`,
    );
  }
  return metadata;
}

function npmDownloadLocation(dependency: RuntimeDependency): string {
  const basename = dependency.name.slice(dependency.name.lastIndexOf("/") + 1);
  return `https://registry.npmjs.org/${dependency.name}/-/${basename}-${dependency.version}.tgz`;
}

export function validateThirdPartyNotices(notices: string, dependencies: readonly RuntimeDependency[]): void {
  if (notices.includes("No production dependencies")) {
    throw new Error("THIRD_PARTY_NOTICES.md incorrectly claims that no production dependencies are bundled");
  }
  for (const dependency of dependencies) {
    const metadata = runtimeLicense(dependency);
    if (!notices.includes(`${dependency.name}@${dependency.version}`)) {
      throw new Error(`THIRD_PARTY_NOTICES.md is missing ${dependency.name}@${dependency.version}`);
    }
    if (!notices.includes(metadata.licensePath)) {
      throw new Error(`THIRD_PARTY_NOTICES.md is missing license location ${metadata.licensePath}`);
    }
  }
}

export function releaseSourceFromEpoch(commit: string, epoch: string): ReleaseSource {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(commit)) {
    throw new Error(`release source commit must be a full Git object ID: ${commit}`);
  }
  if (!/^\d+$/.test(epoch)) throw new Error(`source timestamp must be epoch seconds: ${epoch}`);
  const milliseconds = Number(epoch) * 1_000;
  const created = new Date(milliseconds);
  if (!Number.isSafeInteger(milliseconds) || Number.isNaN(created.valueOf())) {
    throw new Error(`source timestamp is outside the supported range: ${epoch}`);
  }
  return {
    commit: commit.toLowerCase(),
    created: created.toISOString().replace(".000Z", "Z"),
  };
}

async function runOutput(command: readonly string[]): Promise<string> {
  const subprocess = Bun.spawn([...command], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${command[0] ?? "release command"} failed: ${stderr.trim()}`);
  return stdout.trim();
}

export async function resolveReleaseSource(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ReleaseSource> {
  const commit = environment.GITHUB_SHA ?? (await runOutput(["git", "rev-parse", "HEAD"]));
  const epoch = environment.SOURCE_DATE_EPOCH ?? (await runOutput(["git", "show", "-s", "--format=%ct", commit]));
  return releaseSourceFromEpoch(commit, epoch);
}

async function assertReleaseSourceMatchesCleanCheckout(source: ReleaseSource): Promise<void> {
  const head = (await runOutput(["git", "rev-parse", "HEAD"])).toLowerCase();
  if (source.commit !== head) {
    throw new Error(`release source ${source.commit} does not match checked-out commit ${head}`);
  }
  const commitEpoch = await runOutput(["git", "show", "-s", "--format=%ct", head]);
  if (source.created !== releaseSourceFromEpoch(head, commitEpoch).created) {
    throw new Error("release creation time must equal the checked-out commit timestamp");
  }
  const status = await runOutput(["git", "status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.length > 0) throw new Error("release builds require a clean Git checkout");
}

/**
 * The qualification recorded in release-info.json, keyed by the validated release channel.
 *
 * signed-release.yml delegates exact tag classification to release-policy.ts and exports one of these
 * keys as OMP_RELEASE_CHANNEL. A tag selects a claim but never writes one. Pre-alpha covers both
 * engineering candidates and provenance exercises; alpha and beta retain their deliberately
 * bounded claims; stable names the recorded support matrix without widening it to
 * unadvertised platforms, alternate relays, or browser-process failures outside the PWA.
 */
export const RELEASE_QUALIFICATIONS = {
  "pre-alpha": "pre-alpha; cross-OS and real Android acceptance not yet completed",
  alpha:
    "qualified alpha; supported only for the hosts and client recorded in docs/COMPATIBILITY.md at this source commit; not beta, stable, or production-qualified",
  beta:
    "qualified beta; supported only for the hosts and client recorded in docs/COMPATIBILITY.md at this source commit, and only against the mainline OMP prerequisite recorded in UPSTREAM.lock.json; not stable or production-qualified",
  stable:
    "qualified stable; supported only for the hosts and client recorded in docs/COMPATIBILITY.md at this source commit, and only against the mainline OMP prerequisite recorded in UPSTREAM.lock.json; documented environment limitations and exclusions still apply",
} as const;

export type ReleaseChannel = keyof typeof RELEASE_QUALIFICATIONS;

/**
 * Resolve the recorded qualification from the build environment.
 *
 * An unset channel is a local or untagged build and takes the conservative pre-alpha claim, which
 * also keeps a developer rebuild of a pre-alpha tag byte-identical to the published archive. A
 * rebuild of an alpha or beta tag must therefore pass the matching `OMP_RELEASE_CHANNEL=alpha` or
 * `OMP_RELEASE_CHANNEL=beta` alongside `GITHUB_SHA` and `SOURCE_DATE_EPOCH` to reproduce those
 * bytes.
 *
 * Every other value fails the build instead of shipping an unintended or missing claim: an empty
 * string from a broken workflow expression, an unknown channel, and inherited property names such
 * as `toString` or `__proto__` are all refused. That last case is why this is `Object.hasOwn`
 * rather than a lookup with a fallback: a plain index resolves those names to `Object.prototype`
 * members, which `JSON.stringify` then writes as `{}` or drops entirely instead of recording a
 * claim.
 */
export function releaseQualification(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const channel = environment.OMP_RELEASE_CHANNEL;
  if (channel === undefined) return RELEASE_QUALIFICATIONS["pre-alpha"];
  if (!Object.hasOwn(RELEASE_QUALIFICATIONS, channel)) {
    throw new Error(
      `OMP_RELEASE_CHANNEL must be one of ${Object.keys(RELEASE_QUALIFICATIONS).join(", ")}: ${JSON.stringify(channel)}`,
    );
  }
  return RELEASE_QUALIFICATIONS[channel as ReleaseChannel];
}

export function createSpdxSbom(
  lock: BunLockfile,
  source: ReleaseSource,
  client: VendoredClientLockfile,
  lockSha256: string,
): string {
  const dependencies = runtimeDependenciesFromLock(lock).map((dependency, index) => {
    const metadata = runtimeLicense(dependency);
    return {
      name: dependency.name,
      SPDXID: `SPDXRef-Dependency-${index + 1}`,
      versionInfo: dependency.version,
      downloadLocation: npmDownloadLocation(dependency),
      filesAnalyzed: false,
      licenseConcluded: metadata.licenseConcluded,
      licenseDeclared: metadata.licenseDeclared,
      licenseComments: `License text: ${metadata.licensePath}`,
      copyrightText: metadata.copyrightText,
      ...(dependency.integrity?.startsWith("sha512-")
        ? {
            checksums: [
              {
                algorithm: "SHA512",
                checksumValue: Buffer.from(dependency.integrity.slice("sha512-".length), "base64")
                  .toString("hex")
                  .toUpperCase(),
              },
            ],
          }
        : {}),
    };
  });
  const rootPackage = {
    name: "omp-session-gateway",
    SPDXID: "SPDXRef-Package-Root",
    versionInfo: PRODUCT_VERSION,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "MIT",
    licenseDeclared: "MIT",
    copyrightText: "NOASSERTION",
    sourceInfo: `Built from Git commit ${source.commit}; bun.lock SHA-256 ${lockSha256}`,
  };
  const collabWebPackage = {
    name: "@oh-my-pi/collab-web",
    SPDXID: "SPDXRef-Vendored-Collab-Web",
    versionInfo: client.packageVersion,
    downloadLocation: `https://github.com/can1357/oh-my-pi/tree/${client.commit}/packages/collab-web`,
    filesAnalyzed: false,
    licenseConcluded: "MIT",
    licenseDeclared: "MIT",
    licenseComments: `License text: ${COLLAB_WEB_LICENSE_PATH}`,
    copyrightText:
      "Copyright (c) 2025 Mario Zechner\nCopyright (c) 2025-2026 Can Bölük\nCopyright (c) 2026 Stencil Labs, Inc.",
    sourceInfo: `Vendored from ${client.commit} (${client.tag}) with local modifications documented in THIRD_PARTY_NOTICES.md`,
  };

  return `${JSON.stringify(
    {
      spdxVersion: "SPDX-2.3",
      dataLicense: "CC0-1.0",
      SPDXID: "SPDXRef-DOCUMENT",
      name: `omp-session-gateway-${PRODUCT_VERSION}`,
      documentNamespace: `https://github.com/carrythroughsystems/omp-session-gateway/sbom/${PRODUCT_VERSION}/${source.commit}`,
      creationInfo: {
        created: source.created,
        creators: ["Tool: omp-session-gateway deterministic release builder"],
      },
      packages: [rootPackage, collabWebPackage, ...dependencies],
      relationships: [
        {
          spdxElementId: "SPDXRef-DOCUMENT",
          relationshipType: "DESCRIBES",
          relatedSpdxElement: rootPackage.SPDXID,
        },
        {
          spdxElementId: rootPackage.SPDXID,
          relationshipType: "CONTAINS",
          relatedSpdxElement: collabWebPackage.SPDXID,
        },
        ...dependencies.map(dependency => ({
          spdxElementId: rootPackage.SPDXID,
          relationshipType: "DEPENDS_ON",
          relatedSpdxElement: dependency.SPDXID,
        })),
      ],
    },
    null,
    2,
  )}\n`;
}


async function run(command: readonly string[]): Promise<void> {
  const subprocess = Bun.spawn([...command], { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if ((await subprocess.exited) !== 0) throw new Error(`${command[0] ?? "release command"} failed`);
}

function writeText(target: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > length) throw new Error(`archive path is too long: ${value}`);
  encoded.copy(target, offset);
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  writeText(target, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function tarEntry(file: ArchiveFile): Buffer {
  const header = Buffer.alloc(512);
  writeText(header, 0, 100, file.path);
  writeOctal(header, 100, 8, file.executable ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, file.content.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return Buffer.concat([
    header,
    file.content,
    Buffer.alloc((512 - (file.content.byteLength % 512)) % 512),
  ]);
}

/** The release archive: one regular-file ustar entry per file, then the end-of-archive blocks. */
export function createTarArchive(files: readonly ArchiveFile[]): Buffer {
  return Buffer.concat([...files.map(tarEntry), Buffer.alloc(1_024)]);
}

async function archiveFiles(directory: string): Promise<ArchiveFile[]> {
  const files: ArchiveFile[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const archivePath = `${archiveBase}/${relative(directory, path).replaceAll("\\", "/")}`;
        files.push({ path: archivePath, content: await readFile(path), executable: entry.name === "cli.js" });
      } else {
        throw new Error(`release staging contains an unsupported filesystem entry: ${entry.name}`);
      }
    }
  };
  await visit(directory);
  return files;
}

async function buildRelease(): Promise<void> {
  // Resolved before anything is read or written so an unknown channel fails the build immediately.
  const qualification = releaseQualification();
  const releaseDirectory = process.env.RELEASE_OUTPUT_DIR ?? defaultReleaseRoot;
  const lockText = await Bun.file(join(root, "bun.lock")).text();
  const lock = Bun.JSONC.parse(lockText) as BunLockfile;
  const lockSha256 = createHash("sha256").update(lockText).digest("hex");
  const upstream = JSON.parse(await readFile(join(root, "UPSTREAM.lock.json"), "utf8")) as UpstreamLockfile;
  const source = await resolveReleaseSource();
  await assertReleaseSourceMatchesCleanCheckout(source);
  const dependencies = runtimeDependenciesFromLock(lock);
  const notices = await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  validateThirdPartyNotices(notices, dependencies);
  const client = JSON.parse(
    await readFile(join(root, "packages/collab-client/upstream/UPSTREAM.json"), "utf8"),
  ) as VendoredClientLockfile;
  const collabWebVersion = client.packageVersion;
  if (collabWebVersion === undefined || !notices.includes(`@oh-my-pi/collab-web@${collabWebVersion}`)) {
    throw new Error("THIRD_PARTY_NOTICES.md is missing the vendored @oh-my-pi/collab-web component");
  }
  if (!notices.includes(COLLAB_WEB_LICENSE_PATH)) {
    throw new Error(`THIRD_PARTY_NOTICES.md is missing license location ${COLLAB_WEB_LICENSE_PATH}`);
  }
  for (const dependency of dependencies) {
    const metadata = runtimeLicense(dependency);
    if ((await readFile(join(root, metadata.licensePath))).byteLength === 0) {
      throw new Error(`reviewed license file is empty: ${metadata.licensePath}`);
    }
  }

  await run([process.execPath, "scripts/build-web.ts"]);
  await mkdir(releaseDirectory, { recursive: true });
  await Promise.all([
    rm(join(releaseDirectory, `${archiveBase}.tar`), { force: true }),
    rm(join(releaseDirectory, `omp-session-gateway-${PRODUCT_VERSION}.spdx.json`), { force: true }),
    rm(join(releaseDirectory, "SHA256SUMS"), { force: true }),
  ]);
  const staging = await mkdtemp(join(tmpdir(), "omp-session-gateway-release-"));
  const sbomName = `omp-session-gateway-${PRODUCT_VERSION}.spdx.json`;
  const sbom = createSpdxSbom(lock, source, client, lockSha256);
  try {
    const cliDirectory = join(staging, "apps", "gateway", "src");
    await mkdir(cliDirectory, { recursive: true });
    const build = await Bun.build({
      entrypoints: [join(root, "apps", "gateway", "src", "cli.ts")],
      outdir: cliDirectory,
      naming: "cli.js",
      target: "bun",
      format: "esm",
      minify: true,
      sourcemap: "none",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    if (!build.success) throw new AggregateError(build.logs, "failed to bundle gateway CLI");
    await chmod(join(cliDirectory, "cli.js"), 0o755);
    await cp(join(root, "apps", "web", "dist"), join(staging, "apps", "web", "dist"), { recursive: true });
    await cp(join(root, "licenses"), join(staging, "licenses"), { recursive: true });
    await mkdir(join(staging, "licenses", "collab-web"), { recursive: true });
    await cp(
      join(root, "packages", "collab-client", "upstream", "LICENSE"),
      join(staging, COLLAB_WEB_LICENSE_PATH),
    );
    for (const name of ["LICENSE", "NOTICE.md", "THIRD_PARTY_NOTICES.md", "STABLE_RELEASE.lock.json", "UPSTREAM.lock.json", "bun.lock"]) {
      await cp(join(root, name), join(staging, name));
    }
    await mkdir(join(staging, "schemas"), { recursive: true });
    await cp(
      join(root, "schemas", "stable-release.schema.json"),
      join(staging, "schemas", "stable-release.schema.json"),
    );
    await writeFile(
      join(staging, "package.json"),
      `${JSON.stringify(
        {
          name: "omp-session-gateway",
          version: PRODUCT_VERSION,
          private: true,
          type: "module",
          engines: { bun: ">=1.4.0" },
          bin: {
            "omp-gateway": "apps/gateway/src/cli.js",
            "omp-gatewayd": "apps/gateway/src/cli.js",
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(staging, "release-info.json"),
      `${JSON.stringify(
        {
          product: "OMP Session Gateway",
          version: PRODUCT_VERSION,
          runtime: "Bun >=1.4.0",
          sourceCommit: source.commit,
          sourceCreated: source.created,
          upstreamCommit: upstream.commit,
          bunLockSha256: lockSha256,
          qualification,
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(staging, "SBOM.spdx.json"), sbom);
    const files = await archiveFiles(staging);
    for (const file of files) {
      if (file.path.endsWith(".map")) throw new Error("release archive must not contain source maps");
      const text = file.content.toString("utf8");
      if (findCapabilityLeaks(text).length > 0) {
        throw new Error(`release archive contains a capability-shaped value: ${file.path}`);
      }
    }
    const archive = createTarArchive(files);
    const archiveName = `${archiveBase}.tar`;
    const archivePath = join(releaseDirectory, archiveName);
    const sbomPath = join(releaseDirectory, sbomName);
    const checksumsPath = join(releaseDirectory, "SHA256SUMS");
    await writeFile(archivePath, archive);
    await writeFile(sbomPath, sbom);
    const archiveDigest = createHash("sha256").update(archive).digest("hex");
    const sbomDigest = createHash("sha256").update(sbom).digest("hex");
    await writeFile(
      checksumsPath,
      `${archiveDigest}  ${archiveName}\n${sbomDigest}  ${sbomName}\n`,
    );
    const archiveInfo = await stat(archivePath);
    console.log(`built ${relative(root, archivePath)} (${archiveInfo.size} bytes)`);
    console.log(`wrote ${relative(root, sbomPath)}`);
    console.log(`wrote ${relative(root, checksumsPath)}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) await buildRelease();
