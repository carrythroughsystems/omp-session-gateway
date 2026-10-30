#!/usr/bin/env bash
#
# macOS host qualification against a signed candidate, over SSH, from a second tailnet node.
#
# WHY THIS EXISTS
#
# The Linux lane (`scripts/provision-linux-qual.sh`) is one command that provisions, measures and
# destroys, and it emits every number the ledger needs. macOS had no equivalent: the 2026-08-21
# re-qualification of `provenance-test-v0.1.0.11` was driven by hand over about twenty SSH
# invocations, which means the next candidate could only be re-qualified by someone repeating those
# by hand and trusting prose. This script is that run, written down.
#
# It deliberately does *not* provision the host. Apple silicon leases are 24-hour minimum, billed
# whether or not the machine is powered on, and no provider API here can be trusted to hand back an
# identical image; conflating "rent a Mac" with "measure a Mac" would make the measurement hostage to
# the provider. Bring your own host, point this at it.
#
# WHAT THE HOST MUST ALREADY HAVE
#
#   - SSH as a non-root standard or admin account with automatic console login after reboot.
#     On bare metal, automatic login requires FileVault off.
#   - sudo for the exact lane commands, either narrow passwordless grants (sudo -n) or a password
#     supplied out of band through OMP_MAC_SUDO_PW. No administrator membership is required.
#   - The pinned Bun in ~/.bun/bin and the lane's tools on PATH for that user.
#     Remote blocks use a fixed system/admin-first PATH, including /opt/homebrew/bin, before
#     the account's Bun and Go tools; hardware is measured with /usr/sbin/sysctl.
#   - Stock OMP >=18.1.20 on that PATH, required by doctor's compatibility check before omp-build.
#     Install the coding-agent package version pinned in UPSTREAM.lock.json with
#     bun add --global --exact @oh-my-pi/pi-coding-agent@<pin> as the qualification account.
#   - Tailscale running its **TUN-mode** client, joined as a **user-owned** node.
#
# That last requirement is the whole reason the earlier attempt failed, and the correction is worth
# stating because it cost a release delay. `tailscaled --tun=userspace-networking` has no tunnel
# device, so its netstack forwards inbound tailnet connections to localhost and every tailnet peer
# reaches the loopback listener as a loopback peer; the gateway detects that and refuses everything,
# so `doctor` cannot pass and nothing here can be qualified. The NetworkExtension approval a *GUI*
# Tailscale client needs does **not** apply to open-source `tailscaled`, which creates a real `utun`
# as root on a headless host:
#
#   sudo tailscaled --tun=utun --state=/var/lib/tailscale/tailscaled.state
#   sudo tailscale login          # click the printed URL; a user-owned node, not a tagged one
#   sudo tailscaled install-system-daemon    # so it survives the reboot lane
#
# A tagged node cannot present a user identity, so Serve populates no identity headers and the
# identity lane would measure nothing. That is the opposite of the Linux lane, which *wants* a tagged
# node to prove denial.
#
# WHAT THE HOST MAY HAVE
#
#   - Optional host-owned ~/.config/omp-qualification/reboot-guard: a regular, owner-executable
#     file whose presence, type and owner-execute bit are checked without running it at preflight.
#     It runs without arguments on the fixed remote PATH only at the owned pre-reboot gate.
#     Exit zero only when reboot is safe; otherwise explain why and exit nonzero. The first 400
#     output bytes are reported on refusal. The guard should be a prompt, read-only workload check.
#
# CERTIFICATES, AND A TRAP WORTH INHERITING
#
# Never probe `https://<name>` to find out whether Serve is ready. Each TLS handshake without a
# cached certificate triggers an ACME authorization, and five failures lock that exact name out of
# Let's Encrypt for an hour — with every further probe pushing the window later. This script calls
# `tailscale cert` instead, which fetches without a handshake and fails loudly. If a name is already
# rate-limited, rename the node: the limit is per-identifier, and a fresh name provisions instantly.
#
# WHAT IT MEASURES, AND WHAT IT CANNOT
#
# Lanes: artifact, install, identity, persistence, rollback, omp-build, omp-clean, uninstall.
# Every line it prints is a measurement.
# Two things it cannot establish and does not claim:
#
#   - Reboot persistence on macOS is LaunchAgent behaviour, so it proves return at **console login**.
#     With auto-login enabled that is automatic; it is still not "starts with nobody logged in".
#   - Sleep/wake is not covered. A remote host that genuinely sleeps can lose its network interface,
#     so it needs a physically accessible Mac.
#
# Usage:
#   OMP_MAC_HOST=user@host OMP_MAC_TAG=v0.4.0-prealpha.1 OMP_MAC_ARCHIVE_SHA256=<sha256> scripts/qualify-macos-host.sh [lane...]
#
# Environment:
#   OMP_MAC_HOST           required, ssh destination (`user@host`)
#   OMP_MAC_TAG            required, signed release tag to qualify
#   OMP_MAC_ARCHIVE_SHA256 required, exact lowercase archive digest verified by the orchestrator
#   OMP_MAC_PREVIOUS_TAG   required, exact published predecessor for rollback
#   OMP_MAC_LOGIN          required, tailnet login to allowlist
#   OMP_MAC_SUDO_PW        optional, sudo password piped to `sudo -S`; omit if sudo is passwordless
#   OMP_MAC_SSH_KEY        optional, identity file
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly OMP_PIN_PATH="$REPO_ROOT/UPSTREAM.lock.json"
[ -r "$OMP_PIN_PATH" ] || { printf 'missing OMP upstream lock: %s\n' "$OMP_PIN_PATH" >&2; exit 1; }
read -r OMP_PIN_SOURCE_COMMIT OMP_PIN_SOURCE_TREE OMP_PIN_VERSION OMP_PIN_BUN_VERSION OMP_PIN_NATIVE_TARBALL_SHA256 OMP_PIN_NATIVE_BINARY_SHA256 < <(
  python3 - "$OMP_PIN_PATH" <<'PY'
import json
import re
import sys
with open(sys.argv[1]) as source:
    lock = json.load(source)
native = lock["darwinArm64Native"]
omp_version = lock["packageVersions"]["@oh-my-pi/pi-coding-agent"]
assert omp_version == lock["packageVersion"], "inconsistent OMP package pin"
values = [lock["commit"], lock["tree"], omp_version, lock["bunVersion"], native["tarballSha256"], native["binarySha256"]]
patterns = [r"[0-9a-f]{40}", r"[0-9a-f]{40}", r"[0-9]+[.][0-9]+[.][0-9]+", r"[0-9]+[.][0-9]+[.][0-9]+", r"[0-9a-f]{64}", r"[0-9a-f]{64}"]
assert all(isinstance(value, str) and re.fullmatch(pattern, value) for value, pattern in zip(values, patterns)), "invalid OMP upstream lock"
print(*values)
PY
)
step() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
measure() { printf '   %-38s %s\n' "$1:" "$2"; }
warn() { printf '   WARNING: %s\n' "$*" >&2; }
die() {
  printf '\nFAILED: %s\n' "$*" >&2
  exit 1
}

