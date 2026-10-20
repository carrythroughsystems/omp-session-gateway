import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootPath = fileURLToPath(new URL("../", import.meta.url));

const required = [
  "README.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "THIRD_PARTY_NOTICES.md",
  "UPSTREAM.lock.json",
  "docs/ARCHITECTURE.md",
  "docs/COMPATIBILITY.md",
  "docs/DECISIONS.md",
  "docs/OMP_INTEGRATION.md",
  "docs/OPERATIONS.md",
  "docs/PROTOCOL.md",
  "docs/RELEASE.md",
  "docs/RELEASE_STATUS.md",
  "docs/SECURITY.md",
  "docs/TEST_PLAN.md",
  "docs/UPGRADE_ROLLBACK.md",
  "schemas/omp-host-registry.schema.json",
  "schemas/session-list.schema.json",
  "schemas/launch-request.schema.json",
  "schemas/launch-response.schema.json",
  "schemas/sse-event.schema.json",
  "schemas/upstream-lock.schema.json",
] as const;

const forbiddenLegacy = [
  "OMP Mobile Hub",
  "omp-mobile-hub",
  "gitgateway.com",
  "tag:omp-hub",
  "OMP Collab Hub",
  "omp-collab-hub",
  "tag:omp-gateway",
] as const;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "build"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

// Direct fetches in harness code are provider reads unless this exact target was reviewed.
// Gateway/browser probes deliberately observe first-failure behavior; capability POSTs must not retry.
const nonProviderFetches: Readonly<Record<string, readonly string[]>> = {
  "android-acceptance.ts": ['"/api/v1/sessions/" + id + "/launch"', '"/api/v1/sessions"', 'new URL("/api/v1/sessions"'],
  "android-collab-smoke.ts": ['`${options.origin}/api/v1/sessions`'],
  "android-leak-sweep.ts": ['origin + "/api/v1/sessions"'],
  "android-push-runtime.ts": ['`${identity.origin}/api/v1/sessions`', "'/api/v1/sessions'", "'/api/v1/sessions/'+${JSON.stringify(fixture.instanceId)}+'/launch'"],
  "browser-journey.ts": ['"/api/v1/sessions"', '"/api/v1/sessions/" + target.instanceId + "/launch"'],
  "device-cloud-runtime.ts": ['`${origin}/`', '`${origin}/api/v1/sessions`', '`${origin}/api/v1/sessions/${encodeURIComponent(session.instanceId)}/launch`'],
  // Single-shot latency and stream measurements of the isolated loopback gateway; a retry would skew them.
  "gateway-endurance.ts": ['`${base}${path}`', '`${base}/api/v1/events`'],
  // Readiness probe of its own isolated loopback gateway; the loop itself retries until ready.
  "omp-lifecycle-development.ts": ['`${origin}/api/v1/health`'],
  "post-release-smoke.ts": ['`${config.http.publicOrigin}/api/v1/sessions`', '`http://127.0.0.1:${port}/json/list`'],
  "relay-soak.ts": ['`${config.gatewayOrigin}/api/v1/sessions`', '`${config.gatewayOrigin}/api/v1/sessions/${encodeURIComponent(session.instanceId)}/launch`'],
  "stable-qualification.ts": ['`${origin}/api/v1/sessions`', '`${origin}/api/v1/sessions/${encodeURIComponent(instanceId)}/launch`', '`http://127.0.0.1:${port}/api/v1/health`'],
  // Single-shot local Percy session health; upload mode must never silently no-op.
  "test-visual.ts": ['new URL("/percy/healthcheck"', 'new URL("/test/logs"'],
};

