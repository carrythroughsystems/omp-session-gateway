import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nerdSymbols from "../apps/web/src/fonts/nerd-symbols/manifest.json";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webSource = join(root, "apps", "web", "src");
const clientSource = join(root, "packages", "collab-client");
const outputRoot = join(root, "apps", "web", "dist");
const assetRoot = join(outputRoot, "assets");
const temporaryRoot = join(outputRoot, ".build");

function digest(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

async function buildEntrypoint(entrypoint: string, outdir: string, define: Record<string, string> = {}): Promise<string[]> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
    define: { "process.env.NODE_ENV": '"production"', ...define },
    naming: "[name].[ext]",
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `failed to build ${entrypoint}`);
  }
  return result.outputs.map(output => output.path);
}

async function moveHashedAsset(sourcePath: string, prefix: string): Promise<string> {
  const content = await readFile(sourcePath);
  const extension = extname(sourcePath);
  const filename = `${prefix}.${digest(content)}${extension}`;
  await rename(sourcePath, join(assetRoot, filename));
  return `/assets/${filename}`;
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(assetRoot, { recursive: true });
await mkdir(temporaryRoot, { recursive: true });

const collabBuild = await buildEntrypoint(
  join(clientSource, "upstream", "src", "embed.ts"),
  join(temporaryRoot, "collab"),
);
let clientModule: string | undefined;
let clientStylesheet: string | undefined;
for (const output of collabBuild) {
  if (extname(output) === ".js") clientModule = await moveHashedAsset(output, "collab-client");
  if (extname(output) === ".css") clientStylesheet = await moveHashedAsset(output, "collab-client");
}
if (clientModule === undefined || clientStylesheet === undefined) {
  throw new Error("collab client build did not emit JavaScript and CSS");
}
// React's development build is larger and markedly slower on a phone, and a bundle gets it
// whenever `process.env.NODE_ENV` is not defined as production. This warning exists only there.
const clientJavaScript = await readFile(join(outputRoot, clientModule.slice(1)), "utf8");
if (clientJavaScript.includes("Each child in a list should have a unique")) {
  throw new Error("collab client bundled React's development build");
}
// Repository policy forbids shipping OMP artwork.
if (clientJavaScript.includes("M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z")) {
  throw new Error("collab client bundled OMP artwork");
}


const webBuild = await buildEntrypoint(join(webSource, "app.ts"), join(temporaryRoot, "web"), {
  __COLLAB_CLIENT_MODULE__: JSON.stringify(clientModule),
  __COLLAB_CLIENT_STYLESHEET__: JSON.stringify(clientStylesheet),
});
const webScriptSource = webBuild.find(path => extname(path) === ".js");
if (webScriptSource === undefined) throw new Error("web build did not emit JavaScript");
const webScript = await moveHashedAsset(webScriptSource, "app");
const lazyAssets: string[] = [];
const fontFaces: string[] = [];
for (const chunk of nerdSymbols.chunks) {
  const content = await readFile(join(webSource, "fonts", "nerd-symbols", chunk.file));
  const filename = `nerd-symbols-${basename(chunk.file, ".woff2")}.${digest(content)}.woff2`;
  const url = `/assets/${filename}`;
  await writeFile(join(assetRoot, filename), content);
  lazyAssets.push(url);
  fontFaces.push(`@font-face {
  font-family: "${nerdSymbols.family}";
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url("${url}") format("woff2");
  unicode-range: ${chunk.unicodeRange};
}`);
}
const stylesheetSource = `${await readFile(join(webSource, "styles.css"), "utf8")}
/* Generated: Nerd Font symbol subset (see apps/web/src/fonts/nerd-symbols/manifest.json) */
${fontFaces.join("\n\n")}
`;
const stylesheet = `/assets/app.${digest(stylesheetSource)}.css`;
await writeFile(join(outputRoot, stylesheet.slice(1)), stylesheetSource);

const buildTag = digest([webScript, stylesheet, clientModule, clientStylesheet].join("\0"));
const indexTemplate = await readFile(join(webSource, "index.html"), "utf8");
const indexHtml = indexTemplate
  .replace("<!--ASSET_STYLES-->", `<link rel="stylesheet" href="${stylesheet}" />`)
  .replace(
    "<!--ASSET_PRELOADS-->",
    // Warm the pinned collab client on first visit; repeat visits hit the service-worker cache.
    `<link rel="modulepreload" href="${clientModule}" />\n    <link rel="preload" as="style" href="${clientStylesheet}" />`,
  )
  .replace("<!--ASSET_BUILD-->", buildTag)
  .replace("<!--ASSET_SCRIPT-->", `<script type="module" src="${webScript}"></script>`);
await writeFile(join(outputRoot, "index.html"), indexHtml);



await copyFile(join(webSource, "manifest.webmanifest"), join(outputRoot, "manifest.webmanifest"));
await copyFile(join(webSource, "icon.svg"), join(outputRoot, "icon.svg"));
for (const asset of [
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "apple-touch-icon-180.png",
]) {
  await copyFile(join(webSource, asset), join(outputRoot, asset));
}
// The collab client is part of the launch-critical shell: precaching it makes View/Control
// taps independent of tailnet round-trips for static bytes. All entries stay content-hashed.
const shellAssets = [webScript, stylesheet, clientModule, clientStylesheet];
const cacheName = `omp-sessions-shell-${digest(shellAssets.join("\0"))}`;
const workerBuild = await buildEntrypoint(join(webSource, "service-worker.ts"), join(temporaryRoot, "worker"), {
  __SHELL_ASSETS__: JSON.stringify(shellAssets),
  __LAZY_ASSETS__: JSON.stringify(lazyAssets),
  __CACHE_NAME__: JSON.stringify(cacheName),
});
const workerSource = workerBuild.find(path => basename(path) === "service-worker.js");
if (workerSource === undefined) throw new Error("service worker build did not emit JavaScript");
await rename(workerSource, join(outputRoot, "service-worker.js"));

await rm(temporaryRoot, { recursive: true, force: true });
console.log(`built PWA and pinned collab client (${webScript}, ${clientModule})`);
