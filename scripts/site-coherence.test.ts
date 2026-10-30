import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArtworkManifest } from "./media/render-brand-assets.ts";

const rootPath = fileURLToPath(new URL("../", import.meta.url));
const sitePath = join(rootPath, "site");
const siteOrigin = "https://carrythroughsystems.github.io/omp-session-gateway/";

/**
 * Assets the Pages workflow copies into `site/` at deploy time so the site never carries a
 * second copy of a brand or media file. Keys are site-relative names, values their canonical
 * sources; `.github/workflows/pages.yml` and the `site/` block in `.gitignore` list the same set.
 */
const STAGED_SITE_ASSETS: Record<string, string> = {
  "logo.svg": "assets/logo.svg",
  "favicon.svg": "apps/web/src/favicon.svg",
  "og.png": "assets/og.png",
  "screen-all-clear.png": "docs/media/01-all-clear.png",
  "screen-needs-you.png": "docs/media/02-needs-you.png",
  "screen-open-request.png": "docs/media/03-open-request.png",
};

async function sitePages(): Promise<Array<{ path: string; url: string }>> {
  const out: Array<{ path: string; url: string }> = [];
  for (const entry of await readdir(sitePath, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.name !== "index.html") continue;
    const dir = relative(sitePath, entry.parentPath);
    out.push({ path: join(entry.parentPath, entry.name), url: dir === "" ? siteOrigin : `${siteOrigin}${dir}/` });
  }
  return out.sort((a, b) => a.url.localeCompare(b.url));
}

async function section(file: string, heading: string): Promise<string> {
  const text = (await readFile(join(rootPath, file), "utf8")).split(`\n${heading}\n`)[1]?.split("\n## ")[0];
  if (text === undefined) throw new Error(`${file} lost its "${heading}" section`);
  return text;
}

/** README, docs other than dated records, and every site page: the surfaces making current claims. */
async function claimSurfaces(datedRecords: Record<string, true>): Promise<string[]> {
  return [
    "README.md",
    ...(await readdir(join(rootPath, "docs"))).filter(name => name.endsWith(".md") && !datedRecords[name]).map(name => `docs/${name}`),
    ...(await readdir(sitePath, { recursive: true })).filter(name => /\.(html|txt)$/u.test(name)).map(name => `site/${name}`),
  ];
}

// Promotion flipped some download links while install commands and other links kept naming older
// archives through several stable releases. Install and download surfaces therefore name no
// release: links resolve GitHub Latest, and commands derive the version from the download.
test("install and download surfaces link to the latest release and pin no version", async () => {
  const latest = "https://github.com/carrythroughsystems/omp-session-gateway/releases/latest";
  const gettingStarted = await section("README.md", "## Build and run");
  const firstRelease = gettingStarted.match(/\]\((https:\/\/github\.com\/carrythroughsystems\/omp-session-gateway\/releases\/[^)]+)\)/u)?.[1];
  expect(firstRelease, "the installation guide must start with the latest stable release").toBe(latest);

  const downloads: string[] = [];
  const html = await readFile(join(sitePath, "index.html"), "utf8");
  await new HTMLRewriter().on("a.cta", {
    element(element) {
      const href = element.getAttribute("href");
      if (href?.includes("/releases/")) downloads.push(href);
    },
  }).transform(new Response(html)).text();
  expect(downloads).toEqual([latest]);

  const pinned = (text: string) => text.match(/omp-session-gateway-\d+\.\d+\.\d+|releases\/tag\/v\d+\.\d+\.\d+/gu) ?? [];
  expect(pinned(gettingStarted)).toEqual([]);
  expect(pinned(await section("docs/OPERATIONS.md", "## 2. CLI and daemon installation"))).toEqual([]);
  const verification = await section("docs/RELEASE.md", "## Verify a published build");
  expect(pinned(verification)).toEqual([]);
  expect(verification).toMatch(/^TAG="\$\(gh release view --repo "\$REPO" --json tagName --jq \.tagName\)"$/mu);
});

// Rollback guidance kept an older predecessor pair through a later stable release.
test("rollback guidance names the locked release and its predecessor", async () => {
  const stable = JSON.parse(await readFile(join(rootPath, "STABLE_RELEASE.lock.json"), "utf8")) as {
    releaseTag: string;
    previousTag: string;
  };
  const rollback = await readFile(join(rootPath, "docs/UPGRADE_ROLLBACK.md"), "utf8");
  expect(rollback).toContain(`\n## ${stable.releaseTag} predecessor compatibility\n`);
  expect(rollback).toContain(`The selected predecessor is published ${stable.previousTag}.`);
});