readonly HOST="${OMP_MAC_HOST:-}"
readonly TAG="${OMP_MAC_TAG:-}"
# No default: a fallback silently rolls back to whichever stable was current when this was written.
readonly PREVIOUS_TAG="${OMP_MAC_PREVIOUS_TAG:-}"
readonly LOGIN="${OMP_MAC_LOGIN:-}"
readonly EXPECTED_ARCHIVE_SHA256="${OMP_MAC_ARCHIVE_SHA256:-}"
readonly SESSION_LABEL="${OMP_MAC_SESSION_LABEL:-omp-stable-pixel-qualification}"
readonly REPO_SLUG="${OMP_MAC_REPO:-carrythroughsystems/omp-session-gateway}"
# Explicit qualification-only option; never written into ordinary gateway configuration.
readonly QUALIFICATION_LOG_DIR="${OMP_MAC_QUALIFICATION_LOG_DIR:-}"
case "$QUALIFICATION_LOG_DIR" in
  "") ;;
  /*) case "$QUALIFICATION_LOG_DIR" in *[!A-Za-z0-9_./-]* | */../* | */.. | */./* | */.) die "unsafe qualification log directory" ;; esac ;;
  *) die "qualification log directory must be absolute" ;;
esac

# Published under alphastorm through v0.7.5 (2026-10-08T16:38:49Z), captured 2026-10-09.
# Exact published tags only: future tags cannot reuse the former owner identity.
release_signing_repositories() {
  local repository="$1" tag="$2"
  case "$repository" in
    carrythroughsystems/omp-session-gateway|alphastorm/omp-session-gateway)
      printf '%s\n' carrythroughsystems/omp-session-gateway ;;
    *) printf '%s\n' "$repository"; return 0 ;;
  esac
  case "$tag" in
    v0.7.5|v0.7.5-prealpha.2|v0.7.5-prealpha.1|v0.7.4|v0.7.4-prealpha.1|v0.7.3|v0.7.3-prealpha.1|v0.7.2|v0.7.2-prealpha.2|v0.7.2-prealpha.1|v0.7.1|v0.7.1-prealpha.1|v0.7.0|v0.7.0-prealpha.1|v0.6.3|v0.6.3-prealpha.2|v0.6.3-prealpha.1|v0.6.2|v0.6.2-prealpha.1|v0.6.1|v0.6.1-prealpha.1|v0.6.0|v0.6.0-prealpha.4|v0.6.0-prealpha.3|v0.6.0-prealpha.2|v0.6.0-prealpha.1|v0.5.3|v0.5.3-prealpha.1|v0.5.2|v0.5.2-prealpha.1|v0.5.1|v0.5.1-prealpha.1|v0.5.0|v0.5.0-prealpha.1|v0.4.2|v0.4.2-prealpha.1|v0.4.1|v0.4.1-prealpha.3|v0.4.1-prealpha.2|v0.4.1-prealpha.1|v0.4.0|v0.4.0-prealpha.1|v0.3.0|v0.3.0-prealpha.3|v0.3.0-prealpha.2|v0.3.0-prealpha.1|v0.2.1|v0.2.1-prealpha.2|v0.2.0|v0.2.0-prealpha.1|v0.1.0-prealpha.25|v0.1.0-prealpha.24|v0.1.0|v0.1.0-prealpha.23|v0.1.0-prealpha.22|v0.1.0-prealpha.21|v0.1.0-beta.1|v0.1.0-prealpha.20|v0.1.0-prealpha.19|v0.1.0-prealpha.18|v0.1.0-alpha.1|v0.1.0-alpha|provenance-test-v0.1.0.11|v0.1.0-prealpha.17|v0.1.0-prealpha.13|v0.1.0-prealpha.12|v0.1.0-prealpha.11|v0.1.0-prealpha.9|v0.1.0-prealpha.10|v0.1.0-prealpha.8|v0.1.0-prealpha.7|v0.1.0-prealpha.6|v0.1.0-prealpha.5|v0.1.0-prealpha.4|v0.1.0-prealpha.3|v0.1.0-prealpha.2|v0.1.0-prealpha.1|provenance-test-v0.1.0.10|provenance-test-v0.1.0.9|provenance-test-v0.1.0.8|provenance-test-v0.1.0.7|provenance-test-v0.1.0.6|provenance-test-v0.1.0.5)
      printf '%s\n' alphastorm/omp-session-gateway ;;
  esac
}
readonly GATEWAY_PORT="${OMP_MAC_PORT:-4317}"
readonly RECORD_DIR="${OMP_MAC_RECORD_DIR:-$HOME/.local/share/omp-session-gateway/test}"
readonly OMP_SOURCE_COMMIT="$OMP_PIN_SOURCE_COMMIT"
readonly OMP_SOURCE_TREE="$OMP_PIN_SOURCE_TREE"
readonly OMP_VERSION="$OMP_PIN_VERSION"
readonly BUN_VERSION="$OMP_PIN_BUN_VERSION"
readonly OMP_NATIVE_TARBALL_SHA256="$OMP_PIN_NATIVE_TARBALL_SHA256"
readonly OMP_NATIVE_BINARY_SHA256="$OMP_PIN_NATIVE_BINARY_SHA256"

[ -n "$HOST" ] || die "OMP_MAC_HOST is not set. Nothing was measured."
[ -n "$TAG" ] || die "OMP_MAC_TAG is not set; name the signed release tag to qualify. Nothing was measured."
[ -n "$PREVIOUS_TAG" ] || die "OMP_MAC_PREVIOUS_TAG is not set; name the published predecessor to roll back to. Nothing was measured."
[ -n "$LOGIN" ] || die "OMP_MAC_LOGIN is not set; name the tailnet login to allowlist. Nothing was measured."
case "$EXPECTED_ARCHIVE_SHA256" in
  *[!0-9a-f]* | "" ) die "OMP_MAC_ARCHIVE_SHA256 must be the exact lowercase 64-hex candidate archive digest" ;;
