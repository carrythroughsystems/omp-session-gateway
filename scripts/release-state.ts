import { releaseVersion } from "./release-policy.ts";
import { readProvider } from "./provider-read.ts";

function expectedAssets(tag: string): readonly string[] {
  const version = releaseVersion(tag);
  return [
    "SHA256SUMS",
    "SHA256SUMS.sigstore.json",
    `omp-session-gateway-${version}-bun.tar`,
    `omp-session-gateway-${version}-bun.tar.sigstore.json`,
    `omp-session-gateway-${version}.spdx.json`,
    `omp-session-gateway-${version}.spdx.json.sigstore.json`,
  ];
}

export async function releaseAssetDigests(root: string, tag: string): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const name of expectedAssets(tag)) {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(await Bun.file(root + "/" + name).arrayBuffer());
    digests[name] = "sha256:" + hasher.digest("hex");
  }
  return digests;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(label + " must be an object");
  }
  return value as Record<string, unknown>;
}

export function assertReleaseState(
  value: unknown,
  latestTag: string | null,
  expected: {
    readonly tag: string;
    readonly draft: boolean;
    readonly prerelease: boolean;
    readonly latest: boolean;
    readonly assetDigests: Readonly<Record<string, string>>;
  },
): void {
  const expectedAssetNames = expectedAssets(expected.tag);
  const release = record(value, "GitHub release");
  if (
    release.tag_name !== expected.tag ||
    release.draft !== expected.draft ||
    release.prerelease !== expected.prerelease ||
    (latestTag === expected.tag) !== expected.latest
  ) {
    throw new Error("GitHub release flags do not match the validated policy");
  }
  if (!Array.isArray(release.assets) || release.assets.length !== expectedAssetNames.length) {
    throw new Error("GitHub release does not contain exactly six assets");
  }
  const names: string[] = [];
  for (const value of release.assets) {
    const asset = record(value, "GitHub release asset");
    if (
      typeof asset.name !== "string" ||
      asset.state !== "uploaded" ||
      typeof asset.digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(asset.digest)
    ) {
      throw new Error("GitHub release contains an incomplete asset");
    }
    if (asset.digest !== expected.assetDigests[asset.name]) {
      throw new Error("GitHub release asset digest does not match the signed local file");
    }
    names.push(asset.name);
  }
  names.sort();
  if (names.some((name, index) => name !== expectedAssetNames[index])) {
    throw new Error("GitHub release asset names do not match the stable contract");
  }
  if (Object.keys(expected.assetDigests).sort().some((name, index) => name !== expectedAssetNames[index])) {
    throw new Error("Expected release asset digests do not match the stable contract");
  }
}

async function githubJson(url: string, token: string, allowNotFound = false): Promise<unknown | null> {
  const response = await readProvider(() => fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  }));
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) throw new Error("GitHub release lookup failed with status " + response.status);
  return response.json();
}

export async function findReleaseByTag(base: string, tag: string, token: string): Promise<unknown> {
  const releases = await githubJson(base + "?per_page=100", token);
  if (!Array.isArray(releases)) throw new Error("GitHub release list is invalid");
  const listed = releases.find(value => record(value, "GitHub release").tag_name === tag);
  if (listed !== undefined) return listed;
  // A newly published release can be absent from the list while its tag endpoint is visible.
  const release = await githubJson(base + "/tags/" + encodeURIComponent(tag), token, true);
  if (release === null) throw new Error("GitHub release tag was not found");
  return release;
}

if (import.meta.main) {
  const [repository, tag, draft, prerelease, latest, assetRoot] = Bun.argv.slice(2);
  const token = process.env.GH_TOKEN;
  if (
    repository === undefined ||
    tag === undefined ||
    !["true", "false"].includes(draft ?? "") ||
    !["true", "false"].includes(prerelease ?? "") ||
    !["true", "false"].includes(latest ?? "") ||
    assetRoot === undefined ||
    token === undefined
  ) {
    console.error(
      "usage: GH_TOKEN=... bun scripts/release-state.ts <owner/repo> <tag> <draft> <prerelease> <latest> <asset-root>",
    );
    process.exit(2);
  }
  try {
    const base = "https://api.github.com/repos/" + repository + "/releases";
    const release = await findReleaseByTag(base, tag, token);
    const latestRelease = await githubJson(base + "/latest", token, true);
    const latestTag = latestRelease === null ? null : record(latestRelease, "GitHub latest release").tag_name;
    assertReleaseState(release, typeof latestTag === "string" ? latestTag : null, {
      tag,
      draft: draft === "true",
      prerelease: prerelease === "true",
      latest: latest === "true",
      assetDigests: await releaseAssetDigests(assetRoot, tag),
    });
    console.log("verified release state for " + tag);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
