import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, setDefaultTimeout } from "bun:test";
import packageManifest from "../package.json";
import { HANG_DEADLINE_MS } from "./test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
}

const workflow = Bun.YAML.parse(await Bun.file(new URL("../.github/workflows/signed-release.yml", import.meta.url)).text()) as {
  jobs: { "build-attest-sign-release": { steps: WorkflowStep[] } };
};
const steps = workflow.jobs["build-attest-sign-release"].steps;

function runStep(name: string): string {
  const run = steps.find(step => step.name === name)?.run;
  if (run === undefined) throw new Error("missing workflow step: " + name);
  return run;
}

// Execute the shipped shell with controlled external-command fixtures, not ambient tools.
// Release policy and signature verification have their own behavioral suites.
async function exerciseGate(step: string, latest: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const root = await mkdtemp(join(tmpdir(), "omp-release-gate-"));
  try {
    for (const command of ["bash", "cat"]) {
      const executable = Bun.which(command);
      if (executable === null) throw new Error("missing shell fixture prerequisite: " + command);
      await symlink(executable, join(root, command));
    }
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.3.0" }));
    await writeFile(join(root, "STABLE_RELEASE.lock.json"), JSON.stringify({
      candidateTag: "v0.3.0-prealpha.3",
      candidateSourceCommit: "a".repeat(40),
      candidateArchiveSha256: "b".repeat(64),
      previousTag: "v0.2.1",
    }));
    const child = Bun.spawn(["bash", "-c", `
git() { if [ "$1" = rev-parse ]; then printf '%s\\n' "$GITHUB_SHA"; fi; }
bun() { if [ "$1" = scripts/release-policy.ts ]; then printf 'OMP_RELEASE_CHANNEL=stable\\n'; fi; }
jq() {
  [ "$1" = -er ] || return 92
  "$TEST_BUN" -e '
    const value = (await Bun.file(process.argv[2]).json())[process.argv[1].slice(1)];
    if (typeof value !== "string") process.exit(1);
    console.log(value);
  ' "$2" "$3"
}
gh() {
  if [ "$1" = api ]; then printf '%s\\n' "$TEST_LATEST";
  elif [ "$1 $2" = 'release view' ]; then printf 'sha256:%s\\n' "$TEST_DIGEST";
  elif [ "$1 $2" = 'release edit' ]; then printf 'PUBLICATION_EFFECT\\n';
  else return 91; fi
}
${runStep(step)}
`], {
      cwd: root,
      env: {
        ...process.env,
        PATH: root,
        TEST_BUN: process.execPath,
        RUNNER_TEMP: root,
        GITHUB_ENV: join(root, "github-env"),
        GITHUB_SHA: "a".repeat(40),
        GITHUB_REPOSITORY: "example/gateway",
        GITHUB_REF_NAME: "v0.3.0",
        RELEASE_IS_LATEST: "true",
        RELEASE_IS_PRERELEASE: "false",
        QUALIFIED_PREVIOUS_TAG: "v0.2.1",
        TEST_LATEST: latest,
        TEST_DIGEST: "b".repeat(64),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function emitCandidateNote(
  channel: "pre-alpha" | "alpha" | "beta",
  tag: string,
): Promise<{ code: number; note: string; stderr: string }> {
  const root = await mkdtemp(join(tmpdir(), "omp-release-notes-"));
  try {
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: packageManifest.packageManager }));
    // A fixed release text: this exercises the workflow's rendering, not the current release's prose,
    // which every prepare rewrites.
    await writeFile(
      join(root, "scripts/release-text.json"),
      await readFile(new URL("./fixtures/release-generate/v0.7.4.release-text.json", import.meta.url), "utf8"),
    );
    const child = Bun.spawn([
      "bash",
      "-c",
      `
gh() {
  if [ "$1 $2" = "release view" ]; then return 1;
  elif [ "$1 $2" = "release create" ]; then return 0;
  else return 91; fi
}
bun() { return 0; }
jq() {
  if [ "$2" = ".commit" ]; then printf "%s\n" "${"a".repeat(40)}";
  elif [ "$2" = ".tag" ]; then printf "%s\n" "v18.1.14";
  elif [ "$3" = "scripts/release-text.json" ] || [ "$3" = "package.json" ]; then command jq "$@";
  else return 92; fi
}
${runStep("Create complete draft release")}
`,
    ], {
      cwd: root,
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        GITHUB_SHA: "a".repeat(40),
        GITHUB_REPOSITORY: "example/gateway",
        GITHUB_REF_NAME: tag,
        OMP_RELEASE_CHANNEL: channel,
        PACKAGE_VERSION: "0.3.0",
        ARCHIVE_PATH: join(root, "archive.tar"),
        SBOM_PATH: join(root, "sbom.json"),
        CHECKSUM_PATH: join(root, "SHA256SUMS"),
        RELEASE_IS_PRERELEASE: "true",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    const note = await readFile(join(root, "release-notes.md"), "utf8");
    return { code, note, stderr };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test.skipIf(process.platform === "win32")("candidate channels emit one conservative channel-truthful note", async () => {
  const channels = [
    ["alpha", "v0.3.0-alpha.1"],
    ["beta", "v0.3.0-beta.1"],
    ["pre-alpha", "v0.3.0-prealpha.1"],
  ] as const;
  const normalizedNotes: string[] = [];
  for (const [channel, tag] of channels) {
    const emitted = await emitCandidateNote(channel, tag);
    expect(emitted.code, emitted.stderr).toBe(0);
    expect(emitted.note).toContain(`## Engineering candidate (${channel} channel)`);
    expect(emitted.note).toContain(`This is a signed ${channel} build from current development source.`);
    expect(emitted.note).toContain(`- Runtime: Bun ${packageManifest.packageManager.replace(/^bun@/u, "")};`);
    expect(emitted.note).toContain("Historical platform evidence does not transfer.");
    expect(emitted.note).not.toContain("qualified for two hosts and one client");
    expect(emitted.note).not.toContain("last qualified against signed candidate");
    expect(emitted.note).not.toContain("reinstall the signed `v0.2.0` archive");
    normalizedNotes.push(
      emitted.note
        .replace(`Engineering candidate (${channel} channel)`, "Engineering candidate (CHANNEL channel)")
        .replace(`signed ${channel} build`, "signed CHANNEL build"),
    );
  }
  expect(new Set(normalizedNotes).size).toBe(1);
});

test.skipIf(process.platform === "win32")("stable admission accepts the qualified current predecessor, not a hardcoded release", async () => {
  const accepted = await exerciseGate("Validate signed release tag and derive its channel", "v0.2.1");
  expect(accepted.code, accepted.stderr).toBe(0);
  const stale = await exerciseGate("Validate signed release tag and derive its channel", "v0.2.2");
  expect(stale.code).not.toBe(0);
  expect(stale.stderr).toContain("Qualified rollback predecessor must match GitHub Latest");
});

test.skipIf(process.platform === "win32")("stable publication refuses predecessor drift before changing GitHub Latest", async () => {
  const drifted = await exerciseGate("Publish release once", "v0.2.2");
  expect(drifted.code).not.toBe(0);
  expect(drifted.stdout).not.toContain("PUBLICATION_EFFECT");
  const accepted = await exerciseGate("Publish release once", "v0.2.1");
  expect(accepted.code, accepted.stderr).toBe(0);
  expect(accepted.stdout).toContain("PUBLICATION_EFFECT");
});
