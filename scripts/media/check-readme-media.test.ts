import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkReadmeMedia, type MediaCheckContext, type MediaCheckResult } from "./check-readme-media.ts";
import {
  DEMO_FRAME_COUNT,
  MEDIA_DIRECTORY_NAMES,
  REPOSITORY_ROOT,
  sha256Bytes,
  type BinaryMediaName,
  type MediaAssetManifestRecord,
  type MediaManifest,
  type ProbeResult,
} from "./readme-media-contract.ts";

const PNG = "04-notification-settings.png";
const GIF = "omp-session-gateway-demo.gif";
const MP4 = "omp-session-gateway-demo.mp4";
const MANIFEST = "docs/media/manifest.json";
const FIXTURE_FILES = [
  ...MEDIA_DIRECTORY_NAMES.map(name => `docs/media/${name}`),
  "README.md",
  "package.json",
  "UPSTREAM.lock.json",
  "packages/collab-client/upstream/UPSTREAM.json",
  "assets/logo.svg",
  "apps/web/src/fonts/geist/geist-latin.woff2",
  "scripts/media/readme-media-contract.ts",
  "scripts/media/readme-media-compositor.ts",
  "scripts/media/capture-readme-media.ts",
];

function validProbe(): ProbeResult {
  return {
    streams: [{
      codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 960, height: 540,
      nb_read_frames: "130", duration: "13", avg_frame_rate: "10/1",
    }],
    format: { duration: "13", tags: { major_brand: "isom" } },
  };
}

function decodedFrames(): string {
  return "# ffmpeg frame checksums\n" + Array.from({ length: DEMO_FRAME_COUNT }, (_, index) =>
    `0, ${index}, ${index}, 1, 518400, ${"a".repeat(32)}`
  ).join("\n") + "\n";
}

interface Fixture {
  readonly root: string;
  readonly context: MediaCheckContext;
  manifest: MediaManifest;
  path(relativePath: string): string;
  json(relativePath: string, value: unknown): Promise<void>;
  saveManifest(value?: unknown): Promise<void>;
  asset(name: BinaryMediaName, bytes: Buffer): Promise<void>;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "readme-media-gate-"));
  try {
    await Promise.all(FIXTURE_FILES.map(async path => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await copyFile(join(REPOSITORY_ROOT, path), join(root, path));
    }));
    const captured: MediaManifest = JSON.parse(await readFile(join(root, MANIFEST), "utf8"));
    // Pin the isolated fixture to its executing Bun without changing the repository or runtime.
    const manifest: MediaManifest = { ...captured, generatedBy: { ...captured.generatedBy, bun: Bun.version } };
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    await writeFile(join(root, "package.json"), JSON.stringify({ ...packageJson, packageManager: "bun@" + Bun.version }));
    await writeFile(join(root, MANIFEST), JSON.stringify(manifest));
    const fixture: Fixture = {
      root,
      manifest,
      path: path => join(root, path),
      json: async (path, value) => { await writeFile(join(root, path), JSON.stringify(value)); },
      saveManifest: async (value = fixture.manifest) => { await fixture.json(MANIFEST, value); },
      asset: async (name, bytes) => {
        await writeFile(join(root, "docs/media", name), bytes);
        replaceAsset(fixture, name, { bytes: bytes.length, sha256: sha256Bytes(bytes) });
        await fixture.saveManifest();
      },
      context: {
        repositoryRoot: root,
        runProcess: async (command, args) => {
          const invocation = JSON.stringify([command, ...args]);
          if (invocation === JSON.stringify(["ffmpeg", "-version"])) return `ffmpeg version ${manifest.generatedBy.ffmpeg}\n`;
          if (invocation === JSON.stringify(["ffprobe", "-version"])) return `ffprobe version ${manifest.generatedBy.ffprobe}\n`;
          if (invocation === JSON.stringify(["git", "-C", root, "cat-file", "-e", `${manifest.sourceRevision}^{commit}`])) return "";
          if (invocation === JSON.stringify(["ffmpeg", "-v", "error", "-i", join(root, "docs/media", GIF), "-map", "0:v:0", "-f", "framemd5", "-"])) return decodedFrames();
          throw new Error(`Unexpected media command: ${invocation}`);
        },
        probeMedia: async path => {
          if (path !== join(root, "docs/media", MP4)) throw new Error(`Unexpected probe path: ${path}`);
          return validProbe();
        },
      },
    };
    await run(fixture);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function replaceAsset(fixture: Fixture, name: BinaryMediaName, changes: Partial<MediaAssetManifestRecord>): void {
  fixture.manifest = {
    ...fixture.manifest,
    assets: { ...fixture.manifest.assets, [name]: { ...fixture.manifest.assets[name], ...changes } },
  };
}

function rejection(result: MediaCheckResult, path: string, category: RegExp): void {
  expect(result.failures.filter(failure =>
    failure.replaceAll("\\", "/").startsWith(path + ":") && category.test(failure)
  )).not.toEqual([]);
}