esac
[ "${#EXPECTED_ARCHIVE_SHA256}" -eq 64 ] || die "OMP_MAC_ARCHIVE_SHA256 must be exactly 64 hex characters"
case "$SESSION_LABEL" in
  "" | [!A-Za-z0-9]* | *[!A-Za-z0-9._-]*) die "OMP_MAC_SESSION_LABEL must be a safe single path component" ;;
esac
[ "${#SESSION_LABEL}" -le 128 ] || die "OMP_MAC_SESSION_LABEL must not exceed 128 characters"
case "$TAG:$PREVIOUS_TAG" in
  *[!A-Za-z0-9._:-]*) die "OMP_MAC_TAG and OMP_MAC_PREVIOUS_TAG must be plain release tags" ;;
esac

# Release asset names carry the tag's own MAJOR.MINOR.PATCH: a 0.2 candidate ships
# omp-session-gateway-0.2.0-* while its v0.1.0 rollback predecessor keeps 0.1.0 names.
tag_version() {
  local version="${1#v}"
  version="${version%%-*}"
  case "$version" in
    *[!0-9.]* | "" | .* | *. ) die "cannot derive a release version from tag $1" ;;
  esac
  printf '%s' "$version"
}
count_file_occurrences() {
  python3 - "$1" "$2" <<'PY'
from pathlib import Path
import sys

needle = Path(sys.argv[1]).read_bytes()
haystack = Path(sys.argv[2]).read_bytes()
print(haystack.count(needle) if needle else 0)
PY
}

count_environment_occurrences() {
  NEEDLE="$1" python3 - "$2" <<'PY'
from pathlib import Path
import os
import sys

needle = os.environ["NEEDLE"].encode()
haystack = Path(sys.argv[1]).read_bytes()
print(haystack.count(needle) if needle else 0)
PY
}

create_doctor_bundle() {
  local cli="$1" destination="$2"
  rm -f "$destination"
  bun "$cli" doctor --bundle --output "$destination" >/dev/null 2>&1
  [ -s "$destination" ]
}
# A dead peer must surface within seconds: when a Virtualization.framework guest reboots behind a
# tailnet TUN its session sends no FIN, and without keepalives the first campaign against such a
# guest hung in issue_reboot for the orchestrator's whole Mac budget (2026-10-02).
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o BatchMode=yes -o ServerAliveInterval=5 -o ServerAliveCountMax=3)
[ -z "${OMP_MAC_SSH_KEY:-}" ] || SSH_OPTS+=(-i "$OMP_MAC_SSH_KEY" -o IdentitiesOnly=yes)
# Every remote block and its values travel over SSH stdin. Secrets never enter local or remote argv
# and stay as unexported variables in the one static remote shell that evaluates the supplied block.
validate_reboot_guard() {
  local guard="$HOME/.config/omp-qualification/reboot-guard"
  [ -e "$guard" ] || [ -L "$guard" ] || return 0
  if ! { [ -f "$guard" ] && [ -x "$guard" ] && python3 -c 'import os,stat,sys; sys.exit(not (os.stat(sys.argv[1]).st_mode & stat.S_IXUSR))' "$guard"; }; then
    printf "the host's reboot guard must be a regular, owner-executable file: %s\n" "$guard" >&2
    return 1
  fi
}
check_reboot_guard() {
  local guard="$HOME/.config/omp-qualification/reboot-guard" output
  validate_reboot_guard || return 1
  [ -e "$guard" ] || [ -L "$guard" ] || return 0
  if ! output="$("$guard" </dev/null 2>&1)"; then
    printf "the host's reboot guard refused: %s\n" "$(printf '%s' "$output" | head -c 400)" >&2
    return 1
  fi
}

REMOTE_OWNER_SCRIPT="$(cat "$REPO_ROOT/scripts/qualification-remote-owner.sh")"
REMOTE_OWNER_DIRECTORY="${OMP_MAC_OWNER_DIRECTORY:-}"
if [ -z "$REMOTE_OWNER_DIRECTORY" ]; then
  REMOTE_OWNER_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/omp-mac-command-owners.XXXXXXXX")" || exit 125
  # Standalone use owns the same journal; an orchestrator instead consumes it after reaping this shell.
  settle_remote_journal() {
    local status=$? owner file
    for file in "$REMOTE_OWNER_DIRECTORY"/*; do
      [ -f "$file" ] || continue
      owner="${file##*/}"
      if remote_settle "$owner"; then rm -f "$file"; else status=125; fi
    done
    rmdir "$REMOTE_OWNER_DIRECTORY" 2>/dev/null || :
    exit "$status"
  }
  trap settle_remote_journal EXIT
fi

remote_settle() {
  local command
  printf -v command '/bin/bash -c %q -- settle %q' "$REMOTE_OWNER_SCRIPT" "$1"
  ssh "${SSH_OPTS[@]}" -q "$HOST" "$command"
}

remote_dispatch() {
  local script="$1" payload="${2:-}" mode="${3:-run}" bootstrap helpers owner command status=0
  helpers="$(declare -f count_file_occurrences count_environment_occurrences create_doctor_bundle validate_reboot_guard check_reboot_guard)"
  script="${helpers}"$'\n'"$script"
  bootstrap='IFS= read -r -d "" PW || exit; IFS= read -r -d "" PORT || exit; IFS= read -r -d "" LOGIN || exit; IFS= read -r -d "" TAG || exit; IFS= read -r -d "" PREVIOUS_TAG || exit; IFS= read -r -d "" OMP_SOURCE_COMMIT || exit; IFS= read -r -d "" OMP_SOURCE_TREE || exit; IFS= read -r -d "" OMP_VERSION || exit; IFS= read -r -d "" BUN_VERSION || exit; IFS= read -r -d "" OMP_NATIVE_TARBALL_SHA256 || exit; IFS= read -r -d "" OMP_NATIVE_BINARY_SHA256 || exit; IFS= read -r -d "" SESSION_LABEL || exit; IFS= read -r -d "" SCRIPT || exit; export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$HOME/.bun/bin:$HOME/go/bin"; eval "$SCRIPT"'
  owner="$(python3 -c 'import uuid; print(uuid.uuid4())')" || return 125
  # Record before SSH dispatch; the parent can reconcile even if this local shell is killed.
  (umask 077; : > "$REMOTE_OWNER_DIRECTORY/$owner") || return 125
  printf -v command '/bin/bash -c %q -- %q %q /bin/bash -c %q' "$REMOTE_OWNER_SCRIPT" "$mode" "$owner" "$bootstrap"
  {
    local value
    for value in "${OMP_MAC_SUDO_PW:-}" "$GATEWAY_PORT" "$LOGIN" "$TAG" "$PREVIOUS_TAG" "$OMP_SOURCE_COMMIT" "$OMP_SOURCE_TREE" "$OMP_VERSION" "$BUN_VERSION" "$OMP_NATIVE_TARBALL_SHA256" "$OMP_NATIVE_BINARY_SHA256" "$SESSION_LABEL" "$script"; do
      printf '%s\0' "$value"
    done
    [ -z "$payload" ] || cat "$payload"
  } | ssh "${SSH_OPTS[@]}" -q "$HOST" "$command" || status=$?
  # The reboot's detached child stays owned until the caller observes a different boot identity.
  if [ "$mode" != run-reboot ]; then
    if remote_settle "$owner"; then rm -f "$REMOTE_OWNER_DIRECTORY/$owner"; else return 125; fi
  fi
  return "$status"
}

