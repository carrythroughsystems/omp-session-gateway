import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import provenance from "../upstream/UPSTREAM.json";
import manifest from "../package.json";

const root = resolve(import.meta.dir, "../../..");
const upstream = resolve(import.meta.dir, "../upstream");

/** Git blob identity, independent of a local upstream checkout or network access. */
function blobHash(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

describe("embedded client provenance", () => {
  test("matches every pure helper to its recorded upstream blob", async () => {
    expect(provenance.schemaVersion).toBe(1);
    expect(provenance.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(provenance.tree).toMatch(/^[a-f0-9]{40}$/);
    expect(provenance.tag).toBe(`v${manifest.dependencies["@oh-my-pi/pi-wire"]}`);
    expect(provenance.bunVersion).toBe("1.4.4");
    expect(provenance.additionalSources).toHaveLength(7);
    for (const source of provenance.additionalSources) {
      expect(source.commit).toBe(provenance.commit);
      expect(source.packageVersion).toBe(manifest.dependencies["@oh-my-pi/pi-wire"]);
      expect(source.sourcePath).toStartWith("packages/utils/src/");
      expect(source.vendoredPath).toStartWith("src/vendor/pi-utils/");
      expect(blobHash(await readFile(resolve(upstream, source.vendoredPath)))).toBe(source.blob);
    }
  });

  test("gives active and retired patches unique ids, source paths and executable proof cases", async () => {
    const records = [...provenance.localPatches.active, ...provenance.localPatches.retired];
    expect(new Set(records.map(patch => patch.id)).size).toBe(records.length);
    for (const patch of records) {
      expect(patch.id).toMatch(/^[a-z][a-z0-9-]+$/);
      for (const text of [patch.purpose, patch.upstreamStatus, patch.removeWhen]) expect(text.length).toBeGreaterThan(0);
      expect(patch.files.length).toBeGreaterThan(0);
      for (const file of patch.files) expect(await Bun.file(resolve(upstream, file)).exists()).toBeTrue();
      expect(patch.proof.length).toBeGreaterThan(0);
      for (const proof of patch.proof) {
        expect(proof.file).toMatch(/(?:\.test\.ts|\.e2e\.ts)$/);
        expect(proof.case.length).toBeGreaterThan(0);
        expect(await readFile(resolve(root, proof.file), "utf8")).toContain(proof.case);
      }
    }
  });

  test("keeps export, trace, native and artwork entrypoints outside the live bundle", async () => {
    const inputs = new Set<string>();
    const result = await Bun.build({
      entrypoints: [resolve(upstream, "src/embed.ts")],
      target: "browser", format: "esm", minify: true,
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "record-live-inputs", setup(build) {
        build.onLoad({ filter: /.*/ }, args => { inputs.add(args.path.replaceAll("\\", "/")); });
      } }],
    });
    expect(result.success).toBeTrue();
    expect(inputs.size).toBeGreaterThan(10);
    for (const entry of provenance.excludedEntrypoints) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(await Bun.file(resolve(upstream, entry.sourcePath)).exists()).toBe(entry.vendored);
      expect([...inputs].some(path => path.endsWith(`/collab-client/upstream/${entry.sourcePath}`))).toBeFalse();
    }
    expect([...inputs].some(path => /\/(?:omp-stats|pi-natives|pi-utils)\//.test(path) && !path.includes("/vendor/pi-utils/"))).toBeFalse();
    const js = await result.outputs.find(output => output.path.endsWith(".js"))!.text();
    expect(js).not.toContain("M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z");
    expect(js).not.toContain("Each child in a list should have a unique");
    expect(js).not.toContain("omp-trace-view");
    expect(js).not.toContain("omp-tool-view");
  });
});