function checkProviderReads(rel: string, text: string): string[] {
  if (!/^scripts\/.+\.ts$/u.test(rel) || rel.endsWith(".test.ts")) return [];
  const failures: string[] = [];
  for (const match of text.matchAll(/\b(?:globalThis\.)?fetch\s*\(\s*([^,\n]+)/gu)) {
    const target = match[1]?.trim().replace(/\);$/u, "");
    const before = text.slice(0, match.index);
    if (/readProvider\(\s*\(\)\s*=>\s*$/u.test(before)) continue;
    if (target !== undefined && nonProviderFetches[rel.slice("scripts/".length)]?.includes(target)) continue;
    // These two dispatchers share a closure but replay it ONLY for GET. Match the gate as well
    // as the target, so removing the read retry or retrying writes fails repository admission.
    if (((rel === "scripts/windows-qualification-runtime.ts" && target === "url") ||
      (rel === "scripts/testingbot.ts" && target === '`${HUB}${path}`')) &&
      /const send = \(\) => $/u.test(before) &&
      text.includes('const response = method === "GET" ? await readProvider(send) : await send();')) continue;
    failures.push(rel + ":" + (before.split("\n").length) + ": unreviewed direct fetch; use readProvider for idempotent provider reads or document the exact non-provider target");
  }
  return failures;
}

interface SourceToken {
  value: string;
  line: number;
}

function* sourceTokens(source: string): Generator<SourceToken> {
  let offset = 0;
  let line = 1;
  const advance = (): string => {
    const char = source[offset++] ?? "";
    if (char === "\n" || (char === "\r" && source[offset] !== "\n") || char === "\u2028" || char === "\u2029") line++;
    return char;
  };
  const quoted = (quote: string): void => {
    advance();
    while (offset < source.length) {
      const char = advance();
      if (char === "\\") advance();
      else if (char === quote) break;
    }
  };
  function* code(interpolation = false): Generator<SourceToken> {
    let depth = 0;
    let previous = "";
    let regexAllowed = true;
    const controlParens: boolean[] = [];
    while (offset < source.length) {
      const char = source[offset] ?? "";
      const next = source[offset + 1];
      if (/\s/u.test(char)) {
        advance();
        continue;
      }
      if (char === "/" && next === "/") {
        while (offset < source.length && !/[\r\n\u2028\u2029]/u.test(source[offset] ?? "")) advance();
        continue;
      }
      if (char === "/" && next === "*") {
        advance();
        advance();
        while (offset < source.length && !(source[offset] === "*" && source[offset + 1] === "/")) advance();
        advance();
        advance();
        continue;
      }
      const tokenLine = line;
      let value: string;
      if (char === "'" || char === '"') {
        quoted(char);
        value = "<literal>";
      } else if (char === "\x60") {
        advance();
        yield { value: "<literal>", line: tokenLine };
        while (offset < source.length) {
          const templateChar = advance();
          if (templateChar === "\\") advance();
          else if (templateChar === "\x60") break;
          else if (templateChar === "$" && source[offset] === "{") {
            advance();
            yield { value: "{", line };
            yield* code(true);
          }
        }
        value = "<literal>";
      } else if (char === "/" && regexAllowed) {
        advance();
        let inClass = false;
        while (offset < source.length) {
          const regexChar = advance();
          if (regexChar === "\\") advance();
          else if (regexChar === "[") inClass = true;
          else if (regexChar === "]") inClass = false;
          else if (regexChar === "/" && !inClass) break;
          else if (/[\r\n\u2028\u2029]/u.test(regexChar)) break;
        }
        while (/[a-z]/iu.test(source[offset] ?? "")) advance();
        value = "<literal>";
      } else if (/[$\p{ID_Continue}]/u.test(char)) {
        const start = offset;
        do { advance(); } while (/[$\p{ID_Continue}]/u.test(source[offset] ?? ""));
        value = source.slice(start, offset);
      } else {
        value = advance();
        if (["=>", "?.", "++", "--", "&&", "||", "??"].includes(value + (source[offset] ?? ""))) value += advance();
      }
      yield { value, line: tokenLine };
      if (value === "{") depth++;
      if (value === "}" && depth-- === 0 && interpolation) return;
      if (value === "(") controlParens.push(/^(?:if|while|for|with|switch|catch)$/u.test(previous));
      regexAllowed = value === ")"
        ? controlParens.pop() === true
        : /^(?:[({[,:;=!?&|+*%~^<>-]|=>|&&|\|\||\?\?|return|throw|case|delete|void|typeof|yield|await|in|of|else|do|instanceof|new)$/u.test(value);
      previous = value;
    }
  }
  yield* code();
}

export function checkUnsafeFinally(relativePath: string, source: string): string[] {
  if (!/^(?:scripts\/|apps\/[^/]+\/src\/).+\.ts$/u.test(relativePath) || /\.(?:test|e2e)\.ts$/u.test(relativePath)) return [];
  const violations: string[] = [];
  const braces: boolean[] = [];
  let finallyDepth = 0;
  let previous = "";
  let candidate: SourceToken | undefined;
  // Deliberately lexical: nested function bodies also count; move their control flow outside finally.
  for (const token of sourceTokens(source)) {
    if (candidate !== undefined && token.value !== ":") {
      violations.push(relativePath + ":" + candidate.line + ": unsafe " + candidate.value + " in finally block");
    }
    candidate = undefined;
    if (token.value === "{") {
      const isFinally = previous === "finally";
      braces.push(isFinally);
      if (isFinally) finallyDepth++;
    } else if (token.value === "}") {
      if (braces.pop()) finallyDepth--;
    } else if (finallyDepth > 0 && (token.value === "throw" || token.value === "return") && previous !== "." && previous !== "?.") {
      candidate = token;
    }
    previous = token.value;
  }
  if (candidate !== undefined) violations.push(relativePath + ":" + candidate.line + ": unsafe " + candidate.value + " in finally block");
  return violations;
}

async function main(): Promise<void> {
  const errors: string[] = [];
  for (const rel of required) {
    try {
      await readFile(join(rootPath, rel));
    } catch {
      errors.push(`missing required file: ${rel}`);
    }
  }

  for (const file of await walk(rootPath)) {
    // Rules below name files with forward slashes; Windows `relative` returns backslashes.
    const rel = relative(rootPath, file).split(sep).join("/");
    if (!/\.(?:md|json|jsonc|hujson|ts|tsx|yml|yaml|toml|sh|ps1)$/.test(file) && !["LICENSE", "NOTICE"].includes(rel)) {
      continue;
    }
    const text = await readFile(file, "utf8");
    errors.push(...checkProviderReads(rel, text));
    errors.push(...checkUnsafeFinally(rel, text));
    if (rel === "scripts/check-repository.ts") continue;
    // adb argv must be constructed only by its redacting, exit-checking owner, including calls
    // routed through generic subprocess wrappers. The one executable-prerequisite list is not argv.
    if (rel.startsWith("scripts/") && rel.endsWith(".ts") && !rel.endsWith(".test.ts") && rel !== "scripts/android-device.ts") {
      const commands = text.replace('["adb", "security", "git", "gh", "cosign", "shasum", "ssh", "scp", "bash", "python3", "curl"]', "[]");
      if (/\[\s*["'](?:[^"'\r\n]*[/\\])?adb(?:\.exe)?["']/u.test(commands) ||
        /\b(?:spawn|spawnSync|exec|execFile|execFileSync)\s*\(\s*["'](?:[^"'\r\n]*[/\\])?adb(?:\.exe)?(?:["']|\s)/u.test(commands)) {
        errors.push(rel + ": spawns adb outside android-device.ts; use runAdb");
      }
    }
    for (const old of forbiddenLegacy) {
      if (text.includes(old)) errors.push(`${rel}: contains legacy identifier ${JSON.stringify(old)}`);
    }
    // Bun's Database.exec runs each statement of a multi-statement string, but ignores a runtime
    // failure of every statement except the last. The release-host lease once ignored its busy
    // BEGIN IMMEDIATE that way, then waited out its busy timeout a second time on the next statement.
    if (/\.tsx?$/u.test(rel) && /from\s+["']bun:sqlite["']/u.test(text)) {
      for (const match of text.matchAll(/\.(?:exec|run)\(\s*(?:"[^"]*;\s*[^"\s][^"]*"|'[^']*;\s*[^'\s][^']*'|`[^`]*;\s*[^`\s][^`]*`)/gu)) {
        errors.push(`${rel}:${text.slice(0, match.index).split("\n").length}: runs several SQLite statements in one exec; Bun ignores the failure of all but the last`);
      }
    }
    // A file URL's pathname is "/D:/..." on Windows, which no filesystem API can open.
    if (/\.tsx?$/u.test(rel) && /import\.meta\.url\)\.pathname\b/u.test(text)) {
      errors.push(`${rel}: uses a file URL's pathname as a filesystem path; use fileURLToPath`);
    }
    // A candidate tag keeps its prerelease suffix when only the "v" is removed: v0.6.0-prealpha.1
    // installs as 0.6.0, and the Windows lane once compared against "0.6.0-prealpha.1".
    if (/^scripts\/.+\.ts$/u.test(rel) && /[Tt]ag\.slice\(1\)/u.test(text)) {
      errors.push(`${rel}: derives a package version by slicing a release tag; use releaseVersion`);
    }
    if (rel.endsWith(".md") && /\$\{[A-Z_]*TAG#v\}/u.test(text)) {
      errors.push(`${rel}: derives a package version by stripping a release tag's "v"; a prerelease tag keeps its suffix`);
    }
    // `config set` can exit 0 without writing: over WinRM, a compiled OMP's first write did, and the
    // Windows lane's host started with auto-start off and never published. Only a read-back proves it.
    if (/^scripts\//u.test(rel) && /config['",\s]+set['",\s]+collab\.autoStart/u.test(text) && !/config['",\s]+get['",\s]+collab\.autoStart/u.test(text)) {
      errors.push(`${rel}: enables collab.autoStart without reading it back`);
    }
    // A create-time `mode` is filtered by the umask. A test that needs a group- or world-accessible
    // fixture must chmod it, or a 077 umask silently makes it private, as provision-linux-qual.test.ts did.
    if (rel.endsWith(".test.ts")) {
      for (const [, target, mode] of text.matchAll(/\b(?:writeFile|mkdir)\(\s*([\w.]+)\s*,[^;]*?\{\s*(?:recursive:\s*true,\s*)?mode:\s*0o([0-7]{3,4})\s*\}/gu)) {
        if (!target || !mode || (Number.parseInt(mode, 8) & 0o077) === 0) continue;
        if (!new RegExp(`\\b(?:chmod|makeFixtureUnsafe)\\(\\s*${target.replaceAll(".", "\\.")}\\s*[,)]`, "u").test(text)) {
          errors.push(`${rel}: creates ${target} with mode 0o${mode} but never chmods it; the umask can make it private`);
        }
      }
    }
  }

  for (const rel of [
    "package.json",
    "UPSTREAM.lock.json",
    "schemas/omp-host-registry.schema.json",
    "schemas/session-list.schema.json",
    "schemas/launch-request.schema.json",
    "schemas/launch-response.schema.json",
    "schemas/sse-event.schema.json",
    "schemas/upstream-lock.schema.json",
  ]) {
    try {
      JSON.parse(await readFile(join(rootPath, rel), "utf8"));
    } catch (error) {
      errors.push(`${rel}: invalid JSON (${error instanceof Error ? error.message : "unknown error"})`);
    }
  }

  const packageJson = JSON.parse(await readFile(join(rootPath, "package.json"), "utf8")) as { name?: string; packageManager: string };
  if (packageJson.name !== "omp-session-gateway") {
    errors.push(`package.json: expected name omp-session-gateway, got ${String(packageJson.name)}`);
  }

  const dependabot = Bun.YAML.parse(await readFile(join(rootPath, ".github/dependabot.yml"), "utf8")) as {
    updates?: Array<{
      "package-ecosystem"?: string;
      directory?: string;
      ignore?: Array<{ "dependency-name"?: string }>;
    }>;
  };
  const bunUpdates = dependabot.updates?.filter(update => update["package-ecosystem"] === "bun") ?? [];
  if (bunUpdates.length !== 1 || bunUpdates[0]?.directory !== "/") {
    errors.push("dependabot.yml: expected one root Bun ecosystem update");
  }
  if (dependabot.updates?.some(update => update["package-ecosystem"] === "npm") === true) {
    errors.push("dependabot.yml: npm cannot maintain bun.lock; use the Bun ecosystem");
  }
  const collabClientPackage = JSON.parse(
    await readFile(join(rootPath, "packages/collab-client/package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const ignoredBunDependencies = new Set(
    bunUpdates[0]?.ignore?.map(entry => entry["dependency-name"]).filter(name => name !== undefined),
  );
  for (const dependency of [
    ...Object.keys(collabClientPackage.dependencies ?? {}),
    "@types/bun",
    "@playwright/test",
    "@percy/cli",
    "@percy/playwright",
  ]) {
    if (!ignoredBunDependencies.has(dependency)) {
      errors.push(`dependabot.yml: ${dependency} must move with its pinned runtime owner, not Dependabot`);
    }
  }

  // Fleet images are shared across repositories and may carry an older Bun. Every CI job
  // must establish this repository's runtime, independently of the runner environment.
  const ci = Bun.YAML.parse(await readFile(join(rootPath, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, { steps: Array<{ uses?: string; if?: unknown; with?: Record<string, unknown> }> }>;
  };
  for (const [name, job] of Object.entries(ci.jobs)) {
    const setup = job.steps.find(step => step.uses?.startsWith("oven-sh/setup-bun@"));
    if (setup === undefined || setup.if !== undefined || setup.with?.["bun-version"] !== packageJson.packageManager.replace(/^bun@/, "")) {
      errors.push(`ci.yml: ${name} must unconditionally install the packageManager Bun version`);
    }
  }

  const canonicalChecks: Array<[string, string]> = [
    ["README.md", "# OMP Session Gateway"],
    ["AGENTS.md", "Daemon: `omp-gatewayd`"],
    ["AGENTS.md", "PWA name: **OMP Sessions**"],
    ["AGENTS.md", "Default example tailnet tag: `tag:omp-session-gateway`"],
  ];
  for (const [rel, expected] of canonicalChecks) {
    const text = await readFile(join(rootPath, rel), "utf8");
    if (!text.includes(expected)) errors.push(`${rel}: missing canonical identifier ${JSON.stringify(expected)}`);
  }

  if (errors.length > 0) {
    console.error(errors.map(error => `- ${error}`).join("\n"));
    process.exit(1);
  }

  console.log(`repository check passed (${(await walk(rootPath)).length} files scanned)`);
}

if (import.meta.main) await main();