remote() {
  remote_dispatch "$(cat)" "" "${1:-run}"
}

remote_upload() {
  local script
  case "$2" in
    /*) printf -v script 'umask 077; cat > %q' "$2" ;;
    *) printf -v script 'umask 077; cat > "$HOME"/%q' "$2" ;;
  esac
  remote_dispatch "$script" "$1"
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required on this workstation but was not found."
}

verified_archive_sha256() {
  local archive="$1" actual
  actual="$(shasum -a 256 "$archive" | cut -d' ' -f1)"
  [ "$actual" = "$EXPECTED_ARCHIVE_SHA256" ] ||
    die "Mac artifact digest differs from the orchestrator-verified candidate"
  printf '%s' "$actual"
}

# ---------------------------------------------------------------------------------------------------

preflight() {
  step "Preflight"
  need_command ssh
  need_command gh
  need_command cosign
  need_command shasum

  remote <<'REMOTE' || die "Mac host prerequisite probe failed; no lane was run."
validate_reboot_guard || exit 1
S() { if [ -n "$PW" ]; then echo "$PW" | sudo -S -p '' "$@"; else sudo -n "$@"; fi; }
show() { printf '   %-38s %s\n' "$1:" "$2"; }
show "host" "$(sw_vers -productName) $(sw_vers -productVersion) $(uname -m)"
show "hardware" "$(/usr/sbin/sysctl -n hw.model 2>/dev/null || echo unknown)"
show "user / shell" "$(whoami) / $SHELL"
# Same PATH the lanes export. Probing a bare login shell reported `bun: MISSING` on a host where bun
# was installed and every lane worked, which is a misleading preflight rather than a real finding.
actual_bun="$(PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$HOME/.bun/bin:$HOME/go/bin"; command -v bun >/dev/null 2>&1 && bun --version || echo MISSING)"
show "bun" "$actual_bun"
if [ "$actual_bun" != "$BUN_VERSION" ]; then
  printf 'Mac qualification requires Bun %s; found %s. Update the retained host before running lanes.\n' "$BUN_VERSION" "$actual_bun" >&2
  exit 1
fi
actual_omp="$(omp --version </dev/null 2>/dev/null)" || actual_omp=""
if ! printf '%s' "$actual_omp" | bun -e '
  const version = /^(?:omp[ /])?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec((await Bun.stdin.text()).trim())?.[1];
  process.exit(version !== undefined && Bun.semver.satisfies(version, ">=18.1.20") ? 0 : 1);
'; then
  printf 'Mac qualification requires stock OMP >=18.1.20 on PATH for doctor compatibility; install it with: bun add --global --exact @oh-my-pi/pi-coding-agent@%s\n' "$OMP_VERSION" >&2
  exit 1
fi
show "omp" "$actual_omp"
show "sudo" "$(S true >/dev/null 2>&1 && echo available || echo UNAVAILABLE)"
REMOTE

  # The topology gate. Checked here rather than discovered three lanes later, because on a
  # userspace-networking host every identity assertion below would fail for one reason and the report
  # would blame the gateway.
  local topology
  topology="$(remote <<'REMOTE'
S() { if [ -n "$PW" ]; then echo "$PW" | sudo -S -p '' "$@"; else sudo -n "$@"; fi; }
# A root-owned /usr/local/bin/tailscale wins over PATH: a narrow sudoers grant can name only
# a path no non-root account can rewrite (dotfiles-private mac-hosts/install-root-daemons.sh).
if [ ! -x /usr/local/bin/tailscale ] && ! command -v tailscale >/dev/null 2>&1 && [ ! -x "$HOME/go/bin/tailscale" ]; then echo "no-tailscale"; exit 0; fi
TS="$([ -x /usr/local/bin/tailscale ] && echo /usr/local/bin/tailscale || command -v tailscale || echo "$HOME/go/bin/tailscale")"
state="$("$TS" status --json 2>/dev/null || S "$TS" status --json 2>/dev/null)" &&
  state="$(printf '%s' "$state" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("BackendState","?"), "tagged" if d.get("Self",{}).get("Tags") else "user-owned", d.get("Self",{}).get("DNSName","").rstrip("."))' 2>/dev/null || echo "? ? ?")" ||
  state="? ? ?"
# A tailnet address on a real interface is what distinguishes TUN mode from userspace networking, and
# it is the same signal the gateway itself enforces.
tun="userspace"
if ifconfig 2>/dev/null | grep -qE 'inet6 fd7a:115c:a1e0:'; then tun="tun"; fi
echo "$state $tun"
REMOTE
)"
  measure "tailscale" "$topology"
  case "$topology" in
    no-tailscale*) die "Tailscale is not installed on the host. See the header of this script." ;;
    *userspace*) die "the host runs userspace networking, so it has no tunnel device. The gateway will refuse every request and doctor cannot pass; see the header for the headless TUN-mode recipe. Nothing was measured." ;;
    *tagged*) die "the host joined as a *tagged* node, which can never present a user identity, so Serve populates no identity headers and the identity lane would measure nothing. Re-join as a user-owned node." ;;
    Running*) : ;;
    *) die "tailscale backend is not Running on the host: $topology" ;;
  esac
  DNS_NAME="$(printf '%s' "$topology" | awk '{print $3}')"
  [ -n "$DNS_NAME" ] || die "could not read the host's tailnet DNS name."
  measure "tailnet name" "$DNS_NAME"
}

lane_artifact() {
  step "Lane 1: signed candidate artifact"
  local dir="$RECORD_DIR/$TAG/artifact" archive actual_archive_sha256 asset identity signer_workflow signer verified
  rm -rf "$dir"
  mkdir -p "$dir"
  ( cd "$dir" && gh release download "$TAG" --repo "$REPO_SLUG" ) ||
    die "could not download release $TAG from $REPO_SLUG."
  local candidate_version
  candidate_version="$(tag_version "$TAG")"
  for asset in \
    "omp-session-gateway-$candidate_version-bun.tar" \
    "omp-session-gateway-$candidate_version-bun.tar.sigstore.json" \
    "omp-session-gateway-$candidate_version.spdx.json" \
    "omp-session-gateway-$candidate_version.spdx.json.sigstore.json" \
    SHA256SUMS SHA256SUMS.sigstore.json; do
    [ -f "$dir/$asset" ] || die "release $TAG is missing exact asset $asset"
  done
  [ "$(find "$dir" -maxdepth 1 -type f | wc -l | tr -d ' ')" = 6 ] ||
    die "release $TAG did not download exactly six assets"
  ( cd "$dir" && shasum -a 256 -c SHA256SUMS >/dev/null 2>&1 ) ||
    die "checksums do not verify for $TAG. Refusing to install unverified bytes."
  archive="omp-session-gateway-$candidate_version-bun.tar"
  actual_archive_sha256="$(verified_archive_sha256 "$dir/$archive")"
  measure "archive sha256" "$actual_archive_sha256"

  for asset in "$archive" SHA256SUMS; do
    verified=0
    for signer in $(release_signing_repositories "$REPO_SLUG" "$TAG"); do
      signer_workflow="$signer/.github/workflows/signed-release.yml"
      identity="https://github.com/$signer_workflow@refs/tags/$TAG"
      if cosign verify-blob --bundle "$dir/$asset.sigstore.json" --certificate-identity "$identity" \
        --certificate-oidc-issuer "https://token.actions.githubusercontent.com" "$dir/$asset" >/dev/null 2>&1 &&
        gh attestation verify "$dir/$asset" --repo "$signer" \
          --signer-workflow "$signer_workflow" --source-ref "refs/tags/$TAG" >/dev/null 2>&1; then
        verified=1
        break
      fi
    done
    [ "$verified" -eq 1 ] || die "exact release signature verification failed for $asset at $TAG."
  done
  measure "github attestations" "verified against signed-release.yml and refs/tags/$TAG"
  measure "cosign bundles" "2/2 verified against the exact tag identity"

  remote_upload "$dir/$archive" "/tmp/$archive" || die "could not copy the archive to the host."
  remote <<REMOTE
show() { printf '   %-38s %s\n' "\$1:" "\$2"; }
rm -rf ~/qual && mkdir -p ~/qual && tar -xf "/tmp/$archive" -C ~/qual
rm -f "/tmp/$archive"
root="\$(cd ~/qual && ls -d omp-session-gateway-*-bun)"
show "extracted root" "\$root"
show "release-info commit" "\$(python3 -c 'import json;print(json.load(open("'"\$HOME"'/qual/'"\$root"'/release-info.json"))["sourceCommit"])' 2>/dev/null)"
show "bundled upstream pin" "\$(python3 -c 'import json;print(json.load(open("'"\$HOME"'/qual/'"\$root"'/release-info.json"))["upstreamCommit"])' 2>/dev/null)"
REMOTE
}

lane_install() {
  step "Lane 2: install, doctor, rotate"
  remote <<REMOTE
S() { if [ -n "\$PW" ]; then echo "\$PW" | sudo -S -p '' "\$@"; else sudo -n "\$@"; fi; }
show() { printf '   %-38s %s\n' "\$1:" "\$2"; }
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:\$HOME/.bun/bin:\$HOME/go/bin"
CLI="\$HOME/qual/\$(cd ~/qual && ls -d omp-session-gateway-*-bun)/apps/gateway/src/cli.js"
TS="\$([ -x /usr/local/bin/tailscale ] && echo /usr/local/bin/tailscale || command -v tailscale || echo "\$HOME/go/bin/tailscale")"
qualification_log_args=()
[ -z "$QUALIFICATION_LOG_DIR" ] || qualification_log_args=(--qualification-log-dir "$QUALIFICATION_LOG_DIR")

# The operator grant matters: doctor runs as this user and shells out to \`tailscale\`, so without it
# the tailscale checks fail for a permission reason that looks like a gateway fault.
"\$TS" set --operator="\$(whoami)" >/dev/null 2>&1 ||
  S "\$TS" set --operator="\$(whoami)" >/dev/null 2>&1 ||
  true

bun "\$CLI" install --origin "https://$DNS_NAME" --allow "\$LOGIN" "\${qualification_log_args[@]}" >/dev/null 2>&1 ||
  { echo "   install FAILED"; exit 1; }
show "install" "completed for https://$DNS_NAME"
show "status" "\$(bun "\$CLI" status)"
show "listeners" "\$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk -v p=":\$PORT" '\$9 ~ p {print \$9}' | tr '\n' ' ')"
show "plist mode" "\$(stat -f '%Sp' ~/Library/LaunchAgents/omp-session-gateway.plist 2>/dev/null)"
show "config mode" "\$(stat -f '%Sp' ~/.config/omp-session-gateway/config.json 2>/dev/null)"
show "token mode" "\$(stat -f '%Sp' ~/.config/omp-session-gateway/readiness-token 2>/dev/null)"
show "launchagent state" "\$(launchctl print "gui/\$(id -u)/omp-session-gateway" 2>/dev/null | awk '/state =/{print \$3; exit}')"

# Serve, then the certificate fetched directly. Probing https to find out whether it is ready is the
# trap described in this script's header.
\$TS serve reset >/dev/null 2>&1 || true
\$TS serve --bg --https=443 "http://127.0.0.1:\$PORT" >/dev/null 2>&1 || true
# The certificate lands in this account's home, never world-writable /tmp, where another local
# account could plant a symlink for root's key write. The sudoers grant names these exact paths.
("\$TS" cert --cert-file "\$HOME/omp-qual.crt" --key-file "\$HOME/omp-qual.key" "$DNS_NAME" >/dev/null 2>&1 ||
  S "\$TS" cert --cert-file "\$HOME/omp-qual.crt" --key-file "\$HOME/omp-qual.key" "$DNS_NAME" >/dev/null 2>&1) &&
  show "tls certificate" "provisioned for $DNS_NAME" ||
  show "tls certificate" "NOT provisioned (check the ACME rate limit; do not retry by probing)"

bun "\$CLI" doctor > /tmp/omp-doctor.json 2>/dev/null; rc=\$?
python3 - <<'PY'
import json
c = json.load(open('/tmp/omp-doctor.json'))['checks']
false = [k for k, v in c.items() if not v]
print('   %-38s %s' % ('doctor', '%d/%d true' % (len(c) - len(false), len(c))))
print('   %-38s %s' % ('doctor false checks', ','.join(false) if false else '(none)'))
for key in ('loopbackTrustSound', 'listenerLoopbackOnly', 'identityAllowed', 'serveMapping', 'funnelDisabled'):
    print('   %-38s %s' % (key, c.get(key)))
PY
show "doctor exit" "\$rc"

before="\$(lsof -nP -iTCP:\$PORT -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print \$2}')"
digest_before="\$(shasum -a 256 ~/.config/omp-session-gateway/readiness-token | cut -c1-12)"
bun "\$CLI" rotate-readiness-token "\${qualification_log_args[@]}" >/dev/null 2>&1
sleep 3
after="\$(lsof -nP -iTCP:\$PORT -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print \$2}')"
digest_after="\$(shasum -a 256 ~/.config/omp-session-gateway/readiness-token | cut -c1-12)"
show "token rotation pid" "\$before -> \$after"
show "token digest" "\$digest_before -> \$digest_after"

create_doctor_bundle "\$CLI" /tmp/omp-bundle.tar || exit 1
token_count="\$(count_file_occurrences ~/.config/omp-session-gateway/readiness-token /tmp/omp-bundle.tar)"
login_count="\$(count_environment_occurrences "\$LOGIN" /tmp/omp-bundle.tar)"
show "token bytes in bundle" "\$token_count"
show "login in bundle" "\$login_count"
[ "\$token_count:\$login_count" = "0:0" ] || exit 1
REMOTE
}

lane_identity() {
  step "Lane 3: identity and exposure, from this workstation"
  note "This workstation is a distinct user-owned tailnet node, which is the only vantage point that"
  note "can see the failure in #98: a bind-address check cannot, and neither can the host itself."

  local host_ip
  host_ip="$(remote <<'REMOTE'
S() { if [ -n "$PW" ]; then echo "$PW" | sudo -S -p '' "$@"; else sudo -n "$@"; fi; }
TS="$([ -x /usr/local/bin/tailscale ] && echo /usr/local/bin/tailscale || command -v tailscale || echo "$HOME/go/bin/tailscale")"
("$TS" status --json 2>/dev/null || S "$TS" status --json 2>/dev/null) |
  python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["TailscaleIPs"][0])' 2>/dev/null
REMOTE
)"
  measure "host tailnet address" "${host_ip:-<unknown>}"

  measure "Serve, allowlisted identity" "$(curl -sS -o /tmp/omp-serve.json -w '%{http_code}' --max-time 45 "https://$DNS_NAME/api/v1/sessions" 2>/dev/null || echo request-failed)"
  measure "body keys" "$(python3 -c 'import json;print(list(json.load(open("/tmp/omp-serve.json")).keys()))' 2>/dev/null || echo unavailable)"
  measure "cache-control" "$(curl -sS -D - -o /dev/null --max-time 30 "https://$DNS_NAME/api/v1/sessions" 2>/dev/null | awk 'tolower($1)=="cache-control:"{sub(/^[^ ]+ /,"");print}' | tr -d '\r')"
  measure "PWA shell" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "https://$DNS_NAME/" 2>/dev/null || echo request-failed)"
  # The forged value must be ignored rather than honoured: Serve owns the header, not the caller.
  local forged_status
  forged_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -H 'Tailscale-User-Login: nobody@example.invalid' "https://$DNS_NAME/api/v1/sessions" 2>/dev/null || echo request-failed)"
  measure "forged header, real login allowed" "$forged_status"
  [ "$forged_status" = "200" ] || die "Tailscale Serve did not replace the caller-supplied identity header"

  note "The two probes below must get no HTTP answer. Any HTTP status means the backend is reachable"
  note "from a distinct node, which is #98 and is a release blocker, not a warning."
  # The configured SSH name may resolve to the same tailnet address. This is not a claim about
  # an additional public interface; both labels name the actual destinations probed from here.
  local tailnet_probe ssh_probe
  tailnet_probe="$(backend_answer "$host_ip")"
  ssh_probe="$(backend_answer "${HOST#*@}")"
  measure "backend at tailnet address" "$tailnet_probe"
  measure "backend at ssh address" "$ssh_probe"
  case "$tailnet_probe$ssh_probe" in *EXPOSED*) die "the gateway port answered from a distinct node. That is #98; stop and fix before recording anything." ;; esac
}

# Only an HTTP answer proves a listener. A completed TCP handshake does not: a carrier network's
# transparent proxy completes it for any address it has not yet tried, and a bare connect test
# reported the refused port as open through one. Any other curl failure leaves exposure unknown.
backend_answer() {
  local code status=0
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "http://$1:${GATEWAY_PORT}/api/v1/sessions" 2>/dev/null)" || status=$?
  case "$code:$status" in
    000:7 | 000:28 | 000:52 | 000:55 | 000:56) printf 'no HTTP answer (curl exit %s)\n' "$status" ;;
    000:*) die "the exposure probe of the gateway port did not complete (curl exit $status), so exposure is unknown" ;;
    *) printf 'HTTP %s — EXPOSED\n' "$code" ;;
  esac
}

issue_reboot() {
  local output status=0
  output="$(remote run-reboot <<'REMOTE' 2>&1
check_reboot_guard || exit 97
# Return before the reboot tears this session down; the caller measures the new boot identity.
# A sudo password, when there is one, travels over the detached shell stdin, never its argv.
if [ -n "$PW" ]; then
  printf '%s\n' "$PW" | nohup /bin/bash -c 'sleep 2; sudo -S -p "" shutdown -r now' >/dev/null 2>&1 &
else
  nohup /bin/bash -c 'sleep 2; sudo -n shutdown -r now' >/dev/null 2>&1 &
fi
exit 0
REMOTE
  )" || status=$?
  # Preserve tolerance of SSH disconnecting at shutdown, but never swallow a guard refusal.
  [ "$status" -ne 97 ] || die "$output"
}

lane_persistence() {
  step "Lane 4: reboot and login persistence"
  note "macOS starts a LaunchAgent at console login, so this measures return at login. With"
  note "auto-login enabled that is automatic; it is still not start-with-nobody-logged-in."
  # Unlike uptime, the boot-session UUID is constant for one boot and changes at every reboot.
  # Keep both identities private; only their comparison is qualification evidence.
  local before_boot before_digest after_boot="" reboot_changed="no" after_digest token_preserved="no"
  before_boot="$(remote <<'REMOTE'
sysctl -n kern.bootsessionuuid 2>/dev/null
REMOTE
)" || die "could not read the pre-reboot boot identity."
  [ -n "$before_boot" ] || die "the pre-reboot boot identity was empty."
  before_digest="$(remote <<'REMOTE'
set -o pipefail
shasum -a 256 ~/.config/omp-session-gateway/readiness-token 2>/dev/null | cut -d' ' -f1
REMOTE
)" || die "could not read the pre-reboot readiness token."
  [ -n "$before_digest" ] || die "the pre-reboot readiness-token digest was empty."

  issue_reboot
  note "reboot issued; waiting for SSH on a new boot, then for the gateway to bind its listener"
  for _ in $(seq 1 36); do
    sleep 10
    if after_boot="$(remote <<'REMOTE' 2>/dev/null
sysctl -n kern.bootsessionuuid
REMOTE
)" &&
      [ -n "$after_boot" ] && [ "$after_boot" != "$before_boot" ]; then
      reboot_changed="yes"
      break
    fi
  done
  measure "guest reboot changed" "$reboot_changed"
  [ "$reboot_changed" = "yes" ] || die "SSH did not return with a changed boot identity after the reboot."

  # Readiness is waited for, not sampled. The first version of this lane snapshotted as soon as SSH
  # answered, which on a real run was 22 seconds after boot: the LaunchAgent was already `running`
  # but had not yet bound the listener, so the report said `gateway pid: <none>` and `ready:false`
  # and looked exactly like a persistence failure. What the row actually wants is whether the
  # gateway returns and how long it takes, so both are measured.
  local waited=0 ready=""
  for _ in $(seq 1 24); do
    ready="$(remote <<'REMOTE'
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$HOME/.bun/bin:$HOME/go/bin"
lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $2}'
REMOTE
)"
    [ -n "$ready" ] && break
    sleep 5
    waited=$((waited + 5))
  done
  if [ -z "$ready" ]; then
    measure "gateway after reboot" "NEVER RETURNED within $waited s"
    die "the gateway did not return after the reboot. That is the failure this lane exists to find."
  fi
  measure "gateway returned after" "${waited}s of polling (pid $ready)"

  remote <<'REMOTE' || die "the post-reboot console login or gateway doctor did not recover."
show() { printf '   %-38s %s\n' "$1:" "$2"; }
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$HOME/.bun/bin:$HOME/go/bin"
# Explicit gui/<uid> addresses the qualification account's Aqua login domain over SSH on macOS
# 26/27. An SSH login can create a user domain, but cannot itself create this GUI domain.
if launchctl print "gui/$(id -u)" >/dev/null 2>&1; then
  show "console login" "yes"
else
  show "console login" "no"
  exit 1
fi
CLI="$HOME/qual/$(cd ~/qual && ls -d omp-session-gateway-*-bun)/apps/gateway/src/cli.js"
bun "$CLI" doctor >/tmp/omp-doctor2.json 2>/dev/null
status=$?
show "doctor exit" "$status"
exit "$status"
REMOTE
  after_digest="$(remote <<'REMOTE'
set -o pipefail
shasum -a 256 ~/.config/omp-session-gateway/readiness-token 2>/dev/null | cut -d' ' -f1
REMOTE
)" || die "could not read the post-reboot readiness token."
  [ "$before_digest" != "$after_digest" ] || token_preserved="yes"
  measure "readiness token preserved" "$token_preserved"
  [ "$token_preserved" = "yes" ] || die "the reboot changed the readiness token."
}

verify_rollback_bundle() {
  local tag="$1" dir="$2" asset="$3" workflow signer
  for signer in $(release_signing_repositories "$REPO_SLUG" "$tag"); do
    for workflow in signed-release.yml release.yml; do
      if cosign verify-blob --bundle "$dir/$asset.sigstore.json" \
        --certificate-identity "https://github.com/$signer/.github/workflows/$workflow@refs/tags/$tag" \
        --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
        "$dir/$asset" >/dev/null 2>&1; then
        return 0
      fi
    done
  done
  return 1
}

prepare_rollback_tag() {
  local root="$1" tag="$2" asset tag_release_version
  local dir="$root/$tag"
  tag_release_version="$(tag_version "$tag")"
  rm -rf "$dir"
  mkdir -p "$dir"
  gh release download "$tag" --repo "$REPO_SLUG" --dir "$dir" --clobber \
    -p "omp-session-gateway-$tag_release_version-bun.tar" \
    -p "omp-session-gateway-$tag_release_version-bun.tar.sigstore.json" \
    -p SHA256SUMS -p SHA256SUMS.sigstore.json >/dev/null ||
    die "could not stage rollback assets for $tag"
  ( cd "$dir" && shasum -a 256 -c SHA256SUMS --ignore-missing >/dev/null ) ||
    die "rollback checksums failed for $tag"
  for asset in "omp-session-gateway-$tag_release_version-bun.tar" SHA256SUMS; do
    verify_rollback_bundle "$tag" "$dir" "$asset" ||
      die "rollback Sigstore verification failed for $asset at $tag"
  done
}

stage_remote_rollback_tools() {
  local cosign_bin root tag
  cosign_bin="$(command -v cosign)"
  root="$RECORD_DIR/$TAG/rollback-assets"
  rm -rf "$root"
  for tag in "$PREVIOUS_TAG" "$TAG"; do prepare_rollback_tag "$root" "$tag"; done
  remote <<'REMOTE'
rm -rf "$HOME/qual-tools/rollback-assets"
mkdir -p "$HOME/qual-tools/rollback-assets/$PREVIOUS_TAG" "$HOME/qual-tools/rollback-assets/$TAG"
chmod 700 "$HOME/qual-tools" "$HOME/qual-tools/rollback-assets" \
  "$HOME/qual-tools/rollback-assets/$PREVIOUS_TAG" "$HOME/qual-tools/rollback-assets/$TAG"
REMOTE
  remote_upload "$cosign_bin" "qual-tools/cosign" &&
    remote_upload "$REPO_ROOT/scripts/qualify-rollback.sh" "qual-tools/qualify-rollback.sh" ||
    die "could not stage the rollback harness and verification tool on the Mac."
  for tag in "$PREVIOUS_TAG" "$TAG"; do
    local asset
    for asset in "$root/$tag/"*; do
      remote_upload "$asset" "qual-tools/rollback-assets/$tag/${asset##*/}" ||
        die "could not stage rollback assets for $tag on the Mac"
    done
  done
  remote <<'REMOTE'
