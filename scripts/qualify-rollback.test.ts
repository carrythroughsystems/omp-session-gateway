import { createHash } from "node:crypto";
import { expect, test, setDefaultTimeout } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseVersion } from "./release-policy.ts";
import { HANG_DEADLINE_MS } from "../apps/gateway/test/test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

const POSIX = process.platform !== "win32";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test.skipIf(!POSIX)("failed publisher retirement never prints credential fingerprints", async () => {
  const fingerprint = "synthetic-publisher-fingerprint-must-not-be-printed";
  const harness = `
source "$1"
STEP_POINTER=(old new old)
STEP_CONFIG=(config config config)
STEP_TOKEN=(absent readiness readiness)
STEP_TOKEN_MODE=(absent 600 600)
STEP_PUBLISHER=("$2" "$2" reminted)
STEP_PLIST=(old new old)
INSTALL_EXPECTED=old
UPGRADE_EXPECTED=new
VERSION_COUNT_AFTER_UPGRADE=2
PREDECESSOR_AFTER_UPGRADE=present
ISO_CONFIG_JSON=/unused/config.json
mode_of() { printf 600; }
step_invariants
[ "$FAILURES" -gt 0 ]
`;
  const child = Bun.spawn(["/bin/bash", "-c", harness, "test", join(repositoryRoot, "scripts/qualify-rollback.sh"), fingerprint], {
    cwd: repositoryRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("FAIL");
  expect(stdout + stderr).not.toContain(fingerprint);
});

test.skipIf(!POSIX)("rollback cleanup succeeds when no LaunchAgent is loaded", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-rollback-clean-test-"));
  const qualificationRoot = join(temporaryRoot, "qualification");
  await mkdir(join(qualificationRoot, "stale-run"), { recursive: true });

  try {
    const child = Bun.spawn(["/bin/bash", "scripts/qualify-rollback.sh", "clean"], {
      cwd: repositoryRoot,
      env: { ...process.env, OMP_ROLLBACK_QUAL_BASE: qualificationRoot },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(`${qualificationRoot} removed`);
    expect(await Bun.file(qualificationRoot).exists()).toBe(false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test.skipIf(!POSIX).each([
  [false, "v0.2.0-prealpha.1", "alphastorm", true],
  [true, "v0.2.0-prealpha.1", "alphastorm", true],
  [false, "v0.7.6", "carrythroughsystems", true],
  [false, "v0.7.6", "alphastorm", false],
  [false, "v0.7.5-prealpha.3", "alphastorm", false],
] as const)("rollback verifies preloaded assets: staged=%s tag=%s signer=%s accepted=%s", async (staged, tag, owner, accepted) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-rollback-preload-test-"));
  const artifactRoot = join(temporaryRoot, "artifacts");
  const tagRoot = join(artifactRoot, tag);
  const destination = join(temporaryRoot, "destination");
  const bin = join(temporaryRoot, "bin");
  const archiveName = `omp-session-gateway-${releaseVersion(tag)}-bun.tar`;
  const archive = Buffer.alloc(1024);
  const archiveDigest = createHash("sha256").update(archive).digest("hex");
  const ghMarker = join(temporaryRoot, "gh-called");
  const stagedCosign = join(temporaryRoot, "staged cosign");
  const cosign = `#!/bin/bash
identity="" issuer=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --certificate-identity) identity="$2"; shift ;;
    --certificate-oidc-issuer) issuer="$2"; shift ;;
  esac
  shift
done
[ "$identity" = "https://github.com/${owner}/omp-session-gateway/.github/workflows/signed-release.yml@refs/tags/${tag}" ] &&
  [ "$issuer" = "https://token.actions.githubusercontent.com" ]
`;
  await Promise.all([mkdir(tagRoot, { recursive: true }), mkdir(bin)]);
  await Promise.all([
    writeFile(join(tagRoot, archiveName), archive),
    writeFile(join(tagRoot, `${archiveName}.sigstore.json`), "synthetic bundle"),
    writeFile(join(tagRoot, "SHA256SUMS"), `${archiveDigest}  ${archiveName}\n`),
    writeFile(join(tagRoot, "SHA256SUMS.sigstore.json"), "synthetic bundle"),
    writeFile(join(bin, "cosign"), staged ? "#!/bin/bash\nexit 99\n" : cosign),
    writeFile(stagedCosign, cosign, { mode: 0o700 }),
    writeFile(join(bin, "gh"), `#!/bin/bash\ntouch "${ghMarker}"\nexit 99\n`),
  ]);
  await Promise.all([chmod(join(bin, "cosign"), 0o700), chmod(join(bin, "gh"), 0o700)]);

  try {
    const child = Bun.spawn(
      ["/bin/bash", "-c", 'source "$1"; fetch_tag "$2" "$3"', "test", join(repositoryRoot, "scripts/qualify-rollback.sh"), tag, destination],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          OMP_ROLLBACK_ARTIFACT_ROOT: artifactRoot,
          OMP_ROLLBACK_COSIGN: staged ? stagedCosign : undefined,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(accepted ? 0 : 2);
    if (accepted) expect(stderr).toBe("");
    else expect(stderr).toContain("verification failed");
    expect(await Bun.file(ghMarker).exists()).toBe(false);
    expect(await Bun.file(join(destination, archiveName)).exists()).toBe(true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
