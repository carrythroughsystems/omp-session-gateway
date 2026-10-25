import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRODUCT_VERSION,
  RELEASE_QUALIFICATIONS,
  RUNTIME_LICENSES,
  createSpdxSbom,
  releaseQualification,
  releaseSourceFromEpoch,
  resolveReleaseSource,
  runtimeDependenciesFromLock,
  type BunLockfile,
  type VendoredClientLockfile,
} from "./build-release.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedRuntimeDependencies = [
  "@oh-my-pi/pi-wire@18.12.6",
  "agent-base@7.1.4",
  "asn1.js@5.4.1",
  "bn.js@4.12.5",
  "buffer-equal-constant-time@1.0.1",
  "commander@15.0.0",
  "debug@4.4.3",
  "ecdsa-sig-formatter@1.0.11",
  "http_ece@1.2.0",
  "https-proxy-agent@7.0.6",
  "inherits@2.0.4",
  "jwa@2.0.1",
  "jws@4.0.1",
  "katex@0.18.5",
  "lucide-react@1.31.0",
  "minimalistic-assert@1.0.1",
  "minimist@1.2.8",
  "ms@2.1.3",
  "react@19.2.7",
  "react-dom@19.2.7",
  "safe-buffer@5.2.1",
  "safer-buffer@2.1.2",
  "scheduler@0.27.0",
  "web-push@3.6.7",
];
const deterministicSource = releaseSourceFromEpoch("a".repeat(40), "1700000000");

async function releaseInputs(): Promise<{ lock: BunLockfile; lockSha256: string; client: VendoredClientLockfile }> {
  const [lockText, clientText] = await Promise.all([
    readFile(join(root, "bun.lock"), "utf8"),
    readFile(join(root, "packages/collab-client/upstream/UPSTREAM.json"), "utf8"),
  ]);
  return {
    lock: Bun.JSONC.parse(lockText) as BunLockfile,
    lockSha256: createHash("sha256").update(lockText).digest("hex"),
    client: JSON.parse(clientText) as VendoredClientLockfile,
  };
}