chmod 700 "$HOME/qual-tools/cosign" "$HOME/qual-tools/qualify-rollback.sh"
REMOTE
}

lane_rollback() {
  step "Lane 5: isolated gateway upgrade and rollback"
  stage_remote_rollback_tools
  remote <<'REMOTE'
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$HOME/.bun/bin:$HOME/go/bin"
OMP_ROLLBACK_COSIGN="$HOME/qual-tools/cosign" \
OMP_ROLLBACK_ARTIFACT_ROOT="$HOME/qual-tools/rollback-assets" \
OMP_ROLLBACK_OLD_TAG="$PREVIOUS_TAG" OMP_ROLLBACK_NEW_TAG="$TAG" \
  bash "$HOME/qual-tools/qualify-rollback.sh" run
REMOTE
}

stage_remote_omp_helper() {
  remote <<'REMOTE'
mkdir -p "$HOME/qual-tools"
chmod 700 "$HOME/qual-tools"
REMOTE
  remote_upload "$REPO_ROOT/scripts/qualify-macos-omp.sh" "qual-tools/qualify-macos-omp.sh" ||
    die "could not stage the mainline OMP qualification helper on the Mac."
  remote <<'REMOTE'
chmod 700 "$HOME/qual-tools/qualify-macos-omp.sh"
REMOTE
}

