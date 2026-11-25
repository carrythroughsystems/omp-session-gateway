import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

type ContentCoding = "br" | "gzip";

interface Representation {
  readonly body: Blob;
  readonly etag: string | undefined;
}

interface EncodedRepresentation extends Representation {
  readonly coding: ContentCoding;
}

interface StaticAsset {
  readonly contentType: string;
  readonly immutable: boolean;
  readonly compressible: boolean;
  readonly identity: Representation;
  readonly br: EncodedRepresentation | undefined;
  readonly gzip: EncodedRepresentation | undefined;
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
};

const COMPRESSIBLE_EXTENSIONS = new Set([".js", ".css", ".html", ".svg", ".json", ".webmanifest"]);
const MAX_ENCODING_TOKENS = 64;
const MAX_IF_NONE_MATCH_LENGTH = 4_096;
const ENCODING_TOKEN = /^(br|gzip|identity|\*)[ \t]*(?:;[ \t]*q=(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?))?$/iu;
const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

async function compressedRepresentation(
  bytes: Uint8Array,
  coding: ContentCoding,
  digest: string | undefined,
): Promise<EncodedRepresentation | undefined> {
  const compressed = await (coding === "br"
    ? compressBrotli(bytes, { params: {
      [constants.BROTLI_PARAM_QUALITY]: 9,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
    } })
    : compressGzip(bytes, { level: 9 })).catch(() => undefined);
  if (compressed === undefined || compressed.byteLength >= bytes.byteLength) return undefined;
  // A Blob owns the bytes once and can supply an independent body for every response.
  return {
    coding,
    body: new Blob([compressed]),
    etag: digest === undefined ? undefined : `"${digest}-${coding === "br" ? "br" : "gz"}"`,
  };
}

function preferredEncoding(value: string | null, asset: StaticAsset): EncodedRepresentation | undefined {
  if (value === null || (asset.br === undefined && asset.gzip === undefined)) return undefined;
  const tokens = value.split(",", MAX_ENCODING_TOKENS + 1);
  // A longer list could hide a refusal past the bound, so it gets identity.
  if (tokens.length > MAX_ENCODING_TOKENS) return undefined;
  let br: number | undefined, gzip: number | undefined, identity: number | undefined, wildcard: number | undefined;
  for (const token of tokens) {
    const match = ENCODING_TOKEN.exec(token.trim());
    if (match === null) continue;
    const weight = match[2] === undefined ? 1 : Number(match[2]);
    switch (match[1]!.toLowerCase()) {
      case "br": br ??= weight; break;
      case "gzip": gzip ??= weight; break;
      case "identity": identity ??= weight; break;
      case "*": wildcard ??= weight; break;
    }
  }
  const brWeight = asset.br === undefined ? 0 : br ?? wildcard ?? 0;
  const gzipWeight = asset.gzip === undefined ? 0 : gzip ?? wildcard ?? 0;
  // Identity is the fallback even if excluded; only an explicit positive weight competes with codings.
  const identityWeight = identity ?? 0;
  if (brWeight > 0 && brWeight >= gzipWeight && brWeight >= identityWeight) return asset.br;
  return gzipWeight > 0 && gzipWeight >= identityWeight ? asset.gzip : undefined;
}

/** Weak comparison with the selected representation's tag; another coding's tag names other bytes. */
function matchesEtag(value: string | null, etag: string): boolean {
  if (value === null || value.length > MAX_IF_NONE_MATCH_LENGTH) return false;
  if (value.trim() === "*") return true;
  for (const item of value.split(",")) {
    const tag = item.trim();
    if ((tag.startsWith("W/") ? tag.slice(2) : tag) === etag) return true;
  }
  return false;
}

export class StaticAssetStore {
  readonly #root: string;
  readonly #assets = new Map<string, StaticAsset>();
  readonly #documentRevalidations = new WeakSet<Response>();

  private constructor(root: string) {
    this.#root = root;
  }

  static async load(root: string): Promise<StaticAssetStore> {
    const resolvedRoot = await realpath(root);
    const rootInfo = await stat(resolvedRoot);
    if (!rootInfo.isDirectory()) throw new Error("static asset root is not a directory");
    const store = new StaticAssetStore(resolvedRoot);
    await store.#walk(resolvedRoot);
    if (!store.#assets.has("/index.html")) throw new Error("static asset root is missing index.html");
    return store;
  }

  /** Without request headers, serve the legacy identity response without a validator. */
  response(pathname: string, requestHeaders?: Headers): Response | undefined {
    const requestedPath = pathname === "/" ? "/index.html" : pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const asset = this.#assets.get(requestedPath);
    if (asset === undefined) return undefined;
    const headers: Record<string, string> = {
      "Cache-Control": asset.immutable ? "public, max-age=31536000, immutable" : "no-cache",
    };
    let encoded: EncodedRepresentation | undefined;
    if (requestHeaders !== undefined) {
      if (asset.compressible) {
        headers["Vary"] = "Accept-Encoding";
        if (!requestHeaders.has("Range")) encoded = preferredEncoding(requestHeaders.get("Accept-Encoding"), asset);
      }
      const etag = (encoded ?? asset.identity).etag;
      if (etag !== undefined) {
        headers["ETag"] = etag;
        if (matchesEtag(requestHeaders.get("If-None-Match"), etag)) {
          const response = new Response(null, { status: 304, headers });
          if (asset.contentType.startsWith("text/html")) this.#documentRevalidations.add(response);
          return response;
        }
      }
    }
    headers["Content-Type"] = asset.contentType;
    if (encoded !== undefined) {
      headers["Content-Encoding"] = encoded.coding;
      headers["Content-Length"] = String(encoded.body.size);
    }
    return new Response((encoded ?? asset.identity).body, { headers });
  }

  isDocumentRevalidation(response: Response): boolean {
    return this.#documentRevalidations.has(response);
  }

  async #walk(directory: string): Promise<void> {
    await Promise.all((await readdir(directory, { withFileTypes: true })).map(async entry => {
      const fullPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("static assets may not contain symlinks");
      if (entry.isDirectory()) return this.#walk(fullPath);
      if (!entry.isFile()) return;
      const relativePath = relative(this.#root, fullPath);
      if (relativePath.startsWith(`..${sep}`) || relativePath === "..") throw new Error("static path escaped root");
      const urlPath = `/${relativePath.split(sep).join("/")}`;
      const extension = extname(entry.name).toLowerCase();
      const immutable = /^\/assets\/[a-z0-9-]+\.[a-f0-9]{12}\.[a-z0-9]+$/u.test(urlPath);
      const compressible = COMPRESSIBLE_EXTENSIONS.has(extension);
      const file = Bun.file(fullPath);
      const bytes = compressible || !immutable ? await file.bytes() : undefined;
      const digest = !immutable && bytes !== undefined ? createHash("sha256").update(bytes).digest("hex") : undefined;
      const [br, gzip] = compressible && bytes !== undefined
        ? await Promise.all([compressedRepresentation(bytes, "br", digest), compressedRepresentation(bytes, "gzip", digest)])
        : [];
      this.#assets.set(urlPath, {
        contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
        immutable,
        compressible,
        identity: {
          body: bytes === undefined || extension === ".woff2" ? file : new Blob([bytes]),
          etag: digest === undefined ? undefined : `"${digest}"`,
        },
        br,
        gzip,
      });
    }));
  }
}
