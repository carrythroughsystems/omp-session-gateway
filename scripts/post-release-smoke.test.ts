import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProtectedLabel } from "./acceptance-target.ts";
import { parseAndroidCollabSmokeArgs, runAndroidCollabSmoke } from "./android-collab-smoke.ts";
import { ANDROID_COLLAB_STAGES } from "./android-stages.ts";
import { requireSingleDevice } from "./android-device.ts";
import {
  assertFixtureOwnership,
  assertWebApkActiveTask,
  awaitWebApkActiveTask,
  awaitWebApkAppTarget,
  assertReleaseArchiveIdentity,
  createSmokeLabel,
  enableOmpAutoStart,
  findWebApkForHost,
  isStockOmpBinary,
  type OmpInstall,
  ensureOnPath,
  inspectBunGlobalOmp,
  launchInstalledWebApk,
  preferStockOmp,
  isWebApkAppTarget,
  formatCommandFailure,
  parseJsonRecord,
  parsePostReleaseSmokeArgs,
  preflightPostReleaseAndroid,
  releaseAssetNames,
  releaseSigningRepositories,
  verifyReleaseSignatures,
  unrelatedServeSnapshot,
  runCommand,
  withSmokeDiagnostics,
} from "./post-release-smoke.ts";

describe("private nested smoke diagnostics", () => {
  test.each([0, 1])("retains bounded exact nested child bytes before staging cleanup for exit=%i", async exitCode => {
    const root = await mkdtemp(join(tmpdir(), "smoke-nested-output-")), destination = join(root, "retained");
    let staging = "", restored = false;
    const out = Buffer.concat([Buffer.alloc(300_000, 0xff), Buffer.from(" stdout \r\n\0 ")]);
    const err = Buffer.concat([Buffer.alloc(300_000, 0xfe), Buffer.from("\nandroid-stage: Android Chrome\nError: PRIVATE-NESTED-EXCEPTION\n  at fixture\nCaused by: ORIGINAL-CHILD-CAUSE \r\n\0 ")]);
    try {
      const operation = withSmokeDiagnostics(destination, async (temporary, logs) => {
        staging = temporary;
        await writeFile(join(temporary, "must-not-retain-launcher"), "synthetic credential-bearing fixture script");
        const child = join(temporary, "child.ts");
        await writeFile(child, `
await Bun.write(Bun.stdout, Buffer.from(${JSON.stringify(out.toString("base64"))}, "base64"));
await Bun.write(Bun.stderr, Buffer.from(${JSON.stringify(err.toString("base64"))}, "base64"));
process.exitCode = ${exitCode};
`);
        return runCommand("Android smoke", [process.execPath, child], { logPrefix: join(logs, "android-collab"), stages: ANDROID_COLLAB_STAGES });
      }, [async () => { expect((await lstat(staging)).isDirectory()).toBe(true); restored = true; }]);
      if (exitCode === 0) expect((await operation).exitCode).toBe(0);
      else {
        const error = await operation.catch(error => error);
        expect(error.message).toBe('Android smoke failed with exit 1 at stage "Android Chrome"');
        expect(error.message).not.toContain("PRIVATE-NESTED-EXCEPTION");
        expect(await readFile(join(destination, "failure.json"), "utf8")).toContain("Android smoke failed");
      }
      expect(restored).toBe(true);
      await expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" });
      for (const [name, bytes] of [["android-collab-out.log", out], ["android-collab-err.log", err]] as const) {
        expect(await readFile(join(destination, name))).toEqual(bytes.subarray(-262_144));
        if (process.platform !== "win32") expect((await lstat(join(destination, name))).mode & 0o777).toBe(0o600);
      }
      if (process.platform !== "win32") expect((await lstat(destination)).mode & 0o777).toBe(0o700);
      expect((await readdir(destination)).sort()).toEqual([
        "android-collab-err.log", "android-collab-out.log", ...(exitCode === 0 ? [] : ["failure.json"]),
      ]);
    } finally { await rm(root, { recursive: true, force: true }); if (staging) await rm(staging, { recursive: true, force: true }); }
  });

  test("retains timeout and spawn failures without exposing child bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "smoke-command-failure-"));
    try {
      await expect(runCommand("timed smoke", [process.execPath, "-e", 'console.error("PRIVATE-TIMEOUT-CHILD"); await Bun.sleep(60_000);'], {
        timeoutMs: 1_000, logPrefix: join(root, "android-acceptance"),
      })).rejects.toThrow("timed smoke timed out");
      expect(await readFile(join(root, "android-acceptance-err.log"), "utf8")).toContain("PRIVATE-TIMEOUT-CHILD");
      await expect(runCommand("absent smoke", [join(root, "not-an-executable")], {
        logPrefix: join(root, "android-leaks"),
      })).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(root, "android-leaks-err.log"))).toEqual(Buffer.alloc(0));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("retains original cause and all restoration errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "smoke-causes-")), destination = join(root, "retained");
    const cause = new Error("ORIGINAL-ROOT-CAUSE"), original = new Error("ORIGINAL-BODY-ERROR", { cause }), cleanup = new Error("ORIGINAL-CLEANUP-ERROR");
    let staging = "", restored = false;
    try {
      const error = await withSmokeDiagnostics(destination, async temporary => {
        staging = temporary; throw original;
      }, [() => { throw cleanup; }, () => { restored = true; }]).catch(error => error);
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors).toEqual([original, cleanup]);
      expect(restored).toBe(true);
      const diagnostic = await readFile(join(destination, "failure.json"), "utf8");
      for (const message of [cause.message, original.message, cleanup.message]) expect(diagnostic).toContain(message);
      expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(262_144);
      await expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test.each(["collision", "unexpected", "oversized"])("retention %s preserves staging and existing evidence", async failure => {
    const root = await mkdtemp(join(tmpdir(), "smoke-retention-failure-")), destination = join(root, "retained");
    let staging = "", restored = false;
    try {
      await expect(withSmokeDiagnostics(destination, async (temporary, logs) => {
        staging = temporary;
        await writeFile(join(logs, failure === "unexpected" ? "launcher" : "android-collab-out.log"),
          failure === "oversized" ? Buffer.alloc(262_145) : "original staging bytes", { mode: 0o600 });
        if (failure === "collision") await writeFile(join(destination, "android-collab-out.log"), "immutable prior evidence");
      }, [() => { restored = true; }])).rejects.toThrow();
      expect(restored).toBe(true);
      expect((await lstat(staging)).isDirectory()).toBe(true);
      if (failure === "collision") expect(await readFile(join(destination, "android-collab-out.log"), "utf8")).toBe("immutable prior evidence");
      expect(await Bun.file(join(destination, "failure.json")).exists()).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); if (staging) await rm(staging, { recursive: true, force: true }); }
  });

  test.skipIf(process.platform === "win32")("never follows a staged diagnostic symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "smoke-log-symlink-")), destination = join(root, "retained");
    let staging = "";
    try {
      const foreign = join(root, "foreign");
      await writeFile(foreign, "not diagnostic bytes");
      await expect(withSmokeDiagnostics(destination, async (temporary, logs) => {
        staging = temporary;
        await symlink(foreign, join(logs, "android-collab-out.log"));
      }, [])).rejects.toThrow();
      expect(await Bun.file(join(destination, "android-collab-out.log")).exists()).toBe(false);
      expect(await readFile(foreign, "utf8")).toBe("not diagnostic bytes");
    } finally { await rm(root, { recursive: true, force: true }); if (staging) await rm(staging, { recursive: true, force: true }); }
  });

  test("an existing destination refuses before running the body or restoration", async () => {
    const root = await mkdtemp(join(tmpdir(), "smoke-existing-"));
    try {
      let ran = false;
      await expect(withSmokeDiagnostics(root, async () => { ran = true; }, [() => { ran = true; }])).rejects.toMatchObject({ code: "EEXIST" });
      expect(ran).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});


test.each([
  ["alphastorm", "v0.7.5", true],
  ["carrythroughsystems", "v0.7.6", true],
  ["alphastorm", "v0.7.6", false],
  ["alphastorm", "v0.7.5-prealpha.3", false],
  ["foreign", "v0.7.5", false],
])("release signing policy pins %s certificate at %s", async (owner, tag, accepted) => {
  const signer = owner + "/omp-session-gateway";
  const workflow = signer + "/.github/workflows/signed-release.yml";
  const certificate = { identity: "https://github.com/" + workflow + "@refs/tags/" + tag, issuer: "https://token.actions.githubusercontent.com" };
  const verified: string[] = [];
  const run = async (argv: string[]) => {
    const value = (flag: string) => argv[argv.indexOf(flag) + 1];
    if (argv[0] === "cosign") {
      expect(value("--bundle")).toBe("archive.tar.sigstore.json");
      if (value("--certificate-identity") !== certificate.identity || value("--certificate-oidc-issuer") !== certificate.issuer) throw new Error("certificate refused");
    } else {
      expect(argv.slice(0, 4)).toEqual(["gh", "attestation", "verify", "archive.tar"]);
      if (value("--repo") !== signer || value("--signer-workflow") !== workflow || value("--source-ref") !== "refs/tags/" + tag) throw new Error("provenance refused");
    }
    verified.push(argv[0]!);
  };
  if (accepted) {
    await verifyReleaseSignatures("archive.tar", "carrythroughsystems/omp-session-gateway", tag, run);
    expect(verified).toEqual(["cosign", "gh"]);
  } else {
    await expect(verifyReleaseSignatures("archive.tar", "carrythroughsystems/omp-session-gateway", tag, run)).rejects.toThrow();
    expect(verified).toEqual([]);
  }
});

test.each(["workflow", "ref", "issuer", "attestation"])("release verification refuses mismatched %s", async mismatch => {
  await expect(verifyReleaseSignatures("archive.tar", "carrythroughsystems/omp-session-gateway", "v0.7.5", async argv => {
    const value = (flag: string) => argv[argv.indexOf(flag) + 1];
    const signer = "alphastorm/omp-session-gateway";
    const workflow = signer + "/.github/workflows/" + (mismatch === "workflow" ? "other.yml" : "signed-release.yml");
    const ref = mismatch === "ref" ? "refs/heads/main" : "refs/tags/v0.7.5";
    const issuer = mismatch === "issuer" ? "https://untrusted.invalid" : "https://token.actions.githubusercontent.com";
    if (argv[0] === "cosign") {
      if (value("--certificate-identity") !== "https://github.com/" + workflow + "@" + ref || value("--certificate-oidc-issuer") !== issuer) throw new Error("certificate refused");
    } else if (mismatch === "attestation") throw new Error("provenance refused");
  })).rejects.toThrow();
});

describe("historical predecessor provenance", () => {
  const digest = "171dec1a9902c934c99060b250f209cf627ce194d07da1412b35ad419c3ec57c";
  const repository = "carrythroughsystems/omp-session-gateway";
  const archive = "omp-session-gateway-0.7.5-bun.tar";
  const identity = "https://github.com/alphastorm/omp-session-gateway/.github/workflows/signed-release.yml@refs/tags/v0.7.5";

  test("the allowlisted digest requires its original Cosign identity, not absent attestations", async () => {
    const commands: string[][] = [];
    await verifyReleaseSignatures(archive, repository, "v0.7.5", async argv => {
      commands.push(argv);
      if (argv[0] === "gh") throw new Error("historical attestation absent");
      expect(argv[argv.indexOf("--certificate-identity") + 1]).toBe(identity);
      expect(argv[argv.indexOf("--certificate-oidc-issuer") + 1]).toBe("https://token.actions.githubusercontent.com");
      expect(argv[argv.indexOf("--bundle") + 1]).toBe(archive + ".sigstore.json");
    }, digest);
    expect(commands.map(argv => argv[0])).toEqual(["cosign"]);
  });

  test("a tampered digest refuses before signature execution", async () => {
    const commands: string[][] = [];
    await expect(verifyReleaseSignatures(archive, repository, "v0.7.5", async argv => {
      commands.push(argv);
    }, "0".repeat(64))).rejects.toThrow("historical predecessor archive digest");
    expect(commands).toEqual([]);
  });

  test.each(["v0.7.6", "v0.7.5-prealpha.3", "v0.7.4"])("non-allowlisted %s still refuses a missing attestation", async tag => {
    await expect(verifyReleaseSignatures(archive, repository, tag, async argv => {
      if (argv[0] === "gh") throw new Error("attestation absent");
    }, digest)).rejects.toThrow("attestation absent");
  });

  test("ordinary release verification cannot use the predecessor exception", async () => {
    await expect(verifyReleaseSignatures(archive, repository, "v0.7.5", async argv => {
      if (argv[0] === "gh") throw new Error("attestation absent");
    })).rejects.toThrow("attestation absent");
  });

  test("the exception never admits an invalid Cosign signature", async () => {
    await expect(verifyReleaseSignatures(archive, repository, "v0.7.5", async () => {
      throw new Error("certificate refused");
    }, digest)).rejects.toThrow("certificate refused");
  });

  test("the exception cannot authorize a different repository or asset", async () => {
    await expect(verifyReleaseSignatures(archive, "foreign/gateway", "v0.7.5", async argv => {
      if (argv[0] === "gh") throw new Error("attestation absent");
    }, digest)).rejects.toThrow("attestation absent");
    await expect(verifyReleaseSignatures("foreign.tar", repository, "v0.7.5", async () => {}, digest)).rejects.toThrow("historical predecessor asset");
  });
});

test.skipIf(process.platform === "win32").each(["qualify-rollback.sh", "qualify-macos-host.sh", "provision-linux-qual.sh"])("%s uses the same closed historical signing policy", async script => {
  const source = await Bun.file(new URL(script, import.meta.url)).text();
  const policy = source.match(/release_signing_repositories\(\) \{[\s\S]*?\n\}/u)?.[0];
  expect(policy).toBeDefined();
  const historical = policy!.match(/case "\$tag" in\n\s+([^\n]+)\)/u)![1]!.split("|");
  expect(historical).toHaveLength(83);
  for (const tag of historical) expect(releaseSigningRepositories("carrythroughsystems/omp-session-gateway", tag)).toHaveLength(2);
  for (const repository of ["carrythroughsystems/omp-session-gateway", "alphastorm/omp-session-gateway", "other/gateway"]) {
    for (const tag of ["v0.1.0-alpha.1", "v0.7.5", "v0.7.6", "v0.7.5-prealpha.3", "v0.7.4-prealpha.99"]) {
      const child = Bun.spawn(["bash", "-c", policy + '\nrelease_signing_repositories "$1" "$2"', "test", repository, tag], { stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stderr).toBe(0);
      expect(stdout.trim().split("\n")).toEqual(releaseSigningRepositories(repository, tag));
    }
  }
});

const SOURCE_COMMIT = "07ba8be884c268375890d50b1a6af51f22bdb16a";
const ARCHIVE_SHA256 = "a".repeat(64);

test.skipIf(process.platform === "win32")("recognizes bare and prefixed OMP banners without admitting older versions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-smoke-version-"));
  try {
    await writeFile(join(directory, "omp"), `#!/bin/sh
if [ "$1" = --version ]; then
  printf '%s\n' "$OMP_SMOKE_TEST_VERSION"
elif [ "$*" = 'config get collab.autoStart --json' ]; then
  printf '%s\n' '{"value":"control"}'
else
  exit 1
fi
`, { mode: 0o700 });
    const script = `import { inspectOmpInstall } from ${JSON.stringify(new URL("./post-release-smoke.ts", import.meta.url).href)}; console.log(JSON.stringify(await inspectOmpInstall()));`;
    for (const [banner, compatible] of [["18.1.21", true], ["omp/18.1.20", true], ["18.1.19", false]] as const) {
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, PATH: directory, OMP_SMOKE_TEST_VERSION: banner },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      if (exitCode !== 0) throw new Error(stderr);
      expect(JSON.parse(stdout).compatible, banner).toBe(compatible);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("refuses an auto-start write that exits cleanly without persisting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-smoke-autostart-"));
  try {
    // `config set` always exits 0; it persists only when the `writes` marker exists, as a
    // compiled OMP over WinRM once did not.
    const binary = join(directory, "omp");
    await writeFile(binary, `#!/bin/sh
state="$(dirname "$0")/autostart"
if [ "$*" = 'config set collab.autoStart control' ]; then
  if [ -e "$(dirname "$0")/writes" ]; then printf control > "$state"; fi
elif [ "$*" = 'config get collab.autoStart --json' ]; then
  printf '{"value":"%s"}\\n' "$(cat "$state" 2>/dev/null || printf off)"
else
  exit 1
fi
`, { mode: 0o700 });
    await expect(enableOmpAutoStart(binary)).rejects.toThrow("collab.autoStart does not read back as control");
    await writeFile(join(directory, "writes"), "");
    await expect(enableOmpAutoStart(binary)).resolves.toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("distinguishes stock mainline omp from another product wearing the name", () => {
  // A bun global install resolves the shim to the mainline package entrypoint.
  expect(isStockOmpBinary("/Users/x/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js")).toBe(true);
  expect(isStockOmpBinary("/opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js")).toBe(true);
  // The real regression: a Code Mode launcher reports a compatible version banner, so only the
  // resolved path shows it is a different product. Accepting it qualified a release against an
  // agent carrying trusted extensions and a routed config.
  expect(isStockOmpBinary("/Users/x/.local/lib/omp-code-mode/releases/18.2.8-abc/omp-code-mode-launcher")).toBe(false);
  // Near misses must not pass: a lookalike package name or a path merely mentioning the vendor.
  expect(isStockOmpBinary("/Users/x/node_modules/@oh-my-pi/pi-coding-agent-fork/dist/cli.js")).toBe(false);
  expect(isStockOmpBinary("/Users/x/oh-my-pi/pi-coding-agent/dist/cli.js")).toBe(false);
});

describe("stock OMP selection", () => {
  const launcher: OmpInstall = { compatible: true, binary: "/Users/x/.local/bin/omp", version: "18.3.0", binarySha256: "a", stock: false };
  const bunGlobal: OmpInstall = { compatible: true, binary: "/Users/x/.bun/bin/omp", version: "18.1.20", binarySha256: "b", stock: true };

  test("keeps a stock omp on PATH even when Bun's global install is also stock", () => {
    const onPath: OmpInstall = { ...bunGlobal, binary: "/opt/bin/omp", version: "18.3.0", binarySha256: "c" };
    expect(preferStockOmp(onPath, bunGlobal)).toBe(onPath);
  });

  test("uses Bun's global stock install in place of a same-named launcher on PATH", () => {
    // The v0.5.2 smoke's first attempt stopped here: a Code Mode launcher owned `omp` on PATH
    // while stock OMP was already installed globally.
    expect(preferStockOmp(launcher, bunGlobal)).toBe(bunGlobal);
  });

  test("keeps the launcher when no stock alternative exists, so the refusal names it", () => {
    expect(preferStockOmp(launcher, { compatible: false, binary: "/Users/x/.bun/bin/omp" })).toBe(launcher);
  });

  test("uses Bun's global stock install when PATH has no omp at all", () => {
    expect(preferStockOmp({ compatible: false }, bunGlobal)).toBe(bunGlobal);
  });

  test("treats a host with no Bun global install yet as having no global omp", async () => {
    // The first Studio smoke (v0.7.3, attempt 1) died here: `bun pm bin --global` fails until the
    // first `bun add --global` creates the directory, so the probe must report absence, not throw.
    const result = await inspectBunGlobalOmp(async () => { throw new Error("Bun global bin failed with exit 1"); });
    expect(result).toEqual({ compatible: false });
    expect(preferStockOmp({ compatible: false }, result).binary).toBeUndefined();
  });

  test("puts the selected omp's directory on PATH once, so the doctor and launched hosts resolve it", () => {
    // Attempt 3: omp 18.4.12 selected from Bun's global bin, PATH without that directory, gateway
    // doctor `compatibility: false`.
    expect(ensureOnPath("/Users/x/.bun/bin", "/opt/homebrew/bin:/usr/bin")).toBe("/Users/x/.bun/bin:/opt/homebrew/bin:/usr/bin");
    expect(ensureOnPath("/Users/x/.bun/bin", "/Users/x/.bun/bin:/usr/bin")).toBe("/Users/x/.bun/bin:/usr/bin");
    expect(ensureOnPath("/Users/x/.bun/bin", "")).toBe("/Users/x/.bun/bin");
  });
});

describe("post-release smoke arguments", () => {
  test("defaults to the package's bare stable tag and accepts bounded rerun controls", () => {
    expect(parsePostReleaseSmokeArgs([], "0.1.0")).toEqual({
      tag: "v0.1.0",
      repository: "carrythroughsystems/omp-session-gateway",
      forceReinstall: false,
      rebuildOmp: false,
      planOnly: false,
    });
    expect(
      parsePostReleaseSmokeArgs(
        [
          "--tag",
          "v0.1.0",
          "--repo",
          "carrythroughsystems/omp-session-gateway",
          "--archive-sha256",
          ARCHIVE_SHA256,
          "--force-reinstall",
          "--rebuild-omp",
          "--plan",
        ],
        "0.1.0",
      ),
    ).toEqual({
      tag: "v0.1.0",
      repository: "carrythroughsystems/omp-session-gateway",
      expectedArchiveSha256: ARCHIVE_SHA256,
      forceReinstall: true,
      rebuildOmp: true,
      planOnly: true,
    });
  });

  test("rejects prereleases, mismatched versions, malformed digests, and unknown options", () => {
    expect(() => parsePostReleaseSmokeArgs(["--tag", "v0.1.0-beta.1"], "0.1.0")).toThrow("bare stable tag");
    expect(() => parsePostReleaseSmokeArgs(["--tag", "v0.2.0"], "0.1.0")).toThrow("package.json version");
    expect(() => parsePostReleaseSmokeArgs(["--archive-sha256", "A".repeat(64)], "0.1.0")).toThrow(
      "lowercase hexadecimal",
    );
    expect(() => parsePostReleaseSmokeArgs(["--skip-android"], "0.1.0")).toThrow("unknown option");
  });
});

describe("published release binding", () => {
  test("requires the exact six stable assets", () => {
    const names = releaseAssetNames("0.1.0");
    expect(names.archive).toBe("omp-session-gateway-0.1.0-bun.tar");
    expect(names.sbom).toBe("omp-session-gateway-0.1.0.spdx.json");
    expect(names.attested).toEqual([names.archive, names.sbom, "SHA256SUMS"]);
    expect(names.all).toHaveLength(6);
    expect(names.all).toContain("SHA256SUMS.sigstore.json");
  });

  test("binds archive identity to stable source, runtime, and qualification", () => {
    const identity = {
      product: "OMP Session Gateway",
      version: "0.1.0",
      sourceCommit: SOURCE_COMMIT,
      runtime: "Bun >=1.3.14",
      qualification: "qualified stable 0.1",
    };
    expect(() => assertReleaseArchiveIdentity(identity, "0.1.0", SOURCE_COMMIT, "1.3.14")).not.toThrow();
    expect(() => assertReleaseArchiveIdentity({ ...identity, sourceCommit: "0".repeat(40) }, "0.1.0", SOURCE_COMMIT, "1.3.14")).toThrow(
      "does not match",
    );
    expect(() => assertReleaseArchiveIdentity({ ...identity, runtime: "Bun >=1.4.0" }, "0.1.0", SOURCE_COMMIT, "1.3.14")).toThrow(
      "does not match",
    );
  });

  test("redacts command output unless the caller explicitly marks it safe", () => {
    const syntheticSecret = "qualification-capability-never-log-this";
    const redacted = formatCommandFailure("Android smoke", 1, syntheticSecret, "", false);
    expect(redacted).toBe("Android smoke failed with exit 1");
    expect(redacted).not.toContain(syntheticSecret);
    expect(formatCommandFailure("artifact verification", 1, "", "signature mismatch", true)).toContain(
      "signature mismatch",
    );
  });

  test("surfaces only the last announced vocabulary stage of a withheld lane", () => {
    const syntheticSecret = "qualification-capability-never-log-this";
    const lane = ["android-stage: directory", "android-stage: View", syntheticSecret].join("\n");
    expect(formatCommandFailure("Android smoke", 1, syntheticSecret, lane, false, ANDROID_COLLAB_STAGES)).toBe(
      'Android smoke failed with exit 1 at stage "View"',
    );
    const forged = formatCommandFailure(
      "Android smoke",
      1,
      "",
      `android-stage: View\nandroid-stage: ${syntheticSecret}\n`,
      false,
      ANDROID_COLLAB_STAGES,
    );
    expect(forged).toBe("Android smoke failed with exit 1");
    expect(forged).not.toContain(syntheticSecret);
  });

  test("never quotes a withheld lane's malformed stdout in its parse error", () => {
    const syntheticSecret = "qualificationcapabilityneverlogthis";
    for (const stdout of [syntheticSecret, `{"appAsset": ${syntheticSecret}}`, `${syntheticSecret}\n{}`]) {
      let message = "";
      try {
        parseJsonRecord(stdout, "Android View and Control smoke");
      } catch (error) {
        message = String(error);
      }
      expect(message).toBe("Error: Android View and Control smoke did not return JSON");
    }
  });
});

describe("disposable fixture safety", () => {
  test("generates an unprotected owned label", () => {
    const label = createSmokeLabel("0.1.0", "deadbeef");
    expect(label).toBe("omp-post-release-0-1-0-deadbeef");
    expect(isProtectedLabel(label)).toBe(false);
    expect(() => createSmokeLabel("0.1.0", "../unsafe")).toThrow("nonce");
  });

  test("requires the exact per-run marker before recursive cleanup", () => {
    expect(() => assertFixtureOwnership("run-id\n", "run-id")).not.toThrow();
    expect(() => assertFixtureOwnership("somebody-else\n", "run-id")).toThrow("refusing directory cleanup");
  });

  test("preserves every unrelated Tailscale Serve mapping", () => {
    const baseline = {
      TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
      Web: {
        "gateway.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4317" } } },
        "gateway.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:14317" } } },
      },
    };
    const replacedTarget = {
      ...baseline,
      TCP: { ...baseline.TCP, "443": { HTTPS: false } },
      Web: {
        ...baseline.Web,
        "gateway.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } },
      },
    };
    expect(unrelatedServeSnapshot(replacedTarget, "gateway.example.ts.net", 443)).toBe(
      unrelatedServeSnapshot(baseline, "gateway.example.ts.net", 443),
    );
    const changedUnrelated = {
      ...baseline,
      Web: {
        ...baseline.Web,
        "gateway.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } },
      },
    };
    expect(unrelatedServeSnapshot(changedUnrelated, "gateway.example.ts.net", 443)).not.toBe(
      unrelatedServeSnapshot(baseline, "gateway.example.ts.net", 443),
    );
  });
});