lane_omp_build() {
  step "Lane 6: exact mainline OMP build"
  stage_remote_omp_helper
  remote <<'REMOTE'
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$HOME/.bun/bin:$HOME/go/bin"
root="$HOME/qual/$(cd "$HOME/qual" && ls -d omp-session-gateway-*-bun)"
OMP_QUAL_GATEWAY_ROOT="$root" \
OMP_PIN_SOURCE_COMMIT="$OMP_SOURCE_COMMIT" \
OMP_PIN_SOURCE_TREE="$OMP_SOURCE_TREE" \
OMP_PIN_VERSION="$OMP_VERSION" \
OMP_PIN_BUN_VERSION="$BUN_VERSION" \
OMP_PIN_NATIVE_TARBALL_SHA256="$OMP_NATIVE_TARBALL_SHA256" \
OMP_PIN_NATIVE_BINARY_SHA256="$OMP_NATIVE_BINARY_SHA256" \
OMP_QUAL_SESSION_LABEL="$SESSION_LABEL" \
  bash "$HOME/qual-tools/qualify-macos-omp.sh" build
REMOTE
}

lane_omp_clean() {
  step "Lane 7: mainline OMP cleanup"
  stage_remote_omp_helper
  remote <<'REMOTE'
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$HOME/.bun/bin:$HOME/go/bin"
archive_root="$(cd "$HOME/qual" 2>/dev/null && ls -d omp-session-gateway-*-bun 2>/dev/null | head -1 || true)"
root="$HOME/qual/${archive_root:-absent}"
OMP_QUAL_GATEWAY_ROOT="$root" \
OMP_PIN_SOURCE_COMMIT="$OMP_SOURCE_COMMIT" \
OMP_PIN_SOURCE_TREE="$OMP_SOURCE_TREE" \
OMP_PIN_VERSION="$OMP_VERSION" \
OMP_PIN_BUN_VERSION="$BUN_VERSION" \
OMP_PIN_NATIVE_TARBALL_SHA256="$OMP_NATIVE_TARBALL_SHA256" \
OMP_PIN_NATIVE_BINARY_SHA256="$OMP_NATIVE_BINARY_SHA256" \
OMP_QUAL_SESSION_LABEL="$SESSION_LABEL" \
  bash "$HOME/qual-tools/qualify-macos-omp.sh" clean
REMOTE
}
lane_uninstall() {
  step "Lane 5: uninstall"
  remote <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$HOME/.bun/bin:$HOME/go/bin"
archive_root="$(cd "$HOME/qual" 2>/dev/null && ls -d omp-session-gateway-*-bun 2>/dev/null | head -1 || true)"
CLI="$HOME/qual/$archive_root/apps/gateway/src/cli.js"
if [ -n "$archive_root" ] && [ -f "$CLI" ]; then
  out="$(bun "$CLI" uninstall --no-stop 2>&1 || true)"
  case "$out" in
    *"cannot uninstall an active gateway"*) show "uninstall --no-stop while active" "refused, as required" ;;
    *) show "uninstall --no-stop while active" "already inactive or absent" ;;
  esac
  bun "$CLI" uninstall >/dev/null 2>&1 || true