// Work shipped in v0.5.0 kept its "unreleased" labels in README, ANDROID.md and TEST_PLAN.md, and
// v0.6.2's campaign qualified the cloud-device lane while four docs still promised it "from the next
// stable release". Dated records (the ledger and ADRs) keep their wording.
test("docs call work unreleased only while the changelog has unreleased entries", async () => {
  const changelog = await readFile(join(rootPath, "CHANGELOG.md"), "utf8");
  const pending = changelog.split("\n## [Unreleased]\n")[1]?.split("\n## [")[0]?.trim();
  if (pending === undefined) throw new Error("CHANGELOG.md lost its [Unreleased] section");
  if (pending !== "") return;
  const files = await claimSurfaces({ "DECISIONS.md": true, "RELEASE_STATUS.md": true });
  const stale: string[] = [];
  for (const file of files) {
    const text = await readFile(join(rootPath, file), "utf8");
    for (const match of text.matchAll(/\bunreleased(?!\s+development\s+targets)\b|\bnext\s+stable\s+(?:release|campaign)\b/giu)) {
      stale.push(`${file}:${text.slice(0, match.index).split("\n").length}`);
    }
  }
  expect(stale).toEqual([]);
});

// v0.6.0 qualified Windows and background Web Push, yet the home page, README, operations guide,
// release runbook and upstream strategy still called them unqualified or outside the claim. While
// the stable lock holds a platform's evidence, current claims give its qualified scope; a sentence
// that begins "Other" limits the rest. Dated records, the launch draft prepared for a named release,
// and fork-era history keep their wording.
test("docs call a platform unqualified only while the stable lock lacks its evidence", async () => {
  const stable = JSON.parse(await readFile(join(rootPath, "STABLE_RELEASE.lock.json"), "utf8")) as {
    evidence: Record<string, string>;
  };
  const platforms: Record<string, RegExp> = {
    windows: /\bWindows\b/u,
    androidPush: /\bbackground (?:Web )?Push\b/iu,
    deviceCloud: /\biPhone\b|\biPad\b/u,
  };
  const unqualified = /\bnot (?:yet )?(?:release-|stable-)?qualified\b|\bunqualified\b|\bunadvertised\b|\bqualification pending\b|\boutside (?:the|this|that|every)\b[^.;]*\bclaim\b|\bNone yet\b|\b(?:not on|rather than on|no) (?:a )?physical (?:Apple )?device\b/iu;
  const history = /\n## (?:Fork-era published-release history|Host and client matrix|Fork-era release history)\n[\s\S]*?(?=\n## |$)|<h2>Fork-era release history<\/h2>[\s\S]*/gu;
  const stale: string[] = [];
  for (const file of await claimSurfaces({ "DECISIONS.md": true, "RELEASE_STATUS.md": true, "LAUNCH_COPY.md": true })) {
    const blocks = (await readFile(join(rootPath, file), "utf8")).replace(history, "\n").split(/\n\s*\n|\n\s*(?:[-*]|\d+\.)\s|<\/?(?:p|li|td|h[1-6])\b[^>]*>/u);
    for (const block of blocks) {
      for (const sentence of block.replace(/<[^>]+>|\*\*/gu, "").replace(/\s+/gu, " ").split(/[.!?](?:\s|$)/u)) {
        if (/^\s*Other\b/u.test(sentence) || !unqualified.test(sentence)) continue;
        for (const [key, subject] of Object.entries(platforms)) {
          if (stable.evidence[key] === "passed" && subject.test(sentence)) stale.push(`${file} (${key}): ${sentence.trim()}`);
        }
      }
    }
  }
  expect(stale).toEqual([]);
});

// The machine-readable summary stayed on v0.4.0 through three later stable releases. Promotion
// commits the lock before the signed workflow publishes, so the summary states either phase.
test("the machine-readable site summary names only the qualified stable release", async () => {
  const stable = JSON.parse(await readFile(join(rootPath, "STABLE_RELEASE.lock.json"), "utf8")) as {
    releaseTag: string;
  };
  const summary = (await readFile(join(sitePath, "llms.txt"), "utf8")).split("\n## ")[0] ?? "";
  const phases = [
    `Stable ${stable.releaseTag} is published as immutable`,
    `${stable.releaseTag} is qualified for stable promotion; publication is pending`,
  ];
  expect(phases.filter(phase => summary.includes(phase))).toHaveLength(1);
  expect([...new Set(summary.match(/\bv\d+\.\d+\.\d+\b/gu))]).toEqual([stable.releaseTag]);
});

