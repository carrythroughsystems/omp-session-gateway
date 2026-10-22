import { describe, expect, spyOn, test } from "bun:test";
import { assertReleaseState, findReleaseByTag } from "./release-state.ts";

const TAG = "v0.2.1";
function assets(tag = TAG): { name: string; state: string; digest: string }[] {
  const version = /^(?:provenance-test-)?v([0-9]+[.][0-9]+[.][0-9]+)/u.exec(tag)?.[1];
  if (version === undefined) throw new Error("test tag has no version");
  const names = [
    "SHA256SUMS",
    "SHA256SUMS.sigstore.json",
    `omp-session-gateway-${version}-bun.tar`,
    `omp-session-gateway-${version}-bun.tar.sigstore.json`,
    `omp-session-gateway-${version}.spdx.json`,
    `omp-session-gateway-${version}.spdx.json.sigstore.json`,
  ];
  return names.map((name, index) => ({ name, state: "uploaded", digest: "sha256:" + String(index + 1).repeat(64) }));
}
const release = (overrides: Record<string, unknown> = {}) => ({
  tag_name: TAG,
  draft: true,
  prerelease: false,
  assets: assets(),
  ...overrides,
});

function expectedState(draft: boolean, prerelease: boolean, latest: boolean) {
  const assetDigests = Object.fromEntries(assets().map(asset => [asset.name, asset.digest]));
  return { tag: TAG, draft, prerelease, latest, assetDigests };
}

describe("GitHub release discovery", () => {
  const base = "https://api.github.com/repos/carrythroughsystems/omp-session-gateway/releases";
  const token = "synthetic-github-release-read";
  function responses(list: unknown, tagged: unknown, tagStatus = 200) {
    const calls: string[] = [];
    const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL, options?: RequestInit) => {
      const target = String(url);
      calls.push(target);
      expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer " + token);
      if (target === base + "?per_page=100") return Response.json(list);
      expect(target).toBe(base + "/tags/" + encodeURIComponent(TAG));
      return Response.json(tagged, { status: tagStatus });
    }, { preconnect: () => {} }));
    return { calls, mock };
  }

  test("keeps a listed draft without an extra lookup", async () => {
    const draft = release();
    const { calls, mock } = responses([draft], null, 404);
    try {
      expect(await findReleaseByTag(base, TAG, token)).toEqual(draft);
      expect(calls).toEqual([base + "?per_page=100"]);
    } finally { mock.mockRestore(); }
  });

  test("finds a published release by tag after a list miss", async () => {
    const published = release({ draft: false });
    const { calls, mock } = responses([release({ tag_name: "v0.2.0" })], published);
    try {
      const found = await findReleaseByTag(base, TAG, token);
      expect(found).toEqual(published);
      expect(() => assertReleaseState(found, TAG, expectedState(false, false, true))).not.toThrow();
      expect(calls).toEqual([base + "?per_page=100", base + "/tags/" + TAG]);
    } finally { mock.mockRestore(); }
  });

  test("fails not-found when both the list and tag endpoint miss", async () => {
    const { calls, mock } = responses([], { message: "Not Found" }, 404);
    try {
      await expect(findReleaseByTag(base, TAG, token)).rejects.toThrow("GitHub release tag was not found");
      expect(calls).toEqual([base + "?per_page=100", base + "/tags/" + TAG]);
    } finally { mock.mockRestore(); }
  });

  test("does not mask an invalid list or a tag lookup permission failure", async () => {
    for (const [list, status, error, count] of [
      [{ message: "unexpected list shape" }, 200, "GitHub release list is invalid", 1],
      [[], 403, "GitHub release lookup failed with status 403", 2],
    ] as const) {
      const { calls, mock } = responses(list, release({ draft: false }), status);
      try {
        await expect(findReleaseByTag(base, TAG, token)).rejects.toThrow(error);
        expect(calls).toHaveLength(count);
      } finally { mock.mockRestore(); }
    }
  });

  test("tag fallback retains identity, policy, and signed-asset validation", async () => {
    for (const changed of [
      release({ tag_name: "v0.2.0", draft: false }),
      release({ draft: false, prerelease: true }),
      release({ draft: false, assets: assets().slice(1) }),
      release({ draft: false, assets: assets().map(asset => ({ ...asset, digest: "sha256:" + "f".repeat(64) })) }),
    ]) {
      const { mock } = responses([], changed);
      try {
        const found = await findReleaseByTag(base, TAG, token);
        expect(() => assertReleaseState(found, TAG, expectedState(false, false, true))).toThrow();
      } finally { mock.mockRestore(); }
    }
  });
});