else
  show "uninstall candidate CLI" "absent; verifying host state directly"
fi
sleep 2
show "plist present" "$([ -f ~/Library/LaunchAgents/omp-session-gateway.plist ] && echo yes || echo no)"
show "gui job" "$(launchctl print "gui/$(id -u)/omp-session-gateway" >/dev/null 2>&1 && echo present || echo absent)"
show "gateway pids" "$( (pgrep -f 'omp-session-gateway.*cli.js serve' || true) | wc -l | tr -d ' ')"
show "listeners" "$(lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | grep -c ":$PORT" || true)"
REMOTE
}

main() {
  DNS_NAME=""
  local lanes=("$@") lane
  [ ${#lanes[@]} -gt 0 ] || lanes=(artifact install identity persistence uninstall)

  for lane in "${lanes[@]}"; do
    case "$lane" in
      artifact | install | identity | persistence | rollback | omp-build | omp-clean | uninstall) ;;
      *) die "unknown lane '$lane'; choose from artifact install identity persistence rollback omp-build omp-clean uninstall" ;;
    esac
  done

  preflight
  for lane in "${lanes[@]}"; do
    case "$lane" in
      artifact) lane_artifact ;;
      install) lane_install ;;
      identity) lane_identity ;;
      persistence) lane_persistence ;;
      rollback) lane_rollback ;;
      omp-build) lane_omp_build ;;
      omp-clean) lane_omp_clean ;;
      uninstall) lane_uninstall ;;
    esac
  done

  step "Finished"
  note "Every line above is a measurement, not a verdict. Record the numbers against $TAG in"
  note "docs/RELEASE_STATUS.md; nothing here promotes a ledger row on its own."
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