// Keep the binary containers valid so a parser/digest failure cannot stand in for the tested guard.
function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(Bun.hash.crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

test("the current canonical package passes all media checks", async () => {
  await withFixture(async fixture => {
    expect(await checkReadmeMedia(fixture.context)).toEqual({ failures: [], warnings: [] });
  });
});

test("client provenance stays independent of the OMP host pin and rejects a stale client", async () => {
  await withFixture(async fixture => {
    const host = JSON.parse(await readFile(fixture.path("UPSTREAM.lock.json"), "utf8"));
    await fixture.json("UPSTREAM.lock.json", { ...host, tag: "v99.0.0", commit: "9".repeat(40) });
    expect(await checkReadmeMedia(fixture.context)).toEqual({ failures: [], warnings: [] });
    fixture.manifest = {
      ...fixture.manifest,
      upstreamClient: { ...fixture.manifest.upstreamClient, tag: "v99.0.0", commit: "9".repeat(40) },
    };
    await fixture.saveManifest();
    rejection(await checkReadmeMedia(fixture.context), MANIFEST, /collaboration client.*provenance/iu);
  });
});

test("a missing canonical image is rejected", async () => {
  await withFixture(async fixture => {
    await rm(fixture.path("docs/media/" + PNG));
    rejection(await checkReadmeMedia(fixture.context), "docs/media", /missing.*04-notification-settings/iu);
  });
});

test("a missing manifest asset record reports rejection instead of throwing a type error", async () => {
  await withFixture(async fixture => {
    const { ["01-all-clear.png"]: _removed, ...assets } = fixture.manifest.assets;
    await fixture.saveManifest({ ...fixture.manifest, assets });
    rejection(await checkReadmeMedia(fixture.context), MANIFEST, /01-all-clear.*record/iu);
  });
});

test("a truncated manifest is rejected", async () => {
  await withFixture(async fixture => {
    await writeFile(fixture.path(MANIFEST), "{");
    rejection(await checkReadmeMedia(fixture.context), MANIFEST, /JSON/iu);
  });
});

test("changed image bytes cannot reuse an old manifest digest", async () => {
  await withFixture(async fixture => {
    const path = fixture.path("docs/media/" + PNG);
    const bytes = await readFile(path);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(path, bytes);
    rejection(await checkReadmeMedia(fixture.context), "docs/media/" + PNG, /SHA-256/iu);
  });
});

test("a truncated image is rejected even with a matching manifest digest", async () => {
  await withFixture(async fixture => {
    const bytes = await readFile(fixture.path("docs/media/" + PNG));
    await fixture.asset(PNG, bytes.subarray(0, 7));
    rejection(await checkReadmeMedia(fixture.context), "docs/media/" + PNG, /PNG parser/iu);
  });
});

test("PNG text metadata is rejected even with innocuous text and a current digest", async () => {
  await withFixture(async fixture => {
    const bytes = await readFile(fixture.path("docs/media/" + PNG));
    await fixture.asset(PNG, Buffer.concat([
      bytes.subarray(0, -12), pngChunk("tEXt", Buffer.from("Note\0fixture")), bytes.subarray(-12),
    ]));
    rejection(await checkReadmeMedia(fixture.context), "docs/media/" + PNG, /PNG.*tEXt.*metadata/iu);
  });
});

test("GIF comments are rejected even with innocuous text and a current digest", async () => {
  await withFixture(async fixture => {
    const bytes = await readFile(fixture.path("docs/media/" + GIF));
    await fixture.asset(GIF, Buffer.concat([
      bytes.subarray(0, -1), Buffer.from([0x21, 0xfe, 4]), Buffer.from("note"), Buffer.from([0, 0x3b]),
    ]));
    rejection(await checkReadmeMedia(fixture.context), "docs/media/" + GIF, /comment metadata/iu);
  });
});

test("MP4 descriptive metadata is rejected independently of recognizable secrets", async () => {
  await withFixture(async fixture => {
    const result = await checkReadmeMedia({ ...fixture.context, probeMedia: async path => {
      const probe = await fixture.context.probeMedia(path);
      return { ...probe, format: { ...probe.format, tags: { title: "fixture" } } };
    } });
    rejection(result, "docs/media/" + MP4, /title.*metadata/iu);
  });
});

test("private URLs in public capture sources are rejected", async () => {
  await withFixture(async fixture => {
    const path = "scripts/media/readme-media-compositor.ts";
    await writeFile(fixture.path(path), await readFile(fixture.path(path), "utf8") + "\nhttps://" + "media.invalid");
    rejection(await checkReadmeMedia(fixture.context), path, /non-reserved hostname/iu);
  });
});

test("a changed brand source invalidates existing composite provenance", async () => {
  await withFixture(async fixture => {
    const path = fixture.path("assets/logo.svg");
    await writeFile(path, await readFile(path, "utf8") + "\n");
    rejection(await checkReadmeMedia(fixture.context), MANIFEST, /composite input hash/iu);
  });
});