describe("physical Android release target", () => {
  test("accepts a WebAPK resuming collaboration rather than the directory title", () => {
    expect(isWebApkAppTarget(
      { type: "page", title: "Ongoing session · omp collab", url: "https://gateway.example.ts.net/client/" },
      "https://gateway.example.ts.net",
    )).toBe(true);
    expect(isWebApkAppTarget(
      { type: "page", title: "OMP Sessions", url: "https://gateway.example.ts.net/" },
      "https://gateway.example.ts.net",
    )).toBe(true);
  });

  test("rejects non-app targets and URLs outside the capability-free application routes", () => {
    const origin = "https://gateway.example.ts.net";
    for (const url of ["not a URL", "https://other.example.ts.net/", `${origin}/api/v1/sessions`, `${origin}/client/?unexpected=1`, `${origin}/client/#unexpected`]) {
      expect(isWebApkAppTarget({ type: "page", title: "OMP Sessions", url }, origin)).toBe(false);
    }
    expect(isWebApkAppTarget({ type: "service_worker", url: `${origin}/` }, origin)).toBe(false);
  });
  test("the WebAPK page target check resolves when the target appears on the third poll", async () => {
    const origin = "https://gateway.example.ts.net";
    let clock = 0;
    let reads = 0;
    const pauses: number[] = [];
    await awaitWebApkAppTarget(async () => {
      reads++;
      return reads < 3
        ? [{ type: "page", title: "Starting", url: "about:blank" }]
        : [{ type: "page", title: "OMP Sessions", url: `${origin}/` }];
    }, origin, {
      now: () => clock,
      sleep: async milliseconds => { pauses.push(milliseconds); clock += milliseconds; },
    });
    expect(reads).toBe(3);
    expect(clock).toBe(2_000);
    expect(pauses).toEqual([1_000, 1_000]);
  });

  test("the WebAPK page target check fails closed at its deadline with sanitized last targets", async () => {
    const origin = "https://gateway.example.ts.net";
    const capabilityTitle = `#${"s".repeat(16)}.${"x".repeat(43)}`;
    let clock = 100;
    let reads = 0;
    const pauses: number[] = [];
    const failure = await awaitWebApkAppTarget(async () => {
      reads++;
      return reads === 1
        ? [{ type: "page", title: "Earlier target", url: "about:blank" }]
        : [
          { type: "page", title: "Waiting\u001b\u202e for WebAPK", url: "https://user:password@other.example.ts.net/private/path?token=query-secret#fragment-secret" },
          { type: "page", title: capabilityTitle, url: "invalid URL with secret" },
        ];
    }, origin, {
      now: () => clock,
      sleep: async milliseconds => { pauses.push(milliseconds); clock += milliseconds; },
      deadlineMs: 2_500,
      intervalMs: 1_000,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("installed WebAPK did not render the OMP Sessions origin");
    expect(message).toContain("https://other.example.ts.net/[redacted]?[redacted]#[redacted]");
    expect(message).toContain("Waiting for WebAPK");
    expect(message).toContain('"title":"[redacted]"');
    for (const withheld of ["Earlier target", "user", "password", "private/path", "query-secret", "fragment-secret", "invalid URL with secret", capabilityTitle, "\u001b", "\u202e"]) {
      expect(message).not.toContain(withheld);
    }
    expect(reads).toBe(4);
    expect(clock).toBe(2_600);
    expect(pauses).toEqual([1_000, 1_000, 500]);
  });

  test("rejects WebAPK page targets carrying a query or hash", () => {
    const origin = "https://gateway.example.ts.net";
    for (const route of ["/", "/client/"]) {
      for (const suffix of ["?unexpected=1", "#unexpected"]) {
        expect(isWebApkAppTarget({ type: "page", title: "OMP Sessions", url: `${origin}${route}${suffix}` }, origin)).toBe(false);
      }
    }
  });

  test("parses exact app binding and explicit old-fixture acknowledgement", () => {
    expect(
      parseAndroidCollabSmokeArgs([
        "https://gateway.example.ts.net",
        "omp-post-release-0-1-0-deadbeef",
        "--expected-app-asset",
        "/assets/app.abc123.js",
        "--disposable-target",
      ]),
    ).toEqual({
      origin: "https://gateway.example.ts.net",
      label: "omp-post-release-0-1-0-deadbeef",
      expectedAppAsset: "/assets/app.abc123.js",
      allowDisposableTarget: true,
    });
  });

  test.each(["cancel", "deadline"] as const)("council498r1 physical-client preflight owns %s cancellation", async mode => {
    const original = globalThis.fetch;
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    globalThis.fetch = (async (_url, options) => {
      signal = options?.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(Response.json({ sessions: [] })), 200);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal!.reason); }, { once: true });
      });
    }) as typeof fetch;
    try {
      const input = { origin: "https://synthetic.invalid", label: "synthetic-fixture", allowDisposableTarget: true,
        execution: { signal: controller.signal, deadline: performance.now() + (mode === "deadline" ? 20 : 5_000) } };
      const result = runAndroidCollabSmoke(input).catch(error => error);
      if (mode === "cancel") setTimeout(() => controller.abort(), 20);
      await result;
      expect(signal?.aborted).toBe(true);
    } finally { globalThis.fetch = original; }
  });

  test("rejects protected targets and non-origin URLs before touching the device", () => {
    expect(() => parseAndroidCollabSmokeArgs(["https://gateway.example.ts.net", "relay-soak", "--disposable-target"])).toThrow(
      "protected",
    );
    expect(() => parseAndroidCollabSmokeArgs(["http://gateway.example.ts.net", "omp-disposable"])).toThrow("HTTPS origin");
    expect(() => parseAndroidCollabSmokeArgs(["https://gateway.example.ts.net/path", "omp-disposable"])).toThrow(
      "without a path",
    );
  });

  test("finds one WebAPK bound to the exact gateway authority", () => {
    const packages = ["package:org.chromium.webapk.owned_v2", "package:org.chromium.webapk.other_v2"].join("\n");
    const dumps = {
      "org.chromium.webapk.owned_v2": 'Authority: "gateway.example.ts.net": -1',
      "org.chromium.webapk.other_v2": 'Authority: "other.example.ts.net": -1',
    };
    expect(findWebApkForHost(packages, dumps, "gateway.example.ts.net")).toBe("org.chromium.webapk.owned_v2");
    expect(findWebApkForHost(packages, dumps, "missing.example.ts.net")).toBeUndefined();
    expect(() =>
      findWebApkForHost(
        packages,
        {
          ...dumps,
          "org.chromium.webapk.other_v2": 'Authority: "gateway.example.ts.net": -1',
        },
        "gateway.example.ts.net",
      ),
    ).toThrow("multiple installed WebAPKs");
  });

  test("refuses a missing or ambiguous adb device before release effects", async () => {
    const oneDevice = "List of devices attached\nPIXEL_SERIAL\tdevice product:pixel model:Pixel transport_id:1\n";
    expect(await requireSingleDevice(async () => oneDevice)).toBe("PIXEL_SERIAL");
    await expect(requireSingleDevice(async () => "List of devices attached\n\n")).rejects.toThrow("no authorized adb device");
    await expect(requireSingleDevice(async () => "List of devices attached\nFIRST\tdevice\nSECOND\tdevice\n")).rejects.toThrow("expected one authorized adb device");
  });

  test("Android smoke admission permits Bedtime DND but refuses tethering", async () => {
    let tethering = false;
    const command = async (...args: string[]) => {
      if (args[0] === "devices") return "List of devices attached\nSYNTHETIC-SMOKE-DEVICE device\n";
      if (args.slice(-3).join(" ") === "shell dumpsys tethering") return "Upstream wanted: " + tethering + "\n";
      if (args.slice(-5).join(" ") === "shell settings get global zen_mode") return "1\n";
      throw new Error("unexpected device mutation or probe");
    };
    await preflightPostReleaseAndroid(command);
    tethering = true;
    await expect(preflightPostReleaseAndroid(command)).rejects.toThrow("turn off hotspot");
  });

  test("requires the exact WebAPK to own the focused standalone task", () => {
    const packageName = "org.chromium.webapk.owned_v2";
    const active = [
      "topResumedActivity=ActivityRecord{abc u0 com.android.chrome/SameTaskWebApkActivity t1}",
      "topDisplayFocusedRootTask=Task{abc A=10466:" + packageName + "}",
    ].join("\n");
    expect(() => assertWebApkActiveTask(active, packageName)).not.toThrow();
    expect(() => assertWebApkActiveTask("topResumedActivity=com.android.chrome/Main", packageName)).toThrow(
      "active standalone task",
    );
  });
});