async function runReleaseBuilder(
  releaseDirectory: string,
  overrides: Readonly<Record<string, string>> = {},
): Promise<{ archivePath: string; sbomPath: string }> {
  const checkoutSource = await resolveReleaseSource({});
  // A release-tag build exports `OMP_RELEASE_CHANNEL` for the whole job, `bun run check` included,
  // so the ambient value must not decide what these assertions observe. Each case pins its own.
  const environment: Record<string, string | undefined> = { ...process.env };
  delete environment.OMP_RELEASE_CHANNEL;
  const subprocess = Bun.spawn([process.execPath, "scripts/build-release.ts"], {
    cwd: root,
    env: {
      ...environment,
      GITHUB_SHA: checkoutSource.commit,
      SOURCE_DATE_EPOCH: String(Date.parse(checkoutSource.created) / 1_000),
      RELEASE_OUTPUT_DIR: releaseDirectory,
      ...overrides,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`release builder failed: ${stderr.trim()}`);
  return {
    archivePath: join(releaseDirectory, `omp-session-gateway-${PRODUCT_VERSION}-bun.tar`),
    sbomPath: join(releaseDirectory, `omp-session-gateway-${PRODUCT_VERSION}.spdx.json`),
  };
}

function tarEntries(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size)) throw new Error(`invalid tar size for ${name}: ${sizeText}`);
    offset += 512;
    entries.set(name, Buffer.from(archive.subarray(offset, offset + size)));
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

test("derives only the bundled runtime dependency closure from bun.lock", async () => {
  const { lock } = await releaseInputs();
  expect(runtimeDependenciesFromLock(lock).map(dependency => `${dependency.name}@${dependency.version}`)).toEqual(
    expectedRuntimeDependencies,
  );
});

test("SPDX namespace, lock digest, and creation time bind reproducibly to release source", async () => {
  const { lock, lockSha256, client } = await releaseInputs();
  expect(deterministicSource.created).toBe("2023-11-14T22:13:20Z");
  expect(
    await resolveReleaseSource({ GITHUB_SHA: "b".repeat(40), SOURCE_DATE_EPOCH: "1700000000" }),
  ).toEqual({ commit: "b".repeat(40), created: "2023-11-14T22:13:20Z" });

  const document = JSON.parse(createSpdxSbom(lock, deterministicSource, client, lockSha256)) as {
    documentNamespace: string;
    creationInfo: { created: string };
    packages: Array<{ name: string; versionInfo: string; licenseDeclared: string; licenseConcluded?: string; sourceInfo?: string }>;
  };
  expect(document.documentNamespace).toBe(
    `https://github.com/carrythroughsystems/omp-session-gateway/sbom/${PRODUCT_VERSION}/${"a".repeat(40)}`,
  );
  expect(document.creationInfo.created).toBe(deterministicSource.created);
  expect(document.packages.map(pkg => `${pkg.name}@${pkg.versionInfo}`)).toEqual([
    `omp-session-gateway@${PRODUCT_VERSION}`,
    "@oh-my-pi/collab-web@16.3.6",
    "@oh-my-pi/pi-utils (vendored Markdown sources)@18.12.6",
    "Symbols Nerd Font Mono@v3.5.1",
    ...expectedRuntimeDependencies,
  ]);
  expect(document.packages[0]?.sourceInfo).toContain(lockSha256);
  expect(document.packages.find(pkg => pkg.name === "@oh-my-pi/collab-web")?.sourceInfo).toContain(client.commit);
  const parser = document.packages.find(pkg => pkg.name === "@oh-my-pi/pi-utils (vendored Markdown sources)");
  expect(parser?.sourceInfo).toContain(client.commit);
  expect(client.additionalSources.map(source => source.sourcePath)).toEqual([
    "packages/utils/src/marked.ts",
    "packages/utils/src/marked/core.ts",
    "packages/utils/src/marked/inline-closers.ts",
    "packages/utils/src/marked/inline-text.ts",
    "packages/utils/src/marked-list.ts",
    "packages/utils/src/math-delimiters.ts",
  ]);
  for (const source of client.additionalSources) expect(parser?.sourceInfo).toContain(source.sourcePath);
  expect(document.packages.find(pkg => pkg.name === "lucide-react")?.licenseDeclared).toBe("ISC");
  expect(document.packages.find(pkg => pkg.name === "react")?.licenseDeclared).toBe("MIT");
  const font = document.packages.find(pkg => pkg.name === "Symbols Nerd Font Mono");
  expect(font?.licenseDeclared).toBe("MIT");
  expect(font?.licenseConcluded).toBe("MIT AND Apache-2.0 AND CC-BY-4.0 AND OFL-1.1 AND OFL-1.1-RFN AND Unlicense");

  const otherSourceDocument = JSON.parse(
    createSpdxSbom(lock, releaseSourceFromEpoch("c".repeat(40), "1700000000"), client, lockSha256),
  ) as { documentNamespace: string };
  expect(otherSourceDocument.documentNamespace).not.toBe(document.documentNamespace);
});

test(
  "repeated release builds are byte-identical, preserve unrelated output, and archive all provenance",
  async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-release-test-"));
    const releaseDirectory = join(temporaryRoot, "release");
    try {
      const first = await runReleaseBuilder(releaseDirectory);
      const [firstArchive, firstSbom] = await Promise.all([readFile(first.archivePath), readFile(first.sbomPath)]);
      const sentinel = join(releaseDirectory, "unrelated-user-file.txt");
      await writeFile(sentinel, "preserve me");
      const second = await runReleaseBuilder(releaseDirectory);
      const [secondArchive, secondSbom] = await Promise.all([readFile(second.archivePath), readFile(second.sbomPath)]);
      expect(secondArchive.equals(firstArchive)).toBe(true);
      expect(secondSbom.equals(firstSbom)).toBe(true);
      expect(await readFile(sentinel, "utf8")).toBe("preserve me");

      const entries = tarEntries(secondArchive);
      const archivePrefix = `omp-session-gateway-${PRODUCT_VERSION}-bun/`;
      expect(entries.get(`${archivePrefix}SBOM.spdx.json`)?.equals(secondSbom)).toBe(true);
      expect(entries.get(`${archivePrefix}THIRD_PARTY_NOTICES.md`)?.toString("utf8")).not.toContain(
        "No production dependencies",
      );
      expect(entries.has(`${archivePrefix}licenses/collab-web/LICENSE`)).toBe(true);
      expect(entries.has(`${archivePrefix}licenses/pi-utils-marked/LICENSE`)).toBe(true);
      expect(entries.get(`${archivePrefix}licenses/pi-utils-marked/LICENSE`)?.toString("utf8")).toContain("MarkedJS");
      expect(entries.has(`${archivePrefix}licenses/runtime/marked/LICENSE`)).toBe(false);
      expect(entries.has(`${archivePrefix}licenses/oh-my-pi/LICENSE`)).toBe(true);
      expect(entries.has(`${archivePrefix}bun.lock`)).toBe(true);
      expect([...entries.keys()].some(path => path.startsWith(`${archivePrefix}patches/`))).toBe(false);
      for (const metadata of Object.values(RUNTIME_LICENSES)) {
        expect(entries.has(`${archivePrefix}${metadata.licensePath}`)).toBe(true);
      }
      const releaseInfo = JSON.parse(entries.get(`${archivePrefix}release-info.json`)?.toString("utf8") ?? "{}") as {
        bunLockSha256?: string;
        qualification?: string;
      };
      const archivedLock = entries.get(`${archivePrefix}bun.lock`);
      expect(archivedLock).toBeDefined();
      expect(releaseInfo.bunLockSha256).toBe(createHash("sha256").update(archivedLock ?? "").digest("hex"));
      expect(releaseInfo.qualification).toBe(RELEASE_QUALIFICATIONS["pre-alpha"]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
  20_000,
);

test("the recorded qualification comes from a closed channel set that fails shut", () => {
  expect(Object.keys(RELEASE_QUALIFICATIONS)).toEqual(["pre-alpha", "alpha", "beta", "stable"]);
  expect(releaseQualification({})).toBe(RELEASE_QUALIFICATIONS["pre-alpha"]);
  expect(releaseQualification({ OMP_RELEASE_CHANNEL: "pre-alpha" })).toBe(RELEASE_QUALIFICATIONS["pre-alpha"]);
  expect(releaseQualification({ OMP_RELEASE_CHANNEL: "alpha" })).toBe(RELEASE_QUALIFICATIONS.alpha);
  expect(releaseQualification({ OMP_RELEASE_CHANNEL: "beta" })).toBe(RELEASE_QUALIFICATIONS.beta);
  expect(releaseQualification({ OMP_RELEASE_CHANNEL: "stable" })).toBe(RELEASE_QUALIFICATIONS.stable);
  const refused = [
    "",
    " ",
    "release-candidate",
    "rc",
    "Alpha",
    "Beta",
    "Stable",
    "pre-alpha ",
    " beta",
    "stable.1",
    "beta.1",
    "toString",
    "__proto__",
    "constructor",
  ];
  for (const injected of refused) {
    expect(() => releaseQualification({ OMP_RELEASE_CHANNEL: injected })).toThrow(
      /^OMP_RELEASE_CHANNEL must be one of pre-alpha, alpha, beta, stable: /,
    );
  }
});

test(
  "the release channel decides only the recorded qualification, and an unknown one fails the build",
  async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-release-channel-"));
    const infoPath = "omp-session-gateway-" + PRODUCT_VERSION + "-bun/release-info.json";
    try {
      const candidate = await runReleaseBuilder(join(temporaryRoot, "candidate"));
      const alpha = await runReleaseBuilder(join(temporaryRoot, "alpha"), { OMP_RELEASE_CHANNEL: "alpha" });
      const beta = await runReleaseBuilder(join(temporaryRoot, "beta"), { OMP_RELEASE_CHANNEL: "beta" });
      const stable = await runReleaseBuilder(join(temporaryRoot, "stable"), { OMP_RELEASE_CHANNEL: "stable" });
      const candidateEntries = tarEntries(await readFile(candidate.archivePath));
      const alphaEntries = tarEntries(await readFile(alpha.archivePath));
      const betaEntries = tarEntries(await readFile(beta.archivePath));
      const stableEntries = tarEntries(await readFile(stable.archivePath));
      const qualificationOf = (entries: Map<string, Buffer>): unknown => {
        const info: unknown = JSON.parse(entries.get(infoPath)?.toString("utf8") ?? "{}");
        if (info === null || typeof info !== "object" || !("qualification" in info)) return undefined;
        return info.qualification;
      };
      const differingPaths = (entries: Map<string, Buffer>): string[] =>
        [...entries]
          .filter(([path, content]) => !content.equals(candidateEntries.get(path) ?? Buffer.alloc(0)))
          .map(([path]) => path);

      expect(qualificationOf(candidateEntries)).toBe(RELEASE_QUALIFICATIONS["pre-alpha"]);
      expect(qualificationOf(alphaEntries)).toBe(RELEASE_QUALIFICATIONS.alpha);
      expect(qualificationOf(betaEntries)).toBe(RELEASE_QUALIFICATIONS.beta);
      expect(qualificationOf(stableEntries)).toBe(RELEASE_QUALIFICATIONS.stable);
      for (const promotedEntries of [alphaEntries, betaEntries, stableEntries]) {
        expect([...promotedEntries.keys()]).toEqual([...candidateEntries.keys()]);
        expect(differingPaths(promotedEntries)).toEqual([infoPath]);
      }
      expect(stableEntries.get(infoPath)?.equals(betaEntries.get(infoPath) ?? Buffer.alloc(0))).toBe(false);
      const [candidateSbom, alphaSbom, betaSbom, stableSbom] = await Promise.all([
        readFile(candidate.sbomPath),
        readFile(alpha.sbomPath),
        readFile(beta.sbomPath),
        readFile(stable.sbomPath),
      ]);
      expect(alphaSbom.equals(candidateSbom)).toBe(true);
      expect(betaSbom.equals(candidateSbom)).toBe(true);
      expect(stableSbom.equals(candidateSbom)).toBe(true);

      await expect(
        runReleaseBuilder(join(temporaryRoot, "refused"), { OMP_RELEASE_CHANNEL: "release-candidate" }),
      ).rejects.toThrow(/OMP_RELEASE_CHANNEL must be one of pre-alpha, alpha, beta, stable: "release-candidate"/);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
  60_000,
);
