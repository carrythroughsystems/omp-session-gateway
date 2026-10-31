import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, setDefaultTimeout } from "bun:test";
import deletionResponses from "./fixtures/digitalocean-delete-tag-removal.json";
import { HANG_DEADLINE_MS } from "../apps/gateway/test/test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

const PROVIDER_TEST_TOKEN = "synthetic-provider-credential-not-real";
const PROVIDER_DROPLET = {
  id: 4242,
  name: "omp-gateway-qual",
  tags: ["omp-gateway-qual"],
  created_at: "2026-01-01T00:00:00Z",
  status: "active",
  networks: { v4: [{ type: "public", ip_address: "192.0.2.42" }] },
};

async function dropletHarness(scenario: Record<string, unknown>, bound = false, droplet = PROVIDER_DROPLET) {
  const home = await mkdtemp(join(tmpdir(), "omp-droplet-presence-"));
  const bin = join(home, "bin");
  const state = join(home, "state", "omp-session-gateway-qual");
  const stateFile = join(state, "omp-gateway-qual.json");
  const evidenceRoot = join(home, "evidence");
  await Promise.all([mkdir(bin), mkdir(state, { recursive: true })]);
  await writeFile(join(home, "scenario.json"), JSON.stringify(scenario));
  if (bound) {
    await writeFile(stateFile, JSON.stringify({ droplet_id: String(droplet.id) }));
    await writeFile(join(home, "created"), "");
  }
  await writeFile(
    join(bin, "doctl"),
    `#!/bin/bash
case "$*" in
  "auth token") printf '%s\\n' "$PROVIDER_TEST_TOKEN" ;;
  "compute droplet list --format Name --no-header")
    if [ -f "$PROVIDER_FIXTURE/created" ] && [ ! -f "$PROVIDER_FIXTURE/deleted" ]; then
      printf 'omp-gateway-qual\\n'
    fi ;;
  *) exit 91 ;;
esac
`,
    { mode: 0o700 },
  );
  await writeFile(
    join(bin, "curl"),
    String.raw`#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const root = process.env.PROVIDER_FIXTURE;
const scenario = JSON.parse(readFileSync(root + "/scenario.json", "utf8"));
const args = process.argv.slice(2);
const config = await Bun.stdin.text();
if (config !== 'header = "Authorization: Bearer ' + process.env.PROVIDER_TEST_TOKEN + '"\n') process.exit(92);
const method = args[args.indexOf("--request") + 1];
const url = args.at(-1);
const calls = existsSync(root + "/calls.json") ? JSON.parse(readFileSync(root + "/calls.json", "utf8")) : [];
const stateFile = root + "/state/omp-session-gateway-qual/omp-gateway-qual.json";
calls.push({method, url, args, savedId: existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")).droplet_id : null});
writeFileSync(root + "/calls.json", JSON.stringify(calls));
const droplet = JSON.parse(process.env.PROVIDER_DROPLET);
let status, body;
if (method === "GET" && url.includes("/droplets?")) {
  status = scenario.listStatus ?? 200;
  body = scenario.listBody ?? {droplets: [], links: {}};
} else if (method === "POST" && url.endsWith("/droplets")) {
  status = scenario.createStatus ?? 202;
  body = scenario.createBody ?? {droplet: {...droplet, networks: null}};
  if (status === 202) writeFileSync(root + "/created", "");
  const bodyPath = args[args.indexOf("--data-binary") + 1].slice(1);
  const request = JSON.parse(readFileSync(bodyPath, "utf8"));
  if (request.name !== droplet.name || request.tags[0] !== droplet.name || request.ssh_keys[0] !== 4242) process.exit(93);
} else if (url.endsWith("/droplets/" + droplet.id) && method === "GET") {
  if (existsSync(root + "/deleted")) {
    const deletion = calls.findLastIndex(call => call.method === "DELETE");
    const reads = calls.slice(deletion + 1).filter(call => call.method === "GET").length;
    body = scenario.afterDeleteBodies?.[reads - 1];
    status = body === undefined ? 404 : 200;
    body ??= {id: "not_found"};
  } else {
    status = scenario.getStatus ?? 200;
    const reads = calls.filter(call => call.method === "GET" && call.url.endsWith("/droplets/" + droplet.id)).length;
    body = scenario.getBodies?.[Math.min(reads - 1, scenario.getBodies.length - 1)] ?? {droplet};
  }
} else if (url.endsWith("/droplets/" + droplet.id) && method === "DELETE") {
  status = scenario.deleteStatus ?? 204;
  body = status === 204 ? "" : {message: "synthetic delete response"};
  if (status === 204 || status === 404) writeFileSync(root + "/deleted", "");
} else {
  process.exit(94);
}
if (scenario.echoCredential) body = {message: process.env.PROVIDER_TEST_TOKEN};
process.stdout.write((typeof body === "string" ? body : JSON.stringify(body)) + "\n" + status);
process.exit(scenario.transportExit ?? 0);
`,
    { mode: 0o700 },
  );
  const run = async (command: string, storedCredential = false, extra = "") => {
    const harness = `
source "$1"
preflight_tools() { :; }
preflight_ssh_key() { :; }
preflight_catalog() { HOURLY_RATE=0.0625; }
size_hourly_rate() { printf 0.0625; }
ssh_is_up() { return 0; }
cloud_init_done() { return 0; }
remote_root() { cat >/dev/null; }
provision_init_facts() { :; }
report_imported_images() { :; }
sleep() { SECONDS=$((SECONDS + $1)); }
${extra}
main "$2"
`;
    const child = Bun.spawn(
      ["/bin/bash", "-c", harness, "test", join(REPOSITORY_ROOT, "scripts/provision-linux-qual.sh"), command],
      {
        cwd: REPOSITORY_ROOT,
        env: {
          ...process.env,
          HOME: home,
          XDG_STATE_HOME: join(home, "state"),
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          OMP_QUAL_NAME: "omp-gateway-qual",
          OMP_QUAL_INIT: "openrc",
          OMP_QUAL_SSH_KEY_ID: "4242",
          OMP_QUAL_EVIDENCE_DIR: evidenceRoot,
          DIGITALOCEAN_ACCESS_TOKEN: storedCredential ? "" : PROVIDER_TEST_TOKEN,
          PROVIDER_TEST_TOKEN,
          PROVIDER_FIXTURE: home,
          PROVIDER_DROPLET: JSON.stringify(droplet),
          TS_AUTHKEY: "",
          TS_API_KEY: "",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  };
  return {
    home,
    stateFile,
    run,
    calls: async () =>
      (await Bun.file(join(home, "calls.json")).json()) as {
        method: string;
        url: string;
        args: string[];
        savedId: string | null;
      }[],
    evidence: async () => {
      const contents: string[] = [];
      for await (const path of new Bun.Glob("**/*").scan({ cwd: evidenceRoot, onlyFiles: true })) {
        contents.push(await Bun.file(join(evidenceRoot, path)).text());
      }
      return contents.join("\n");
    },
    dispose: () => rm(home, { recursive: true, force: true }),
  };
}

test.skipIf(process.platform === "win32")("droplet create id survives null networks and binds readiness and deletion", async () => {
  const fixture = await dropletHarness({
    getBodies: [
      { droplet: { ...PROVIDER_DROPLET, networks: null } },
      { droplet: { ...PROVIDER_DROPLET, networks: { v4: null } } },
      { droplet: PROVIDER_DROPLET },
    ],
  });
  try {
    const provision = await fixture.run("provision", true);
    expect(provision.exitCode).toBe(0);
    expect(await Bun.file(fixture.stateFile).json()).toEqual({ droplet_id: "4242" });
    const reads = (await fixture.calls()).filter(call => call.url.endsWith("/droplets/4242"));
    expect(reads).toHaveLength(3);
    expect(reads.every(call => call.savedId === "4242")).toBe(true);
    expect(provision.stdout).toContain("192.0.2.42");
    const destroy = await fixture.run("destroy");
    expect(destroy.exitCode).toBe(0);
    expect(destroy.stdout).toContain("id 4242 confirmed absent (HTTP 404)");
    expect(await Bun.file(fixture.stateFile).exists()).toBe(false);
    const calls = await fixture.calls();
    expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
    expect(calls.filter(call => call.method === "DELETE").map(call => call.url)).toEqual([
      "https://api.digitalocean.com/v2/droplets/4242",
    ]);
    const evidence = await fixture.evidence();
    for (const status of ["200", "202", "204", "404"]) expect(evidence).toContain(`"http_status": "${status}"`);
    expect(evidence).toContain('"networks":null');
    expect(evidence + JSON.stringify(calls) + provision.stdout + provision.stderr + destroy.stdout + destroy.stderr)
      .not.toContain(PROVIDER_TEST_TOKEN);
  } finally {
    await fixture.dispose();
  }
});

test.skipIf(process.platform === "win32")("IPv4 readiness exhaustion retains the create id and still permits exact-id cleanup", async () => {
  const fixture = await dropletHarness({ getBodies: [{ droplet: { ...PROVIDER_DROPLET, networks: null } }] });
  try {
    const provision = await fixture.run("provision");
    expect(provision.exitCode).toBe(1);
    expect(provision.stderr).toContain("did not become active with public IPv4 within 150s");
    expect(await Bun.file(fixture.stateFile).json()).toEqual({ droplet_id: "4242" });
    const reads = (await fixture.calls()).filter(call => call.url.endsWith("/droplets/4242"));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.length).toBeLessThanOrEqual(30);
    expect((await fixture.run("destroy")).exitCode).toBe(0);
    expect(await fixture.evidence()).toContain('"http_status": "202"');
  } finally {
    await fixture.dispose();
  }
}, 2 * HANG_DEADLINE_MS);

test.skipIf(process.platform === "win32")("incomplete create metadata cannot discard the returned cleanup id", async () => {
  const fixture = await dropletHarness({ createBody: { droplet: { ...PROVIDER_DROPLET, tags: null } } });
  try {
    const provision = await fixture.run("provision");
    expect(provision.exitCode).toBe(1);
    expect(provision.stderr).toContain("identity does not match");
    expect(await Bun.file(fixture.stateFile).json()).toEqual({ droplet_id: "4242" });
    expect(await fixture.evidence()).toContain('"tags":null');
    // Later GET metadata must prove the bound name/tag before the exact-id cleanup can proceed.
    expect((await fixture.run("destroy")).exitCode).toBe(0);
  } finally {
    await fixture.dispose();
  }
});

for (const [name, scenario, bound, reason] of [
  ["malformed list", { listBody: { droplets: null } }, false, "list is malformed"],
  ["unbound tag", { listBody: { droplets: [PROVIDER_DROPLET] } }, false, "refusing adoption or deletion"],
  ["malformed get", { getBodies: ["not json"] }, true, "response is malformed"],
  ["HTTP read error", { getStatus: 503 }, true, "HTTP 503, not absence"],
  ["identity mismatch", { getBodies: [{ droplet: { ...PROVIDER_DROPLET, id: 9999 } }] }, true, "identity does not match"],
  ["missing ownership tag", { getBodies: [{ droplet: { ...PROVIDER_DROPLET, tags: [] } }] }, true, "identity does not match"],
  ["transport error", { transportExit: 28 }, true, "transport failed"],
] as const) {
  test.skipIf(process.platform === "win32")(`droplet ${name} cannot turn into absence or a delete`, async () => {
    const fixture = await dropletHarness(scenario, bound);
    try {
      const result = await fixture.run("destroy");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(reason);
      expect(result.stdout).not.toContain("already absent");
      expect((await fixture.calls()).some(call => call.method === "DELETE")).toBe(false);
      expect(await Bun.file(fixture.stateFile).exists()).toBe(bound);
      expect(await fixture.evidence()).toContain('"http_status"');
    } finally {
      await fixture.dispose();
    }
  });
}

// Run 39874213716 retained these credential-free GET bodies around an accepted DELETE.
// Network addresses use non-identifying examples; identity fields and the tag-removal delta are unchanged.
test.skipIf(process.platform === "win32")("accepted droplet deletion tolerates tag removal until exact-id 404", async () => {
  const fixture = await dropletHarness({
    getBodies: [deletionResponses.before],
    afterDeleteBodies: [deletionResponses.after],
  }, true, deletionResponses.before.droplet);
  try {
    const result = await fixture.run("destroy");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("id 611742709 confirmed absent (HTTP 404)");
    expect(await Bun.file(fixture.stateFile).exists()).toBe(false);
    expect((await fixture.calls()).map(({ method, url }) => ({ method, url }))).toEqual(
      ["GET", "DELETE", "GET", "GET"].map(method => ({
        method, url: "https://api.digitalocean.com/v2/droplets/611742709",
      })),
    );
    expect(await fixture.evidence()).toContain('"tags":[]');
  } finally {
    await fixture.dispose();
  }
});

for (const [name, body] of [
  ["id", { droplet: { ...deletionResponses.after.droplet, id: 9999 } }],
  ["name", { droplet: { ...deletionResponses.after.droplet, name: "foreign-droplet" } }],
] as const) {
  test.skipIf(process.platform === "win32")(`accepted droplet deletion still refuses a changed ${name}`, async () => {
    const fixture = await dropletHarness({
      getBodies: [deletionResponses.before], afterDeleteBodies: [body],
    }, true, deletionResponses.before.droplet);
    try {
      const result = await fixture.run("destroy");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("identity does not match");
      expect(await Bun.file(fixture.stateFile).exists()).toBe(true);
      expect((await fixture.calls()).map(call => call.method)).toEqual(["GET", "DELETE", "GET"]);
    } finally {
      await fixture.dispose();
    }
  });
}

test.skipIf(process.platform === "win32")("accepted droplet deletion still requires final HTTP 404", async () => {
  const fixture = await dropletHarness({
    getBodies: [deletionResponses.before],
    afterDeleteBodies: Array(40).fill(deletionResponses.after),
  }, true, deletionResponses.before.droplet);
  try {
    const result = await fixture.run("destroy");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("has not returned HTTP 404 after 150s");
    expect(await Bun.file(fixture.stateFile).exists()).toBe(true);
    expect((await fixture.calls()).filter(call => call.method === "DELETE")).toHaveLength(1);
  } finally {
    await fixture.dispose();
  }
}, 2 * HANG_DEADLINE_MS);

for (const status of [204, 404, 500]) {
  test.skipIf(process.platform === "win32")(`droplet DELETE HTTP ${status} determines teardown disposition`, async () => {
    const fixture = await dropletHarness({ deleteStatus: status }, true);
    try {
      const result = await fixture.run("destroy");
      expect(result.exitCode).toBe(status === 500 ? 1 : 0);
      expect(await Bun.file(fixture.stateFile).exists()).toBe(status === 500);
      expect(await fixture.evidence()).toContain(`"http_status": "${status}"`);
      if (status === 500) {
        expect(result.stderr).toContain("delete for 4242 returned HTTP 500");
        expect(result.stdout).toContain("STILL RUNNING AND STILL BILLING");
      }
    } finally {
      await fixture.dispose();
    }
  });
}

test.skipIf(process.platform === "win32")("a valid empty list and an exact-id 404 are real absence, not permission to create again", async () => {
  const empty = await dropletHarness({});
  const missing = await dropletHarness({ getStatus: 404, deleteStatus: 404 }, true);
  try {
    expect((await empty.run("destroy")).exitCode).toBe(0);
    expect((await empty.calls()).map(call => call.method)).toEqual(["GET"]);
    const provision = await missing.run("provision");
    expect(provision.exitCode).toBe(1);
    expect(provision.stderr).toContain("reconcile it before provisioning again");
    expect((await missing.calls()).some(call => call.method === "POST")).toBe(false);
    expect((await missing.run("destroy")).exitCode).toBe(0);
    expect(await Bun.file(missing.stateFile).exists()).toBe(false);
  } finally {
    await Promise.all([empty.dispose(), missing.dispose()]);
  }
});

test.skipIf(process.platform === "win32")("provider error evidence removes an echoed credential before persistence", async () => {
  const fixture = await dropletHarness({ getStatus: 503, echoCredential: true }, true);
  try {
    const result = await fixture.run("destroy");
    expect(result.exitCode).toBe(1);
    const evidence = await fixture.evidence();
    expect(evidence).toContain("[REDACTED_CREDENTIAL]");
    expect(evidence + result.stdout + result.stderr + JSON.stringify(await fixture.calls())).not.toContain(PROVIDER_TEST_TOKEN);
  } finally {
    await fixture.dispose();
  }
});

test.skipIf(process.platform === "win32")("the billing reminder cannot leave a destroy command green", async () => {
  const fixture = await dropletHarness({}, true);
  try {
    const result = await fixture.run("destroy", false, "cmd_destroy() { DESTROY_REQUESTED=1; return 0; }");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("STILL RUNNING AND STILL BILLING");
  } finally {
    await fixture.dispose();
  }
});

test.skipIf(process.platform === "win32")("rollback refuses a non-private predecessor config before service operations", async () => {
  const home = await mkdtemp(join(tmpdir(), "omp-rollback-config-private-"));
  const state = join(home, ".local", "state", "omp-session-gateway");
  const backup = join(state, "pre-mainline-config.json");
  const bin = join(home, "bin");
  const managerMarker = join(home, "service-touched");
  await Promise.all([mkdir(state, { recursive: true }), mkdir(bin)]);
  await writeFile(backup, '{"http":{"port":47419}}', { mode: 0o644 });
  // `mode` is filtered by the umask; a 077 umask would silently make the backup private.
  await chmod(backup, 0o644);
  await writeFile(join(home, "runtime-root"), "unused");
  await writeFile(join(bin, "systemctl"), '#!/bin/sh\ntouch "$MANAGER_MARKER"\nexit 90\n', { mode: 0o700 });
  const harness = `
source "$1"
require_dns_name() { printf qual.example.invalid; }
remote_user() { env "$@" bash -se; }
if [ "$(uname -s)" = Darwin ]; then
  stat() { /usr/bin/stat -f '%Lp' "\${@: -1}"; }
  export -f stat
fi
lane_rollback
`;
  try {
    const child = Bun.spawn(["/bin/bash", "-c", harness, "test", join(REPOSITORY_ROOT, "scripts/provision-linux-qual.sh")], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, MANAGER_MARKER: managerMarker },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("predecessor config backup private");
    expect(await Bun.file(managerMarker).exists()).toBe(false);
    expect(await Bun.file(backup).text()).toBe('{"http":{"port":47419}}');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "fresh NeedsLogin state uses bounded login rather than up",
  async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-tailnet-login-test-"));
    const localTemp = join(temporaryRoot, "local");
    const remoteTemp = join(temporaryRoot, "remote");
    const bin = join(temporaryRoot, "bin");
    const argsPath = join(temporaryRoot, "tailscale-args");
    await Promise.all([mkdir(localTemp), mkdir(remoteTemp), mkdir(bin)]);
    const fakeTailscale = join(bin, "tailscale");
    await writeFile(
      fakeTailscale,
      `#!/bin/bash
set -euo pipefail
echo "$*" >"$TEST_ARGS"
[ "$1" = login ]
auth_file=""
for argument in "$@"; do
  case "$argument" in --auth-key=file:*) auth_file="$(echo "$argument" | sed 's/^--auth-key=file://')" ;; esac
done
[ -s "$auth_file" ]
[ "$(cat "$auth_file")" = "$EXPECTED_KEY" ]
`,
    );
    await chmod(fakeTailscale, 0o700);

    const harness = `
set -euo pipefail
source "$1"
local_tmp="$2"
remote_tmp="$3"
LOCAL_TEMP="$local_tmp"
DROPLET_IP=synthetic
TS_AUTHKEY=tskey-auth-test-secret
SSH_OPTS=(-o synthetic)
export TEST_ARGS="$4"
export EXPECTED_KEY="$TS_AUTHKEY"
ssh() {
  case "$*" in
    *"cat > /root/.ts-authkey"*) umask 077; cat >"$remote_tmp/authkey" ;;
    *"rm -f /root/.ts-authkey"*) rm -f "$remote_tmp/authkey" ;;
    *) return 1 ;;
  esac
}
remote_root() {
  local script
  script="$(cat)"
  script="$(echo "$script" | sed "s#/root/.ts-authkey#$remote_tmp/authkey#g")"
  PATH="$local_tmp/../bin:$PATH" bash -c "$script"
}
join_tailnet
test ! -e "$local_tmp/authkey"
test ! -e "$remote_tmp/authkey"
grep -q '^login ' "$TEST_ARGS"
grep -q -- '--auth-key=file:' "$TEST_ARGS"
grep -q -- '--timeout=120s' "$TEST_ARGS"
`;
    try {
      const child = Bun.spawn(
        ["/bin/bash", "-c", harness, "test", join(REPOSITORY_ROOT, "scripts/provision-linux-qual.sh"), localTemp, remoteTemp, argsPath],
        { cwd: REPOSITORY_ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      expect(await Bun.file(argsPath).text()).toStartWith("login ");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")("zero-input remote framing executes the supplied script", async () => {
  const harness = `
set -euo pipefail
source "$1"
DROPLET_IP=synthetic
SSH_OPTS=(-o synthetic)
ssh() {
  local command="" argument
  for argument in "$@"; do command="$argument"; done
  eval "$command"
}
remote_root <<'REMOTE'
printf zero-input-script-ran
REMOTE
`;
  const child = Bun.spawn(
    ["/bin/bash", "-c", harness, "test", join(REPOSITORY_ROOT, "scripts/provision-linux-qual.sh")],
    { cwd: REPOSITORY_ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toEqual({
    exitCode: 0,
    stdout: "zero-input-script-ran",
    stderr: "",
  });
});

test.skipIf(process.platform === "win32")(
  "release metadata distinguishes installed runtimes with identical CLIs",
  async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-runtime-identity-test-"));
    const predecessorRoot = join(temporaryRoot, "predecessor");
    const candidateRoot = join(temporaryRoot, "candidate");
    const versionsRoot = join(temporaryRoot, "versions");
    const predecessorVersion = join(versionsRoot, "0.1.0-predecessor");
    const candidateVersion = join(versionsRoot, "0.1.0-candidate");
    const predecessorInfo = '{"sourceCommit":"predecessor"}\n';
    const candidateInfo = '{"sourceCommit":"candidate"}\n';
    const cliRelative = join("apps", "gateway", "src", "cli.js");
    for (const directory of [predecessorRoot, candidateRoot, predecessorVersion, candidateVersion]) {
      await mkdir(join(directory, "apps", "gateway", "src"), { recursive: true });
      await writeFile(join(directory, cliRelative), "identical-cli-bytes");
    }
    await Promise.all([
      writeFile(join(predecessorRoot, "release-info.json"), predecessorInfo),
      writeFile(join(predecessorVersion, "release-info.json"), predecessorInfo),
      writeFile(join(candidateRoot, "release-info.json"), candidateInfo),
      writeFile(join(candidateVersion, "release-info.json"), candidateInfo),
    ]);
    const run = async (archiveRoot: string) => {
      const child = Bun.spawn(
        [
          "/bin/bash",
          "-c",
          'source "$1"; identify_version_by_release_info "$2" "$3"',
          "test",
          join(REPOSITORY_ROOT, "scripts/provision-linux-qual.sh"),
          archiveRoot,
          versionsRoot,
        ],
        { cwd: REPOSITORY_ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    };
    try {
      expect(await run(predecessorRoot)).toEqual({
        exitCode: 0,
        stdout: "0.1.0-predecessor",
        stderr: "",
      });
      expect(await run(candidateRoot)).toEqual({
        exitCode: 0,
        stdout: "0.1.0-candidate",
        stderr: "",
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "SSH key preflight waits out DigitalOcean read-after-create lag, but only for a bounded window",
  async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "omp-key-consistency-"));
    const bin = join(temporaryRoot, "bin");
    const identity = join(temporaryRoot, "id_ed25519");
    const calls = join(temporaryRoot, "doctl-calls");
    await mkdir(bin);
    expect(Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", identity]).exitCode).toBe(0);
    const fingerprint = Bun.spawnSync(["ssh-keygen", "-l", "-E", "md5", "-f", `${identity}.pub`])
      .stdout.toString()
      .split(/\s+/u)[1]
      ?.replace(/^MD5:/u, "");
    // Stands in for DigitalOcean serving a freshly created key as "not found" for a while.
    await writeFile(
      join(bin, "doctl"),
      `#!/bin/bash
count=$(( $(cat "$DOCTL_CALLS" 2>/dev/null || echo 0) + 1 ))
echo "$count" >"$DOCTL_CALLS"
if [ "$count" -lt "$DOCTL_READABLE_AT" ]; then
  echo 'Error: GET https://api.digitalocean.com/v2/account/keys/4242: 404 The resource you were accessing could not be found.' >&2
  exit 1
fi
printf '[{"id":4242,"name":"omp-qual-ci-test-1","fingerprint":"%s"}]\\n' "$KEY_FINGERPRINT"
`,
      { mode: 0o700 },
    );
    const run = async (readableAt: number) => {
      await rm(calls, { force: true });
      const child = Bun.spawn(
        ["/bin/bash", "-c", 'source "$1"; sleep() { :; }; preflight_ssh_key', "test", join(REPOSITORY_ROOT, "scripts/provision-linux-qual.sh")],
        {
          cwd: REPOSITORY_ROOT,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            OMP_QUAL_SSH_KEY_ID: "4242",
            OMP_QUAL_SSH_IDENTITY: identity,
            DOCTL_CALLS: calls,
            DOCTL_READABLE_AT: String(readableAt),
            KEY_FINGERPRINT: fingerprint ?? "",
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr, reads: Number.parseInt(await Bun.file(calls).text(), 10) };
    };
    try {
      // Readable only on the eighth read, past the former five-read window.
      const lagged = await run(8);
      expect(lagged.exitCode).toBe(0);
      expect(lagged.stdout).toContain("matching local private key");
      expect(lagged.reads).toBe(8);

      const absent = await run(1_000);
      expect(absent.exitCode).toBe(1);
      expect(absent.stderr).toContain("did not resolve after 11 attempts");
      expect(absent.stderr).toContain("404 The resource you were accessing could not be found.");
      expect(absent.reads).toBe(11);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);