describe("installed WebAPK focus recovery", () => {
  const packageName = "org.chromium.webapk.abc_v2";
  const browserInFront = "topResumedActivity=ActivityRecord{1 u0 com.android.chrome/com.google.android.apps.chrome.Main t1}\n  topDisplayFocusedRootTask=Task{2 #1 type=standard A=10123:com.android.chrome}";
  const webApkInFront = `topResumedActivity=ActivityRecord{3 u0 com.android.chrome/org.chromium.chrome.browser.webapps.SameTaskWebApkActivity t2}\n  topDisplayFocusedRootTask=Task{4 #2 type=standard A=10466:${packageName}}`;
  const deviceState = "mWakefulness=Awake\nisKeyguardShowing=false";

  test("the WebAPK task check polls until the launch settles without a re-launch", async () => {
    let clock = 0, reads = 0, launches = 0;
    await awaitWebApkActiveTask(async () => ++reads < 4 ? browserInFront : webApkInFront, packageName, {
      launch: async () => { launches++; },
      readDeviceState: async () => { throw new Error("success must not collect diagnostics"); },
      sleep: async milliseconds => { clock += milliseconds; },
      now: () => clock,
    });
    expect(reads).toBe(4);
    expect(clock).toBe(3_000);
    expect(launches).toBe(1);
  });

  test("the WebAPK task check re-launches once when Chrome keeps focus after the first launch", async () => {
    let clock = 0, launches = 0;
    const launchTimes: number[] = [];
    await awaitWebApkActiveTask(async () => launches >= 2 ? webApkInFront : browserInFront, packageName, {
      launch: async () => { launches++; launchTimes.push(clock); },
      readDeviceState: async () => { throw new Error("success must not collect diagnostics"); },
      sleep: async milliseconds => { clock += milliseconds; },
      now: () => clock,
    });
    expect(launches).toBe(2);
    expect(launchTimes).toEqual([0, 10_000]);
    expect(clock).toBe(10_000);
  });

  test("an already-focused WebAPK needs only the first launch and activity read", async () => {
    let launches = 0, reads = 0;
    await awaitWebApkActiveTask(async () => { reads++; return webApkInFront; }, packageName, {
      launch: async () => { launches++; },
      readDeviceState: async () => { throw new Error("success must not collect diagnostics"); },
      sleep: async () => { throw new Error("already focused"); },
      now: () => 0,
    });
    expect(launches).toBe(1);
    expect(reads).toBe(1);
  });

  test("wakes and dismisses the keyguard, then sends HOME before the first launcher intent", async () => {
    const events: string[] = [];
    let keyguard = true, clock = 0, launches = 0;
    await launchInstalledWebApk("SYNTHETIC-SMOKE-DEVICE", packageName, {
      command: async (...args) => {
        const command = args.join(" ");
        events.push(command);
        if (command === "shell dumpsys power") return "mWakefulness=Awake";
        if (command === "shell dumpsys window") {
          events.push(`keyguard:${keyguard}`);
          return `isKeyguardShowing=${keyguard}`;
        }
        if (command === "shell wm size") return "Physical size: 1080x2400";
        if (command.startsWith("shell monkey")) launches++;
        if (command === "shell dumpsys activity activities") return launches >= 2 ? webApkInFront : browserInFront;
        return "";
      },
      unlockKeyguard: async () => { events.push("unlock"); keyguard = false; },
      sleep: async milliseconds => { clock += milliseconds; },
      now: () => clock,
    });
    const home = events.indexOf("shell input keyevent KEYCODE_HOME");
    const launch = `shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`;
    expect(events[0]).toBe("shell input keyevent 224");
    expect(home).toBeGreaterThan(0);
    expect(events.indexOf("unlock")).toBeGreaterThan(0);
    expect(events.indexOf("keyguard:false")).toBeGreaterThan(events.indexOf("unlock"));
    expect(events.indexOf("shell dumpsys power")).toBeLessThan(home);
    expect(events.indexOf("unlock")).toBeLessThan(home);
    expect(events.indexOf("keyguard:false")).toBeLessThan(home);
    expect(home).toBeLessThan(events.indexOf(launch));
    expect(events.filter(event => event === launch)).toHaveLength(2);
  });

  test.each(["Asleep", "Keyguard"])("refuses a device still in %s before HOME or launch", async state => {
    const events: string[] = [];
    await expect(launchInstalledWebApk("SYNTHETIC-SMOKE-DEVICE", packageName, {
      command: async (...args) => {
        const command = args.join(" ");
        events.push(command);
        if (command === "shell dumpsys power") return `mWakefulness=${state === "Asleep" ? "Asleep" : "Awake"}`;
        if (command === "shell dumpsys window") return "isKeyguardShowing=true";
        if (command === "shell wm size") return "Physical size: 1080x2400";
        return "";
      },
      unlockKeyguard: async () => {},
      sleep: async () => {},
    })).rejects.toThrow(`Android display did not wake (observed ${state})`);
    expect(events).not.toContain("shell input keyevent KEYCODE_HOME");
    expect(events.some(event => event.startsWith("shell monkey"))).toBe(false);
  });

  test("a never-focused WebAPK stops at thirty seconds and retains only its last private focus evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "smoke-webapk-focus-"));
    const destination = join(root, "retained"), launchTimes: number[] = [];
    const finalBrowser = browserInFront.replace("ActivityRecord{1 ", "ActivityRecord{99 ");
    const capability = `#${"s".repeat(16)}.${"x".repeat(43)}`;
    let clock = 0;
    try {
      const error = await withSmokeDiagnostics(destination, () => awaitWebApkActiveTask(
        async () => `${clock < 30_000 ? browserInFront : finalBrowser}\nIntent: PAGE-CONTENT-NEVER-LOG ${capability}`,
        packageName,
        {
          launch: async () => { launchTimes.push(clock); },
          readDeviceState: async () => `mWakefulness=Awake\n  mWakefulness=Asleep\n  isKeyguardShowing=true\nWindow: PAGE-CONTENT-NEVER-LOG ${capability}`,
          sleep: async milliseconds => { clock += milliseconds; },
          now: () => clock,
        },
      ), []).catch(error => error);
      const evidence = `${finalBrowser.split("\n").map(line => line.trim()).join("\n")}\nmWakefulness=Asleep\nisKeyguardShowing=true`;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("installed WebAPK did not become the active standalone task");
      expect(error.cause).toBeInstanceOf(Error);
      expect(error.cause.message).toBe(evidence);
      expect(Buffer.byteLength(error.cause.message)).toBeLessThanOrEqual(4 * 768 + 3);
      expect(clock).toBe(30_000);
      expect(launchTimes).toEqual([0, 10_000]);
      const retained = await readFile(join(destination, "failure.json"), "utf8");
      expect(JSON.parse(retained).errors.some((entry: { message: string }) => entry.message === evidence)).toBe(true);
      for (const withheld of ["PAGE-CONTENT-NEVER-LOG", capability]) expect(retained).not.toContain(withheld);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("clips the last poll to its deadline and never re-launches after expiry", async () => {
    let clock = 0, launches = 0, reads = 0;
    const pauses: number[] = [];
    await expect(awaitWebApkActiveTask(async () => { reads++; return browserInFront; }, packageName, {
      launch: async () => { launches++; },
      readDeviceState: async () => deviceState,
      sleep: async milliseconds => { pauses.push(milliseconds); clock += milliseconds; },
      deadlineMs: 2_500,
      now: () => clock,
    })).rejects.toThrow("installed WebAPK did not become the active standalone task");
    expect(clock).toBe(2_500);
    expect(pauses).toEqual([1_000, 1_000, 500]);
    expect(reads).toBe(4);
    expect(launches).toBe(1);
  });

  test("counts launch time against the deadline and refuses a late focused read", async () => {
    let clock = 0, launches = 0;
    await expect(awaitWebApkActiveTask(async () => { clock = 30_001; return webApkInFront; }, packageName, {
      launch: async () => { launches++; clock += 9_000; },
      readDeviceState: async () => deviceState,
      sleep: async () => { throw new Error("late read must fail"); },
      now: () => clock,
    })).rejects.toThrow("installed WebAPK did not become the active standalone task");
    expect(launches).toBe(1);
  });

  test("withholds oversized or nonstructural focus fields instead of page content or capabilities", async () => {
    const capability = `${"s".repeat(16)}.${"x".repeat(43)}`;
    const error = await awaitWebApkActiveTask(async () => [
      `topResumedActivity=ActivityRecord{1 u0 com.android.chrome/${capability} t1}`,
      `topDisplayFocusedRootTask=Task{${"x".repeat(2_000)}}`,
      "Intent: PAGE-CONTENT-NEVER-LOG",
    ].join("\n"), packageName, {
      launch: async () => {},
      readDeviceState: async () => `mWakefulness=${"x".repeat(2_000)}\nisKeyguardShowing=false`,
      deadlineMs: 0,
      now: () => 0,
    }).catch(error => error);
    expect(error.cause.message).toBe([
      "topResumedActivity=[withheld]",
      "topDisplayFocusedRootTask=[withheld]",
      "mWakefulness=[withheld]",
      "isKeyguardShowing=false",
    ].join("\n"));
  });
});