// The status page's campaign note kept v0.5.1's attempt history through the v0.5.2 promotion while
// the candidate row beside it moved on. Current-release claims name only the locked release and
// candidate.
test("current release claims name only the locked release and candidate", async () => {
  const stable = JSON.parse(await readFile(join(rootPath, "STABLE_RELEASE.lock.json"), "utf8")) as {
    releaseTag: string;
    candidateTag: string;
  };
  const candidates = (text: string) => [...new Set(text.match(/\bv\d+\.\d+\.\d+-prealpha\.\d+\b/gu))];
  const current = [stable.candidateTag];
  const status = (await readFile(join(sitePath, "status", "index.html"), "utf8")).split("<h2>Fork-era release history</h2>")[0] ?? "";
  const note = status.match(/<p class="verified">([\s\S]*?)<\/p>/u)?.[1];
  if (note === undefined) throw new Error("site/status/index.html lost its campaign note");
  expect(candidates(note)).toEqual(current);
  expect(candidates(status)).toEqual(current);
  const boundary = (await readFile(join(sitePath, "llms.txt"), "utf8")).split("\n## Current qualification boundary\n")[1]?.split("\n## ")[0];
  if (boundary === undefined) throw new Error("site/llms.txt lost its qualification boundary");
  expect(candidates(boundary)).toEqual(current);
  const claim = await section("docs/COMPATIBILITY.md", "## Current claim");
  expect(candidates(claim)).toEqual(current);
  expect(claim).toContain(`releases/tag/${stable.releaseTag})`);
});

test("every relative asset a site page references exists after staging", async () => {
  for (const [name, source] of Object.entries(STAGED_SITE_ASSETS)) {
    expect(await Bun.file(join(rootPath, source)).exists(), `${source} is the canonical source of site/${name}`).toBe(true);
  }
  for (const page of await sitePages()) {
    const html = await readFile(page.path, "utf8");
    for (const match of html.matchAll(/\b(?:src|href)="([^"#]+)"/g)) {
      const target = match[1] ?? "";
      if (/^(?:https?:)?\/\//.test(target) || target === "") continue;
      const resolved = join(dirname(page.path), target);
      const committed = await Bun.file(target.endsWith("/") ? join(resolved, "index.html") : resolved).exists();
      const staged = Object.hasOwn(STAGED_SITE_ASSETS, relative(sitePath, resolved));
      expect(committed || staged, `${relative(rootPath, page.path)} references missing ${target}`).toBe(true);
    }
  }
});

test("sitemap and canonical links name exactly the site pages under the canonical origin", async () => {
  const pages = await sitePages();
  const sitemap = await readFile(join(sitePath, "sitemap.xml"), "utf8");
  const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => loc).sort();
  expect(listed).toEqual(pages.map(page => page.url));
  for (const page of pages) {
    const html = await readFile(page.path, "utf8");
    const canonical: string[] = [];
    await new HTMLRewriter().on('link[rel~="canonical"]', {
      element(element) {
        canonical.push(element.getAttribute("href") ?? "");
      },
    }).transform(new Response(html)).text();
    expect(canonical, `${relative(rootPath, page.path)} canonical URL`).toEqual([page.url]);
  }
});

// The social preview rendered in July still named `github.com/alphastorm/…` three weeks after the
// repository moved, and the banner kept a "zero-touch" tagline the voice rule forbids, because the
// PNGs had no committed source to drift from. `bun run media:brand` now renders both from
// `assets/*.html` and records source and output digests; every committed PNG matches its source,
// and the social card names the canonical repository and carries the README's promise.
test("rendered artwork matches its committed source and the README promise", async () => {
  const sha256 = async (file: string) => createHash("sha256").update(await readFile(join(rootPath, file))).digest("hex");
  const manifest = JSON.parse(await readFile(join(rootPath, "assets/artwork.json"), "utf8")) as ArtworkManifest;
  expect(Object.keys(manifest.artwork).sort()).toEqual(["assets/banner.png", "assets/og.png"]);
  for (const [output, record] of Object.entries(manifest.artwork)) {
    expect(await sha256(record.source), `${record.source} changed without \`bun run media:brand\``).toBe(record.sourceSha256);
    expect(await sha256(output), `${output} differs from the recorded render`).toBe(record.outputSha256);
  }
  expect(manifest.artwork[STAGED_SITE_ASSETS["og.png"] ?? ""]).toMatchObject({ width: 1280, height: 640 });

  const readme = await readFile(join(rootPath, "README.md"), "utf8");
  const promise = readme.match(/^# OMP Session Gateway\n\n\*\*(.+)\*\*$/mu)?.[1];
  if (promise === undefined) throw new Error("README.md lost its one-line promise under the H1");
  const text = (html: string) => html.replace(/<br>/gu, " ").replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ");
  const og = text(await readFile(join(rootPath, "assets/og.html"), "utf8"));
  expect(og).toContain("github.com/carrythroughsystems/omp-session-gateway");
  expect(og).toContain(promise);
  expect(og).not.toMatch(/alphastorm/u);
  expect(text(await readFile(join(rootPath, "assets/banner.html"), "utf8"))).not.toMatch(/zero-touch|no setup/iu);
});