describe("GitHub release state", () => {
  test("accepts a complete not-Latest stable draft and a published Latest release", () => {
    expect(() => assertReleaseState(release(), null, expectedState(true, false, false))).not.toThrow();
    expect(() => assertReleaseState(release({ draft: false }), TAG, expectedState(false, false, true))).not.toThrow();
  });

  test("derives prerelease asset names from the tag version", () => {
    const tag = "v0.2.1-prealpha.1";
    const candidateAssets = assets(tag);
    const candidate = release({ tag_name: tag, prerelease: true, assets: candidateAssets });
    const assetDigests = Object.fromEntries(candidateAssets.map(asset => [asset.name, asset.digest]));
    expect(() =>
      assertReleaseState(candidate, TAG, {
        tag,
        draft: true,
        prerelease: true,
        latest: false,
        assetDigests,
      }),
    ).not.toThrow();
  });

  test("accepts provenance test assets and rejects malformed tag shapes", () => {
    const tag = "provenance-test-v0.3.0.1";
    const provenanceAssets = assets(tag);
    const assetDigests = Object.fromEntries(provenanceAssets.map(asset => [asset.name, asset.digest]));
    expect(() =>
      assertReleaseState(
        release({ tag_name: tag, prerelease: true, assets: provenanceAssets }),
        TAG,
        { tag, draft: true, prerelease: true, latest: false, assetDigests },
      ),
    ).not.toThrow();

    for (const malformedTag of ["v0.3.0-rc.1", "v0.3.0-alpha.0", "provenance-test-v0.3.0"]) {
      const malformedAssets = assets(malformedTag);
      expect(() =>
        assertReleaseState(
          release({ tag_name: malformedTag, prerelease: true, assets: malformedAssets }),
          TAG,
          {
            tag: malformedTag,
            draft: true,
            prerelease: true,
            latest: false,
            assetDigests: Object.fromEntries(malformedAssets.map(asset => [asset.name, asset.digest])),
          },
        ),
      ).toThrow("tag must be");
    }
  });

  test("rejects wrong flags, premature Latest, and missing assets", () => {
    expect(() => assertReleaseState(release(), TAG, expectedState(true, false, false))).toThrow(
      "GitHub release flags do not match the validated policy",
    );
    expect(() =>
      assertReleaseState(release({ prerelease: true }), null, expectedState(true, false, false)),
    ).toThrow("GitHub release flags do not match the validated policy");
    expect(() =>
      assertReleaseState(release({ assets: assets().slice(1) }), null, expectedState(true, false, false)),
    ).toThrow("GitHub release does not contain exactly six assets");
  });

  test("rejects processing assets, unexpected names, and changed bytes", () => {
    const processing = assets();
    processing[0] = { ...processing[0]!, state: "new" };
    expect(() =>
      assertReleaseState(release({ assets: processing }), null, expectedState(true, false, false)),
    ).toThrow("GitHub release contains an incomplete asset");
    const renamed = assets();
    renamed[0] = { ...renamed[0]!, name: "unexpected" };
    expect(() =>
      assertReleaseState(release({ assets: renamed }), null, expectedState(true, false, false)),
    ).toThrow("GitHub release asset digest does not match the signed local file");
    const changed = assets();
    changed[0] = { ...changed[0]!, digest: "sha256:" + "f".repeat(64) };
    expect(() =>
      assertReleaseState(release({ assets: changed }), null, expectedState(true, false, false)),
    ).toThrow("GitHub release asset digest does not match the signed local file");
  });
});
