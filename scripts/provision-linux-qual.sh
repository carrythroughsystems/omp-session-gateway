#!/usr/bin/env bash
#
# Linux qualification lane: one throwaway DigitalOcean droplet, release and OMP evidence.
#
# Why this exists. The original Linux evidence in docs/RELEASE_STATUS.md came from a Debian 13
# aarch64 container. A container shares the host kernel, never boots, has no public address of its
# own, and its `systemd --user` manager exists only because something outside kept it alive. That is
# enough to prove an install/uninstall sequence and file permissions, and nothing else. Five things
# a container structurally cannot show are the point of this script:
#
#   1. a real machine lifecycle: its own kernel, its own boot, its own public IP;
#   2. reboot and login persistence;
#   3. a denied Tailscale identity;
#   4. signed-candidate install/doctor/uninstall with checksum and provenance verification; and
#   5. the mandatory exact mainline OMP build, activation, publication, launch, and revocation path.
#
# Two design decisions are worth knowing before editing this file.
#
# Lingering versus a login session. The gateway's systemd unit is `WantedBy=default.target` and the
# CLI never calls `loginctl enable-linger`. So "the service came back after reboot" is ambiguous by
# default: it can mean lingering started the user manager at boot, or it can mean the SSH login used
# to check created a session that pulled in default.target. This script resolves the ambiguity by
# rebooting twice and measuring from *root only*, so the qualified user has zero sessions at the
# instant of measurement. With lingering off the daemon must be absent; with lingering on it must be
# present while `loginctl` reports no session for that user, and its process age must track system
# uptime rather than the age of our connection. Both numbers are printed, every time.
#
# Tagged identity. The droplet joins the tailnet with a *tagged* auth key. Tailscale Serve populates
# `Tailscale-User-Login` only for user-owned source devices, so a request from a tagged node arrives
# with no user identity at all and the gateway must fail closed. That is the denial half the ledger
# needs and it cannot be produced from the operator's own devices. The price of a tagged node is that
# it can never present a user identity, so `doctor` cannot pass every check on it and the allowed half has
# to come from the operator's workstation, which is a genuinely distinct user-owned node. Both are
# measured here. See docs/LINUX_QUALIFICATION.md for exactly what each pass does and does not prove.
#
# Secrets. The DigitalOcean token and the Tailscale auth key are read from the environment and never
# appear in argv, in cloud-init user data (which is readable from the droplet's own metadata service
# and from the DigitalOcean API), or in any printed line. The auth key is streamed over stdin into a
# mode-0600 file that a remote EXIT trap removes, and `tailscale login` reads it with the documented
# `file:` form. The service's one-time readiness nonce is redacted where ExecStart is printed.
#
# The image is a parameter. OMP_QUAL_IMAGE defaults to the same `debian-13-x64` slug this lane has
# always used, and also accepts a numeric DigitalOcean *custom image* id. Custom images have no slug,
# so a purely numeric value is the only shape an imported image can take and the distinction needs no
# second knob. That exists for one reason: the Linux service backend in apps/gateway/src/service.ts
# builds a systemd user unit for every `linux` platform and then drives `systemctl --user`, with no
# check on what init system is actually running. Whether systemd-only is acceptable for alpha is a
# decision, and the cheapest input to it is to point this lane at a non-systemd distribution and read
# the failure. OMP_QUAL_INIT=openrc provisions an imported Alpine image and runs lane `init`, whose
# expected result is a *refused* install that leaves nothing running. See docs/LINUX_QUALIFICATION.md
# §10 for the import procedure; no OpenRC service backend is implemented here and none should be
# inferred from this lane passing.
#
# Cost. One `s-2vcpu-8gb-amd` droplet, one fixed name, reused rather than duplicated. The EXIT trap
# always reprints the destroy command, because the only way this lane becomes expensive is by being
# forgotten. An imported custom image is a *second* billable resource and `destroy` deliberately does
# not delete it, so `destroy` lists every user image in the account and names the delete command.
#
# Usage:
#   scripts/provision-linux-qual.sh provision
#   scripts/provision-linux-qual.sh qualify [lane...]
#   scripts/provision-linux-qual.sh status
#   scripts/provision-linux-qual.sh destroy
#
# Lanes, systemd: host artifact lifecycle omp migration rollback identity persistence uninstall
#                 (default: all). `omp` builds and exercises exact mainline discovery/query;
#                 `migration` stops before crossing gateway architectures; `rollback` measures
#                 stopped target selection, incompatible activation compensation, and signed
#                 predecessor reinstall using the archive roots left by `migration`.
# Lanes, OpenRC:  host artifact init (default: all three; the rest presume a working install).
#
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SCRIPT_ROOT
readonly OMP_PIN_PATH="$SCRIPT_ROOT/UPSTREAM.lock.json"
[ -r "$OMP_PIN_PATH" ] || { printf 'missing OMP upstream lock: %s\n' "$OMP_PIN_PATH" >&2; exit 1; }
read -r OMP_PIN_SOURCE_COMMIT OMP_PIN_SOURCE_TREE OMP_PIN_VERSION OMP_PIN_BUN_VERSION OMP_PIN_NATIVE_TARBALL_SHA256 OMP_PIN_NATIVE_BINARY_SHA256 < <(
  python3 - "$OMP_PIN_PATH" <<'PY'
import json
import re
import sys
with open(sys.argv[1]) as source:
    lock = json.load(source)
native = lock["darwinArm64Native"]
values = [lock["commit"], lock["tree"], lock["packageVersion"], lock["bunVersion"], native["tarballSha256"], native["binarySha256"]]
patterns = [r"[0-9a-f]{40}", r"[0-9a-f]{40}", r"[0-9]+[.][0-9]+[.][0-9]+", r"[0-9]+[.][0-9]+[.][0-9]+", r"[0-9a-f]{64}", r"[0-9a-f]{64}"]
assert all(isinstance(value, str) and re.fullmatch(pattern, value) for value, pattern in zip(values, patterns)), "invalid OMP upstream lock"
print(*values)
PY
)
readonly REPO_SLUG="carrythroughsystems/omp-session-gateway"

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
readonly TAILNET_TAG="${OMP_QUAL_TAG:-tag:omp-session-gateway}"
readonly DROPLET_NAME="${OMP_QUAL_NAME:-omp-gateway-qual}"
readonly DROPLET_REGION="${OMP_QUAL_REGION:-sfo3}"
readonly DROPLET_SIZE="${OMP_QUAL_SIZE:-s-2vcpu-8gb-amd}"
readonly DROPLET_IMAGE="${OMP_QUAL_IMAGE:-debian-13-x64}"
readonly SSH_KEY_ID="${OMP_QUAL_SSH_KEY_ID:-11924832}"
readonly QUAL_USER="${OMP_QUAL_USER:-ompqual}"
readonly BUN_VERSION="${OMP_QUAL_BUN_VERSION:-$OMP_PIN_BUN_VERSION}"
readonly GH_CLI_VERSION="${OMP_QUAL_GH_VERSION:-2.97.0}"
readonly COSIGN_VERSION="${OMP_QUAL_COSIGN_VERSION:-3.1.3}"
readonly GATEWAY_PORT="${OMP_QUAL_PORT:-4317}"
readonly OMP_SOURCE_COMMIT="$OMP_PIN_SOURCE_COMMIT"
readonly OMP_SOURCE_TREE="$OMP_PIN_SOURCE_TREE"
readonly OMP_VERSION="$OMP_PIN_VERSION"

# Which init system the droplet is expected to run. `systemd` is the historical and only supported
# shape; `openrc` provisions a non-systemd box so the installer's refusal can be observed. Validated
# in preflight_tools so a typo cannot reach a billable resource.
readonly QUAL_INIT="${OMP_QUAL_INIT:-systemd}"

# An address in a reserved TLD. Nobody can ever authenticate as this, which is what makes it a usable
# stand-in for "a well-formed login that is not on the allowlist".
readonly SYNTHETIC_DENIED_LOGIN="denied-identity@qual.invalid"

# The OpenRC path never joins a tailnet, so it has no MagicDNS name to install against. `install`
# only requires an exact HTTPS origin and refuses long before it resolves anything, so a reserved-TLD
# placeholder is both sufficient and unable to name a real host.
readonly OPENRC_SYNTHETIC_ORIGIN="https://openrc-qual.example.invalid"

readonly STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/omp-session-gateway-qual"
readonly STATE_FILE="$STATE_DIR/${DROPLET_NAME}.json"
readonly KNOWN_HOSTS="$STATE_DIR/${DROPLET_NAME}.known_hosts"
readonly PROVIDER_EVIDENCE_DIR="${OMP_QUAL_EVIDENCE_DIR:-$STATE_DIR/provider-evidence}"

LOCAL_TEMP=""
DROPLET_JSON=""
DROPLET_IP=""
DROPLET_ID=""
PROVIDER_EVIDENCE_RUN=""
PROVIDER_REQUEST_NUMBER=0
PROVIDER_BODY=""
PROVIDER_STATUS=""
HOURLY_RATE=""
SSH_OPTS=()

step() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
measure() { printf '   %-38s %s\n' "$1:" "$2"; }
warn() { printf '   WARNING: %s\n' "$*" >&2; }
die() {
  printf '\nFAILED: %s\n' "$*" >&2
  exit 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

identify_version_by_release_info() {
  local archive_root="$1" versions_root="$2" wanted directory found="" matches=0
  [ -f "$archive_root/release-info.json" ] || return 1
  wanted="$(sha256_of "$archive_root/release-info.json")" || return 1
  while IFS= read -r directory; do
    [ -f "$directory/release-info.json" ] || continue
    if [ "$(sha256_of "$directory/release-info.json")" = "$wanted" ]; then
      found="${directory##*/}"
      matches=$((matches + 1))
    fi
  done < <(find "$versions_root" -maxdepth 1 -mindepth 1 -type d -print | sort)
  [ "$matches" -eq 1 ] || return 1
  printf '%s' "$found"
}

# Imported custom images are only ever addressable by id — DigitalOcean assigns them no slug — so the
# value's own shape decides which catalog to validate against, and an operator cannot desynchronise a
# "kind" flag from the value it describes.
image_kind() {
  case "$DROPLET_IMAGE" in
    '' | *[!0-9]*) printf 'distribution' ;;
    *) printf 'custom' ;;
  esac
}

droplet_exists_quietly() {
  command -v doctl >/dev/null 2>&1 || return 1
  doctl compute droplet list --format Name --no-header 2>/dev/null | grep -qx "$DROPLET_NAME"
}

# Set once a delete has been observed to complete. The EXIT trap runs immediately afterwards, when
# DigitalOcean's list endpoint can still report the droplet present, so without this a fully
# successful destroy prints the "STILL BILLING" banner and teaches the operator to ignore it.
DESTROY_CONFIRMED=0
DESTROY_REQUESTED=0

on_exit() {
  local code=$?
  trap - EXIT
  if [ -n "$LOCAL_TEMP" ] && [ -d "$LOCAL_TEMP" ]; then rm -rf "$LOCAL_TEMP"; fi
  if [ "$DESTROY_CONFIRMED" -eq 0 ] && droplet_exists_quietly; then
    printf '\n'
    printf '  ############################################################\n'
    printf '  #  %-54s#\n' "$DROPLET_NAME IS STILL RUNNING AND STILL BILLING"
    printf '  #  %-54s#\n' "run: $0 destroy"
    printf '  ############################################################\n'
    if [ "$DESTROY_REQUESTED" -eq 1 ]; then code=1; fi
  fi
  exit "$code"
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but not on PATH"
}

# ---------------------------------------------------------------------------- local state

state_read() {
  [ -f "$STATE_FILE" ] || return 0
  jq -r --arg key "$1" '.[$key] // ""' "$STATE_FILE"
}

state_write() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  local existing='{}'
  if [ -f "$STATE_FILE" ]; then existing="$(cat "$STATE_FILE")"; fi
  printf '%s' "$existing" | jq --arg key "$1" --arg value "$2" '.[$key] = $value' >"$STATE_FILE.tmp"
  mv "$STATE_FILE.tmp" "$STATE_FILE"
}

# ---------------------------------------------------------------------------- droplet queries

# Capture response bodies/statuses outside LOCAL_TEMP, including failed requests. The existing
# environment/doctl credential stays in memory and curl's stdin, never argv or retained evidence.
provider_request() {
  set +x
  local method="$1" path="$2" body_file="${3:-}" timeout="${4:-30}"
  local token response curl_exit=0 prefix
  token="${DIGITALOCEAN_ACCESS_TOKEN:-}"
  if [ -z "$token" ]; then token="$(doctl auth token 2>/dev/null)" || die "cannot read the existing doctl credential"; fi
  case "$token" in
    '' | *[!a-zA-Z0-9_-]*) die "DigitalOcean credential is missing or not a bearer token" ;;
  esac
  if [ -z "$PROVIDER_EVIDENCE_RUN" ]; then
    mkdir -p "$PROVIDER_EVIDENCE_DIR" || die "cannot create provider evidence directory"
    chmod 700 "$PROVIDER_EVIDENCE_DIR"
    PROVIDER_EVIDENCE_RUN="$(mktemp -d "$PROVIDER_EVIDENCE_DIR/request.XXXXXX")" ||
      die "cannot create provider evidence run"
  fi
  PROVIDER_REQUEST_NUMBER=$((PROVIDER_REQUEST_NUMBER + 1))
  prefix="$PROVIDER_EVIDENCE_RUN/$PROVIDER_REQUEST_NUMBER"
  local args=(--silent --show-error --connect-timeout 10 --max-time "$timeout"
    --max-filesize 2097152 --request "$method" --write-out $'\n%{http_code}')
  if [ -n "$body_file" ]; then args+=(--header "Content-Type: application/json" --data-binary "@$body_file"); fi
  response="$(printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl --config - "${args[@]}" "https://api.digitalocean.com/v2$path")" || curl_exit=$?
  PROVIDER_STATUS="${response##*$'\n'}"
  PROVIDER_BODY="${response%$'\n'*}"
  PROVIDER_BODY="${PROVIDER_BODY//"$token"/[REDACTED_CREDENTIAL]}"
  printf '%s\n' "$PROVIDER_BODY" >"$prefix.body.json" || die "cannot retain provider response"
  jq -n --arg method "$method" --arg path "$path" --arg status "$PROVIDER_STATUS" \
    --argjson curl_exit "$curl_exit" \
    '{method: $method, path: $path, http_status: $status, curl_exit: $curl_exit}' >"$prefix.request.json" ||
    die "cannot retain provider response status"
  [ "$curl_exit" -eq 0 ] || die "DigitalOcean $method $path transport failed; evidence: $prefix"
}

validate_droplet_identity() {
  printf '%s' "$DROPLET_JSON" | jq -e --arg name "$DROPLET_NAME" --arg id "$DROPLET_ID" '
    type == "object" and .name == $name and
    (.id | type == "number" and . > 0 and . == floor) and
    ($id == "" or (.id | tostring) == $id) and
    (.tags | type == "array" and index($name) != null)' >/dev/null ||
    die "DigitalOcean droplet identity does not match the retained id/name/tag; evidence: $PROVIDER_EVIDENCE_RUN"
}

size_hourly_rate() {
  doctl compute size list --output json |
    jq -r --arg slug "$DROPLET_SIZE" '.[] | select(.slug == $slug) | .price_hourly | tostring'
}

# Hours the droplet has existed and the dollars that implies. DigitalOcean bills by the hour and does
# not refund a partial one, so this is the number that matters when deciding whether to destroy now.
accrued_cost() {
  jq -nr --arg created "$1" --arg rate "$2" '
    ($created | fromdateiso8601) as $t
    | ((now - $t) / 3600) as $hours
    | "\(($hours * 100 | round) / 100) h elapsed, about $\((($hours * ($rate | tonumber)) * 100 | round) / 100) accrued"'
}

# Presence is independent of network readiness. Only a 404 for the retained id or a valid empty
# list without a retained id means absence. Never call inside a substitution: assignments matter.
load_droplet() {
  local timeout="${1:-30}" encoded_name
  DROPLET_ID="$(state_read droplet_id)" || die "cannot read retained droplet id"
  DROPLET_JSON=""
  DROPLET_IP=""
  if [ -z "$DROPLET_ID" ]; then
    encoded_name="$(jq -nr --arg name "$DROPLET_NAME" '$name | @uri')"
    provider_request GET "/droplets?tag_name=$encoded_name&per_page=200" "" "$timeout"
    [ "$PROVIDER_STATUS" = 200 ] || die "DigitalOcean list returned HTTP $PROVIDER_STATUS, not absence"
    printf '%s' "$PROVIDER_BODY" | jq -e '
      (.droplets | type == "array") and (.links.pages.next // null) == null' >/dev/null ||
      die "DigitalOcean droplet list is malformed or paginated, not absence"
    if printf '%s' "$PROVIDER_BODY" | jq -e '.droplets | length == 0' >/dev/null; then return 1; fi
    die "droplet tag $DROPLET_NAME exists without a retained create id; refusing adoption or deletion"
  fi
  case "$DROPLET_ID" in
    *[!0-9]* | 0) die "invalid retained droplet id" ;;
  esac
  provider_request GET "/droplets/$DROPLET_ID" "" "$timeout"
  if [ "$PROVIDER_STATUS" = 404 ]; then return 1; fi
  [ "$PROVIDER_STATUS" = 200 ] || die "DigitalOcean droplet $DROPLET_ID returned HTTP $PROVIDER_STATUS, not absence"
  DROPLET_JSON="$(printf '%s' "$PROVIDER_BODY" | jq -ce '.droplet')" ||
    die "DigitalOcean droplet response is malformed, not absence"
  validate_droplet_identity
}

read_droplet_ip() {
  DROPLET_IP="$(printf '%s' "$DROPLET_JSON" |
    jq -r '[(.networks.v4 // [])[] | select(.type == "public") | .ip_address |
      select(type == "string" and length > 0)] | first // ""')"
}

create_droplet() {
  cloud_init_user_data >"$LOCAL_TEMP/cloud-init.yaml"
  jq -n --arg name "$DROPLET_NAME" --arg image "$DROPLET_IMAGE" \
    --arg size "$DROPLET_SIZE" --arg region "$DROPLET_REGION" --arg key "$SSH_KEY_ID" \
    --rawfile user_data "$LOCAL_TEMP/cloud-init.yaml" \
    '{name: $name, image: ($image | tonumber? // .), size: $size, region: $region,
      ssh_keys: [($key | tonumber? // .)], tags: [$name], user_data: $user_data}' >"$LOCAL_TEMP/create.json" ||
    die "cannot compose droplet create request"
  provider_request POST /droplets "$LOCAL_TEMP/create.json"
  [ "$PROVIDER_STATUS" = 202 ] || die "DigitalOcean create returned HTTP $PROVIDER_STATUS; inspect retained response before retrying"
  DROPLET_JSON="$(printf '%s' "$PROVIDER_BODY" | jq -ce '.droplet')" ||
    die "DigitalOcean create response is malformed; inspect retained response before retrying"
  validate_droplet_identity
  DROPLET_ID="$(printf '%s' "$DROPLET_JSON" | jq -r '.id')"
  # This checkpoint must precede every readiness read and survives the EXIT trap.
  state_write droplet_id "$DROPLET_ID" || die "cannot retain created droplet id $DROPLET_ID"
}

wait_for_droplet_network() {
  local deadline=$((SECONDS + 150)) remaining delay
  while [ "$SECONDS" -lt "$deadline" ]; do
    remaining=$((deadline - SECONDS))
    if [ "$remaining" -gt 30 ]; then remaining=30; fi
    if load_droplet "$remaining"; then
      read_droplet_ip || die "droplet $DROPLET_ID network response is malformed, not absence"
      if [ -n "$DROPLET_IP" ] &&
        [ "$(printf '%s' "$DROPLET_JSON" | jq -r '.status')" = active ]; then return 0; fi
    fi
    delay=$((deadline - SECONDS))
    if [ "$delay" -gt 5 ]; then delay=5; fi
    if [ "$delay" -gt 0 ]; then sleep "$delay"; fi
  done
  die "droplet $DROPLET_ID did not become active with public IPv4 within 150s; retained id and provider evidence require cleanup"
}

require_droplet() {
  load_droplet || die "no droplet named $DROPLET_NAME; run '$0 provision' first"
  read_droplet_ip || die "droplet $DROPLET_ID network response is malformed, not absence"
  [ -n "$DROPLET_IP" ] || die "droplet $DROPLET_NAME has no public IPv4 address yet; retry shortly"
}

# ---------------------------------------------------------------------------- ssh plumbing

init_ssh_options() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  touch "$KNOWN_HOSTS"
  SSH_OPTS=(
    -o BatchMode=yes
    -o ConnectTimeout=10
    -o StrictHostKeyChecking=accept-new
    -o "UserKnownHostsFile=$KNOWN_HOSTS"
    -o LogLevel=ERROR
  )
  if [ -n "${OMP_QUAL_SSH_IDENTITY:-}" ]; then
    SSH_OPTS+=(-i "$OMP_QUAL_SSH_IDENTITY" -o IdentitiesOnly=yes)
  fi
}
# Runs one script with NAME=VALUE inputs delivered over SSH stdin. The remote bootstrap validates
# names, keeps values unexported, and evaluates the script in the same static shell. Credentials
# therefore appear in neither workstation ssh argv nor remote process argv/environment.
remote() {
  local user="$1" script bootstrap pair
  shift
  script="$(cat)"
  printf -v bootstrap 'bash -c %q' \
    'IFS= read -r -d "" COUNT || exit; INDEX=0; while [ "$INDEX" -lt "$COUNT" ]; do IFS= read -r -d "" PAIR || exit; NAME=${PAIR%%=*}; VALUE=${PAIR#*=}; case "$NAME" in ""|[0-9]*|*[!A-Za-z0-9_]*) exit 64 ;; esac; printf -v "$NAME" %s "$VALUE"; INDEX=$((INDEX + 1)); done; IFS= read -r -d "" SCRIPT || exit; eval "$SCRIPT"'
  {
    printf '%s\0' "$#"
    for pair in "$@"; do
      printf '%s\0' "$pair"
    done
    printf '%s\0' "$script"
  } | ssh "${SSH_OPTS[@]}" "${user}@${DROPLET_IP}" "$bootstrap"
}
remote_root() { remote root "$@"; }
remote_user() { remote "$QUAL_USER" "$@"; }

# ---------------------------------------------------------------------------- bounded waits
WAIT_LAST_OBSERVATION=""

wait_for() {
  local label="$1" attempts="$2" delay="$3"
  shift 3
  local index started elapsed
  WAIT_LAST_OBSERVATION=""
  started="$(date -u +%s)"
  for ((index = 1; index <= attempts; index++)); do
    if "$@" >/dev/null 2>&1; then
      elapsed=$(($(date -u +%s) - started))
      measure "$label" "ready after ${elapsed}s (attempt $index/$attempts)"
      return 0
    fi
    sleep "$delay"
  done
  [ -z "$WAIT_LAST_OBSERVATION" ] || measure "$label last observation" "$WAIT_LAST_OBSERVATION"
  die "$label did not become ready within $((attempts * delay))s. The droplet is still running; inspect it with '$0 status'."
}

ssh_is_up() { ssh "${SSH_OPTS[@]}" "root@${DROPLET_IP}" true; }

cloud_init_done() { ssh "${SSH_OPTS[@]}" "root@${DROPLET_IP}" "test -f /run/cloud-init/result.json"; }

tailscale_is_online() {
  local raw state
  raw="$(ssh "${SSH_OPTS[@]}" "root@${DROPLET_IP}" 'tailscale status --json 2>/dev/null' 2>/dev/null || true)"
  state="$(printf '%s' "$raw" | jq -c '{backendState:(.BackendState // ""),online:(.Self.Online? // false),health:(.Health // [])}' 2>/dev/null || true)"
  WAIT_LAST_OBSERVATION="${state:-unavailable}"
  [ "$(printf '%s' "$state" | jq -r '[.backendState, (.online | tostring)] | join(":")' 2>/dev/null || true)" = "Running:true" ]
}

# ---------------------------------------------------------------------------- preflight

preflight_tools() {
  need_command doctl
  need_command jq
  need_command ssh
  need_command scp
  need_command ssh-keygen
  need_command curl
  # Checked here rather than at first use: every command routes through this function, and a typo
  # must be rejected before anything is created or measured.
  case "$QUAL_INIT" in
    systemd | openrc) ;;
    *) die "OMP_QUAL_INIT must be 'systemd' or 'openrc', not '$QUAL_INIT'. Nothing was created." ;;
  esac
  doctl account get --output json >/dev/null 2>&1 ||
    die "doctl is not authenticated. Export DIGITALOCEAN_ACCESS_TOKEN or run 'doctl auth init'."
}

# Refuses to create a droplet whose root account we could not then log into. DigitalOcean stores the
# legacy MD5 fingerprint of the public key, which is what `ssh-keygen -E md5` prints.
preflight_ssh_key() {
  local key_json key_err do_fingerprint key_name pub local_fingerprint candidates attempt
  # The key is registered by the immediately preceding step, and DigitalOcean serves key reads from
  # an eventually consistent store: a `get` by id became readable 5-11 seconds after a successful
  # create in 2026-09-23 probes, and stayed unreadable past a 10-second window in qualification run
  # 35850590104. Retry with linear backoff for about 55 seconds rather than refusing a key that
  # does exist. Never discard stderr: a rate limit, an auth failure and a genuinely absent key all
  # reach the shape check identically, and reporting all three as "not in this account" sends the
  # operator to look for the wrong problem.
  attempt=1
  while :; do
    key_err="$(mktemp)"
    key_json="$(doctl compute ssh-key get "$SSH_KEY_ID" --output json 2>"$key_err" || true)"
    if printf '%s' "$key_json" | jq -e 'type == "array" and length > 0' >/dev/null 2>&1; then
      rm -f "$key_err"
      break
    fi
    if [ "$attempt" -ge 11 ]; then
      local detail
      detail="$(tr -d '\r' <"$key_err" | tr '\n' ' ' | cut -c1-300)"
      rm -f "$key_err"
      die "SSH key id $SSH_KEY_ID did not resolve after $attempt attempts. doctl said: ${detail:-<no stderr>}. List keys with 'doctl compute ssh-key list' and set OMP_QUAL_SSH_KEY_ID. No droplet was created."
    fi
    rm -f "$key_err"
    sleep "$attempt"
    attempt=$((attempt + 1))
  done
  do_fingerprint="$(printf '%s' "$key_json" | jq -r '.[0].fingerprint')"
  key_name="$(printf '%s' "$key_json" | jq -r '.[0].name')"
  measure "DigitalOcean SSH key" "id $SSH_KEY_ID, name $key_name"

  # Newline-delimited rather than an array: bash 3.2, which is what /bin/bash is on macOS, treats
  # "${empty[@]}" as an unbound variable under `set -u`.
  if [ -n "${OMP_QUAL_SSH_IDENTITY:-}" ]; then
    candidates="${OMP_QUAL_SSH_IDENTITY}.pub"
  else
    candidates="$(for pub in "$HOME"/.ssh/*.pub; do if [ -f "$pub" ]; then printf '%s\n' "$pub"; fi; done)"
  fi
  while IFS= read -r pub; do
    if [ -z "$pub" ] || [ ! -f "$pub" ]; then continue; fi
    local_fingerprint="$(ssh-keygen -l -E md5 -f "$pub" 2>/dev/null | awk '{print $2}')"
    if [ "$local_fingerprint" = "MD5:${do_fingerprint}" ]; then
      measure "matching local private key" "${pub%.pub}"
      return 0
    fi
  done <<CANDIDATES
$candidates
CANDIDATES
  if ssh-add -l -E md5 2>/dev/null | awk '{print $2}' | grep -qx "MD5:${do_fingerprint}"; then
    measure "matching key in ssh-agent" "yes"
    return 0
  fi
  die "no local private key matches DigitalOcean SSH key '$key_name' (MD5:${do_fingerprint}). Add that key to your agent, or set OMP_QUAL_SSH_IDENTITY=/path/to/private_key. No droplet was created."
}

# Validates the image against whichever catalog can actually contain it, and prints the same
# `image / size / region` and `hourly rate` lines as before so a default run's output is unchanged.
preflight_catalog() {
  if [ "$(image_kind)" = "custom" ]; then
    preflight_custom_image
  else
    doctl compute image list-distribution --output json |
      jq -e --arg slug "$DROPLET_IMAGE" 'any(.[]; .slug == $slug)' >/dev/null ||
      die "image slug $DROPLET_IMAGE does not exist in this account's distribution list"
  fi
  doctl compute size list --output json |
    jq -e --arg slug "$DROPLET_SIZE" --arg region "$DROPLET_REGION" \
      'any(.[]; .slug == $slug and .available and (.regions | index($region)))' >/dev/null ||
    die "size $DROPLET_SIZE is not available in region $DROPLET_REGION"
  HOURLY_RATE="$(size_hourly_rate)"
  measure "image / size / region" "$DROPLET_IMAGE / $DROPLET_SIZE / $DROPLET_REGION"
  measure "hourly rate" "\$$HOURLY_RATE per hour"
}

# A custom image can fail in three ways a distribution slug cannot: it may not exist, it may still be
# importing, and — because custom images are region-scoped — it may exist in a region other than the
# one we are about to create a droplet in. All three are cheap to check and expensive to discover
# after `droplet create` has already been accepted, so check them before anything is created.
preflight_custom_image() {
  local image_json record status regions size_gb monthly
  image_json="$(doctl compute image get "$DROPLET_IMAGE" --output json 2>/dev/null || true)"
  # `doctl compute image get` prints a single-element array on success and an {"errors":[...]} object
  # on failure, so normalise the shape rather than trusting the exit status.
  record="$(printf '%s' "$image_json" |
    jq -c 'if type == "array" then (.[0] // empty) else empty end' 2>/dev/null || true)"
  [ -n "$record" ] ||
    die "custom image id $DROPLET_IMAGE is not in this DigitalOcean account. List imported images with 'doctl compute image list-user'. No droplet was created."
  status="$(printf '%s' "$record" | jq -r '.status // "unknown"')"
  regions="$(printf '%s' "$record" | jq -r '(.regions // []) | join(",")')"
  size_gb="$(printf '%s' "$record" | jq -r '.size_gigabytes // 0')"
  measure "custom image name" "$(printf '%s' "$record" | jq -r '.name // "<unnamed>"')"
  measure "custom image distribution" "$(printf '%s' "$record" | jq -r '.distribution // "Unknown"')"
  measure "custom image status" "$status"
  measure "custom image regions" "${regions:-<none>}"
  # $0.06 per GB per month, and unlike the droplet it keeps billing after `destroy`.
  monthly="$(jq -nr --arg gb "$size_gb" '(($gb | tonumber) * 0.06 * 100 | round) / 100')"
  measure "custom image stored size / cost" "$size_gb GB, about \$$monthly per month until deleted"
  [ "$status" = "available" ] ||
    die "custom image id $DROPLET_IMAGE reports status '$status', not 'available'. An import takes several minutes; wait and retry. No droplet was created."
  printf '%s' "$record" | jq -e --arg region "$DROPLET_REGION" '(.regions // []) | index($region)' >/dev/null ||
    die "custom image id $DROPLET_IMAGE exists in regions [${regions:-none}] but not in $DROPLET_REGION. Custom images are region-scoped: add the region in the DigitalOcean control panel, or set OMP_QUAL_REGION to one it already covers. No droplet was created."
}

# ---------------------------------------------------------------------------- provision

cloud_init_user_data() {
  if [ "$QUAL_INIT" = "openrc" ]; then
    cloud_init_user_data_openrc
    return 0
  fi
  # Deliberately free of secrets: user data is retrievable from the droplet's metadata service and
  # from the DigitalOcean API. Tailscale is installed here and never authenticated here.
  cat <<CLOUDINIT
#cloud-config
package_update: true
packages:
  - ca-certificates
  - curl
  - jq
  - git
  - unzip
  - iproute2
  - procps
users:
  - default
  - name: ${QUAL_USER}
    shell: /bin/bash
    lock_passwd: true
write_files:
  - path: /etc/omp-qual-provisioned
    content: "omp-session-gateway linux qualification droplet\n"
runcmd:
  - [ sh, -c, "install -d -m 700 -o ${QUAL_USER} -g ${QUAL_USER} /home/${QUAL_USER}/.ssh" ]
  - [ sh, -c, "cp /root/.ssh/authorized_keys /home/${QUAL_USER}/.ssh/authorized_keys" ]
  - [ sh, -c, "chown ${QUAL_USER}:${QUAL_USER} /home/${QUAL_USER}/.ssh/authorized_keys" ]
  - [ sh, -c, "chmod 600 /home/${QUAL_USER}/.ssh/authorized_keys" ]
  - [ sh, -c, "curl -fsSL https://tailscale.com/install.sh | sh" ]
CLOUDINIT
}

# The Alpine/OpenRC variant. Four deliberate differences from the systemd user data above, each of
# which is a property of the distribution rather than a preference:
#
#   * `bash` is a package here, and `remote()` runs `bash -s`. `coreutils` and `grep` replace the
#     busybox applets whose option sets differ (`stat -c`, `grep -c`), and `libstdc++` is what Bun's
#     musl build links against.
#   * the qualified user's login shell is `/bin/ash`, not `/bin/bash`. cloud-init creates users in
#     `cloud_init_modules` and installs packages later in `cloud_config_modules`, so naming a shell
#     that does not exist yet leaves the account unusable in between. `remote()` asks for `bash`
#     explicitly, so the login shell does not need to be it.
#   * `disable_root: false` is stated rather than assumed. The lane logs in as root to measure, and
#     an imported image's `cloud.cfg` is not ours to trust on that point.
#   * no Tailscale. Serve is only needed by the lanes that require a working install, and the install
#     is expected to be refused here. Installing tailscaled would also mean writing an OpenRC service
#     for it, which is exactly the thing this lane must not quietly do.
cloud_init_user_data_openrc() {
  cat <<CLOUDINIT
#cloud-config
package_update: true
packages:
  - bash
  - ca-certificates
  - coreutils
  - curl
  - grep
  - iproute2
  - jq
  - libstdc++
  - unzip
disable_root: false
users:
  - default
  - name: ${QUAL_USER}
    shell: /bin/ash
    lock_passwd: true
write_files:
  - path: /etc/omp-qual-provisioned
    content: "omp-session-gateway linux qualification droplet (non-systemd)\n"
runcmd:
  - [ sh, -c, "install -d -m 700 -o ${QUAL_USER} -g ${QUAL_USER} /home/${QUAL_USER}/.ssh" ]
  - [ sh, -c, "cp /root/.ssh/authorized_keys /home/${QUAL_USER}/.ssh/authorized_keys" ]
  - [ sh, -c, "chown ${QUAL_USER}:${QUAL_USER} /home/${QUAL_USER}/.ssh/authorized_keys" ]
  - [ sh, -c, "chmod 600 /home/${QUAL_USER}/.ssh/authorized_keys" ]
CLOUDINIT
}

# Two stdin consumers cannot share one ssh invocation, so the key transfer and the join are separate
# calls: the key goes over stdin under a fixed argv (never in `ps`), then a second call uses it via
# the documented `file:` form and removes it. Removal is attempted on both the success and failure
# path, because an ssh connection that dies before the remote trap arms would otherwise leave it.
join_tailnet() {
  local key_file="$LOCAL_TEMP/authkey" joined=0
  (
    umask 077
    printf '%s' "$TS_AUTHKEY" >"$key_file"
  )
  ssh "${SSH_OPTS[@]}" "root@${DROPLET_IP}" 'umask 077; cat > /root/.ts-authkey' <"$key_file"
  rm -f "$key_file"
  remote_root <<'REMOTE' && joined=1
set -euo pipefail
trap 'rm -f /root/.ts-authkey' EXIT
test -s /root/.ts-authkey
# A freshly started daemon can already have a machine key while still being in NeedsLogin. `up`
# then supplies AuthKey without starting the login flow; it can return while WantRunning remains
# false. `login` always starts reauthentication, and its bound makes that transition the gate.
tailscale login --auth-key="file:/root/.ts-authkey" --hostname="$(hostname -s)" \
  --accept-dns=true --ssh=false --timeout=120s
REMOTE
  ssh "${SSH_OPTS[@]}" "root@${DROPLET_IP}" 'rm -f /root/.ts-authkey' || true
  [ "$joined" -eq 1 ] ||
    die "'tailscale login' failed on the droplet. The auth key file was removed; check that the key is still valid, preauthorized, and carries $TAILNET_TAG."
}

# Extracted from cmd_provision unchanged so the OpenRC path can skip it as a unit. Everything here is
# specific to a tailnet-joined systemd host: Serve, the operator grant, and lingering all exist to
# serve lanes that presume a working install.
provision_tailnet() {
  step "Tailnet"
  if tailscale_is_online; then
    note "already joined; leaving the existing session alone"
  else
    join_tailnet
  fi
  wait_for "tailscale backend running and online" 30 5 tailscale_is_online
  remote_root QUAL_USER="$QUAL_USER" <<'REMOTE'
# The qualified user, not root, drives `tailscale serve` and is the identity `doctor` runs as, so it
# needs operator access to the local API. Without this, doctor's tailscaleConnected and funnelDisabled
# checks fail for a permission reason that looks like a gateway fault.
tailscale set --operator="$QUAL_USER"
# Lingering is on for the install and identity lanes so measurements are not perturbed by our own
# sessions coming and going. The persistence lane turns it off deliberately, as its negative control.
loginctl enable-linger "$QUAL_USER"
printf '   %-38s %s\n' "tailscale operator:" "$QUAL_USER"
printf '   %-38s %s\n' "linger marker:" "$(test -e "/var/lib/systemd/linger/$QUAL_USER" && echo present || echo absent)"
REMOTE

  local self dns_name tags node_id
  self="$(remote_root <<'REMOTE'
tailscale status --json | jq -r '[(.Self.DNSName | sub("\\.$"; "")), ((.Self.Tags // []) | join(",")), .Self.ID] | @tsv'
REMOTE
)"
  dns_name="$(printf '%s' "$self" | cut -f1)"
  tags="$(printf '%s' "$self" | cut -f2)"
  node_id="$(printf '%s' "$self" | cut -f3)"
  measure "tailnet DNS name" "$dns_name"
  measure "node tags" "${tags:-<none>}"
  measure "tailscale node id" "$node_id"
  state_write dns_name "$dns_name"
  state_write ts_node_id "$node_id"
  state_write node_tags "${tags:-}"
  # A tag is required only by the identity lane, which needs an identity-less node. The host,
  # artifact, lifecycle, persistence, and uninstall lanes are unaffected by tagging, so an untagged
  # join degrades this to a warning and disables one lane rather than discarding a paid droplet.
  if [ -z "$tags" ]; then
    warn "joined as an UNTAGGED node: it carries a user identity, so the 'identity' lane cannot prove denial and will be skipped."
    warn "to run that lane, destroy and re-provision with an auth key that applies $TAILNET_TAG."
  fi
}

# The OpenRC counterpart. It joins nothing and grants nothing; it only establishes that the machine we
# just paid for is genuinely not running systemd, because every conclusion lane `init` can support
# depends on that. An imported image that turns out to ship systemd is a wasted droplet, and saying so
# here costs one round trip instead of a full lane sequence.
provision_init_facts() {
  step "Init system"
  remote_root <<'REMOTE' || die "this droplet reports systemd as its init system, so it cannot show the installer's non-systemd behaviour. Check that OMP_QUAL_IMAGE names the imported Alpine image. The droplet is still running; remove it with the destroy command below."
show() { printf '   %-38s %s\n' "$1:" "$2"; }
. /etc/os-release
show "distribution" "${PRETTY_NAME:-unknown}"
show "kernel" "$(uname -srm)"
show "pid 1" "$(tr '\0' ' ' </proc/1/cmdline | awk '{print $1}')"
show "/run/systemd/system" "$(test -d /run/systemd/system && echo present || echo absent)"
show "systemctl on PATH" "$(command -v systemctl || echo absent)"
show "rc-service on PATH" "$(command -v rc-service || echo absent)"
show "bash on PATH" "$(command -v bash || echo absent)"
# The assertion this whole path rests on. Printed above, enforced here.
test ! -d /run/systemd/system
REMOTE
  note "No tailnet was joined: Tailscale Serve only serves lanes that need a running gateway, and the"
  note "install is expected to be refused here. Lingering is a systemd concept and does not apply."
}

cmd_provision() {
  step "Preflight"
  preflight_tools
  preflight_ssh_key
  preflight_catalog
  if [ "$QUAL_INIT" = "systemd" ]; then
    [ -n "${TS_AUTHKEY:-}" ] ||
      die "TS_AUTHKEY is not set. Create a tagged, preauthorized, non-ephemeral auth key carrying $TAILNET_TAG (see docs/LINUX_QUALIFICATION.md) and export it. No droplet was created."
    case "$TS_AUTHKEY" in
      tskey-auth-*) measure "Tailscale auth key" "present, tskey-auth form, value not printed" ;;
      *) die "TS_AUTHKEY does not look like a Tailscale auth key (expected a tskey-auth- prefix). No droplet was created." ;;
    esac
  else
    # The OpenRC path needs no auth key because it joins no tailnet, so demanding one would refuse a
    # run for a credential it will never use.
    measure "init system requested" "$QUAL_INIT (no tailnet, no auth key required)"
  fi

  init_ssh_options
  LOCAL_TEMP="$(mktemp -d)"

  local created
  step "Droplet"
  if load_droplet; then
    created="$(printf '%s' "$DROPLET_JSON" | jq -r '.created_at')"
    measure "reusing existing droplet" "id $DROPLET_ID, created $created"
    measure "cost so far" "$(accrued_cost "$created" "$HOURLY_RATE")"
  else
    [ -z "$DROPLET_ID" ] || die "retained droplet $DROPLET_ID is not visible; reconcile it before provisioning again"
    note "creating $DROPLET_NAME ($DROPLET_SIZE, $DROPLET_IMAGE, $DROPLET_REGION)"
    create_droplet
    created="$(printf '%s' "$DROPLET_JSON" | jq -r '.created_at')"
    measure "created" "id $DROPLET_ID, created $created"
  fi

  step "Readiness"
  wait_for_droplet_network
  measure "public IPv4" "$DROPLET_IP"
  wait_for "ssh as root" 60 5 ssh_is_up
  wait_for "cloud-init finished" 60 10 cloud_init_done
  remote_root <<'REMOTE'
errors="$(jq -r '.v1.errors | length' /run/cloud-init/result.json)"
printf '   %-38s %s\n' "cloud-init errors:" "$errors"
test "$errors" = "0"
REMOTE

  if [ "$QUAL_INIT" = "systemd" ]; then
    provision_tailnet
  else
    provision_init_facts
  fi

  step "Provisioned"
  measure "hourly rate" "\$$HOURLY_RATE per hour"
  measure "next step" "$0 qualify"
}

# ---------------------------------------------------------------------------- status

cmd_status() {
  preflight_tools
  init_ssh_options
  HOURLY_RATE="$(size_hourly_rate)"

  step "Droplet"
  if ! load_droplet; then
    measure "$DROPLET_NAME" "absent (nothing is billing)"
    return 0
  fi
  read_droplet_ip || die "droplet $DROPLET_ID network response is malformed, not absence"
  local created
  created="$(printf '%s' "$DROPLET_JSON" | jq -r '.created_at')"
  measure "id / ip" "$DROPLET_ID / ${DROPLET_IP:-<none>}"
  measure "status / region / size" "$(printf '%s' "$DROPLET_JSON" | jq -r '[.status, .region.slug, .size_slug] | join(" / ")')"
  measure "created" "$created"
  measure "cost so far" "$(accrued_cost "$created" "$HOURLY_RATE")"
  [ -n "$DROPLET_IP" ] || return 0

  step "Reachability"
  if ssh_is_up; then
    measure "ssh as root" "reachable"
  else
    measure "ssh as root" "unreachable"
    return 0
  fi
  remote_root QUAL_USER="$QUAL_USER" GATEWAY_PORT="$GATEWAY_PORT" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
uid="$(id -u "$QUAL_USER")"

# Sessions belonging to the qualified user, as "class|id|type|remote". Enumerated by session id --
# the one column `loginctl list-sessions` has had in every systemd version -- and classified with
# `show-session`, because that table's column layout has changed across releases and a positional
# field is not a fact. Ownership is matched on uid or user name, whichever this systemd renders.
#
# Class is the measurement, never the count. When lingering works the count can never be zero: the
# lingering user manager is itself a session, of class `manager`, and its presence is what lingering
# succeeding looks like. Only a session of class `user` means somebody is logged in.
sessions_of_user() {
  local id owner name class type remote
  while read -r id; do
    [ -n "$id" ] || continue
    owner="$(loginctl show-session "$id" --property=User --value 2>/dev/null || true)"
    name="$(loginctl show-session "$id" --property=Name --value 2>/dev/null || true)"
    [ "$owner" = "$uid" ] || [ "$name" = "$QUAL_USER" ] || continue
    class="$(loginctl show-session "$id" --property=Class --value 2>/dev/null || true)"
    type="$(loginctl show-session "$id" --property=Type --value 2>/dev/null || true)"
    remote="$(loginctl show-session "$id" --property=Remote --value 2>/dev/null || true)"
    printf '%s|%s|%s|%s\n' "${class:-unknown}" "$id" "${type:-unknown}" "${remote:-unknown}"
  done < <(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}')
}
session_display() {
  printf '%s' "$1" | awk -F'|' 'NF { printf "%s(class=%s,type=%s,remote=%s) ", $2, $1, $3, $4 }' |
    sed 's/ *$//' | grep . || printf 'none'
}
session_class_count() {
  printf '%s\n' "$1" | awk -F'|' -v want="$2" 'NF && $1 == want { n++ } END { print n + 0 }'
}
sessions="$(sessions_of_user)"
show "kernel" "$(uname -srm)"
show "virtualisation" "$(systemd-detect-virt || true)"
show "uptime seconds" "$(awk '{printf "%d", $1}' /proc/uptime)"
show "tailscale backend" "$(tailscale status --json | jq -r '.BackendState + " online=" + ((.Self.Online // false) | tostring)')"
show "node tags" "$(tailscale status --json | jq -r '(.Self.Tags // []) | join(",") | if . == "" then "<none>" else . end')"
show "linger marker" "$(test -e "/var/lib/systemd/linger/$QUAL_USER" && echo present || echo absent)"
show "user@${uid}.service" "$(systemctl is-active "user@${uid}.service" 2>/dev/null || true)"
show "sessions for qualified user" "$(session_display "$sessions")"
show "sessions of class user" "$(session_class_count "$sessions" user)"
show "sessions of class manager" "$(session_class_count "$sessions" manager)"
show "gateway pids" "$(pgrep -u "$QUAL_USER" -f 'cli.js serve' | tr '\n' ' ' | grep . || echo none)"
show "loopback probe" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${GATEWAY_PORT}/api/v1/sessions" 2>/dev/null || echo request-failed)"
show "listeners on gateway port" "$(ss -ltnH "sport = :${GATEWAY_PORT}" | awk '{print $4}' | tr '\n' ' ' | grep . || echo none)"
REMOTE
}

# ---------------------------------------------------------------------------- destroy

cmd_destroy() {
  DESTROY_REQUESTED=1
  preflight_tools
  init_ssh_options
  HOURLY_RATE="$(size_hourly_rate)"

  local present=0 node_id created code deadline remaining delay
  if load_droplet; then
    present=1
    read_droplet_ip || DROPLET_IP=""
  fi
  node_id="$(state_read ts_node_id)"

  step "Tailnet node removal"
  # A non-ephemeral tagged node leaves a machine record behind when it logs out, and repeated runs of
  # this lane would pile up dead nodes. Logging out stops it advertising; deleting the device record
  # is what actually removes it, and that needs the Tailscale API.
  if [ "$present" -eq 1 ] && [ -n "$DROPLET_IP" ] && ssh_is_up; then
    if [ -z "$node_id" ]; then
      # A droplet provisioned with OMP_QUAL_INIT=openrc never joined a tailnet and has no `tailscale`
      # binary at all, so this substitution fails. An unguarded assignment would abort destroy under
      # `set -e` and leave the droplet billing, which is the one outcome teardown must never have.
      node_id="$(remote_root <<'REMOTE'
tailscale status --json 2>/dev/null | jq -r '.Self.ID // ""'
REMOTE
)" || node_id=""
    fi
    remote_root <<'REMOTE' || true
tailscale serve reset >/dev/null 2>&1 || true
tailscale logout || true
REMOTE
    measure "tailscale logout" "issued on the droplet"
  else
    measure "tailscale logout" "skipped (droplet absent or unreachable)"
  fi
  measure "tailscale node id" "${node_id:-<unknown>}"
  if [ -n "${TS_API_KEY:-}" ] && [ -n "$node_id" ]; then
    code="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE \
      -H "Authorization: Bearer ${TS_API_KEY}" \
      "https://api.tailscale.com/api/v2/device/${node_id}" 2>/dev/null || echo request-failed)"
    measure "device delete HTTP status" "$code (200 removed, 404 already gone)"
  else
    note "TS_API_KEY is not set, so the tailnet machine record stays behind."
    note "Remove '$DROPLET_NAME' in the Tailscale admin console, or export TS_API_KEY and rerun destroy."
  fi

  step "Droplet removal"
  if [ -z "$DROPLET_ID" ]; then
    measure "$DROPLET_NAME" "already absent; nothing to delete"
    DESTROY_CONFIRMED=1
  else
    if [ "$present" -eq 1 ]; then
      created="$(printf '%s' "$DROPLET_JSON" | jq -r '.created_at')"
      measure "final cost" "$(accrued_cost "$created" "$HOURLY_RATE")"
    fi
    provider_request DELETE "/droplets/$DROPLET_ID"
    case "$PROVIDER_STATUS" in
      204) ;;
      404) DESTROY_CONFIRMED=1 ;;
      *) die "DigitalOcean delete for $DROPLET_ID returned HTTP $PROVIDER_STATUS; droplet may still be billing" ;;
    esac
    deadline=$((SECONDS + 150))
    while [ "$DESTROY_CONFIRMED" -eq 0 ] && [ "$SECONDS" -lt "$deadline" ]; do
      remaining=$((deadline - SECONDS))
      if [ "$remaining" -gt 30 ]; then remaining=30; fi
      if ! load_droplet "$remaining"; then
        DESTROY_CONFIRMED=1
        break
      fi
      delay=$((deadline - SECONDS))
      if [ "$delay" -gt 5 ]; then delay=5; fi
      if [ "$delay" -gt 0 ]; then sleep "$delay"; fi
    done
    [ "$DESTROY_CONFIRMED" -eq 1 ] ||
      die "delete was accepted but droplet $DROPLET_ID has not returned HTTP 404 after 150s; check the DigitalOcean console"
    measure "$DROPLET_NAME" "id $DROPLET_ID confirmed absent (HTTP 404)"
  fi
  rm -f "$KNOWN_HOSTS" "$STATE_FILE"
  measure "local state" "removed $STATE_DIR entries for $DROPLET_NAME"

  report_imported_images
}

# An imported custom image is a second billable resource class, and it is the one that actually leaks:
# the droplet stops billing the moment it is deleted, whereas an image keeps costing $0.06 per GB per
# month forever. `destroy` deliberately does not delete it — an import takes several minutes and is
# reusable across runs, so deleting it would tax every subsequent run for a fraction of a cent a month
# — but silence would be how one survives for a year. Listing every user image in the account, rather
# than only the one OMP_QUAL_IMAGE happens to name, means a leak is visible even when `destroy` is run
# without the knob that created it.
report_imported_images() {
  local images count
  step "Imported images (not deleted by destroy)"
  images="$(doctl compute image list-user --output json 2>/dev/null || true)"
  count="$(printf '%s' "$images" | jq -r 'if type == "array" then length else 0 end' 2>/dev/null || echo 0)"
  if [ "$count" = "0" ]; then
    measure "user images in this account" "none (nothing is accruing image storage)"
    return 0
  fi
  measure "user images in this account" "$count, listed below with monthly storage cost"
  printf '%s' "$images" | jq -r '.[] |
    "   \(.id)  \(.status)  \(.size_gigabytes // 0) GB  about $\(((.size_gigabytes // 0) * 0.06 * 100 | round) / 100)/month  \(.name)"'
  note "These are NOT deleted by destroy. Remove one with: doctl compute image delete <id> --force"
  note "Keeping the Alpine image is the cheap default; deleting it means the next OpenRC run re-imports."
}

# ---------------------------------------------------------------------------- qualification lanes

# Release asset names carry the tag's own MAJOR.MINOR.PATCH. Deriving from the tag rather than the
# checkout's package.json keeps every lane valid when the repository has already moved past the
# candidate under test (and lets rollback pair a v0.1.0 predecessor with a 0.2.x candidate).
version_from_tag() {
  local version="${1#v}"
  version="${version%%-*}"
  case "$version" in
    *[!0-9.]* | "" | .* | *. ) die "cannot derive a release version from tag $1" ;;
  esac
  printf '%s' "$version"
}

release_version() {
  if [ -n "${OMP_QUAL_VERSION:-}" ]; then
    printf '%s' "$OMP_QUAL_VERSION"
  else
    version_from_tag "${OMP_QUAL_RELEASE_TAG:-}"
  fi
}

require_dns_name() {
  local dns_name
  dns_name="$(state_read dns_name)"
  [ -n "$dns_name" ] || die "no tailnet DNS name recorded in $STATE_FILE; run '$0 provision' first"
  printf '%s' "$dns_name"
}

lane_host() {
  step "Lane 1: real machine facts"
  remote_root QUAL_USER="$QUAL_USER" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
. /etc/os-release
show "distribution" "$PRETTY_NAME"
show "kernel" "$(uname -srm)"
show "virtualisation" "$(systemd-detect-virt || true)"
show "systemd version" "$(systemctl --version | head -1)"
show "cpus / memory MiB" "$(nproc) / $(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)"
show "boot id" "$(cat /proc/sys/kernel/random/boot_id)"
show "uptime seconds" "$(awk '{printf "%d", $1}' /proc/uptime)"
show "own public ipv4" "$(curl -sS --max-time 5 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address 2>/dev/null || echo unavailable)"
show "qualified user uid / shell" "$(id -u "$QUAL_USER") / $(getent passwd "$QUAL_USER" | cut -d: -f7)"
REMOTE
  note "The virtualisation line is the honest platform word for the ledger. It will say kvm, not none."
}

lane_artifact() {
  local tag version archive sbom local_dir asset attestation_mode asset_digest
  tag="${OMP_QUAL_RELEASE_TAG:-}"
  [ -n "$tag" ] ||
    die "set OMP_QUAL_RELEASE_TAG to the signed candidate tag, for example v0.4.0-prealpha.1"
  version="$(release_version)"
  archive="omp-session-gateway-${version}-bun.tar"
  sbom="omp-session-gateway-${version}.spdx.json"
  local_dir="$STATE_DIR/release/$tag"

  step "Lane 2: signed candidate artifact"
  need_command gh
  mkdir -p "$local_dir"
  if [ -f "$local_dir/$archive" ]; then
    measure "assets" "already downloaded to $local_dir"
  else
    gh release download "$tag" --repo "$REPO_SLUG" --dir "$local_dir"
    measure "downloaded" "$tag assets into $local_dir"
  fi
  for asset in "$archive" "$sbom" SHA256SUMS "$archive.sigstore.json" "$sbom.sigstore.json" SHA256SUMS.sigstore.json; do
    [ -f "$local_dir/$asset" ] || die "release $tag is missing asset $asset"
  done
  measure "archive sha256 (workstation)" "$(sha256_of "$local_dir/$archive")"

  # `gh attestation verify` needs GitHub API access. If the droplet has no token, fetch the bundles
  # here with the already-authenticated CLI and verify them offline on the droplet instead.
  attestation_mode="online"
  if [ -z "${GH_TOKEN:-}" ]; then
    attestation_mode="offline"
    for asset in "$archive" "$sbom" SHA256SUMS; do
      if [ ! -f "$local_dir/$asset.attestation.jsonl" ]; then
        # `gh attestation download` has no --output-file; it writes sha256:<digest>.jsonl into the
        # working directory, so run it there and rename to the name the droplet expects.
        asset_digest="$(sha256_of "$local_dir/$asset")"
        ( cd "$local_dir" && gh attestation download "$asset" --repo "$REPO_SLUG" >/dev/null )
        [ -f "$local_dir/sha256:$asset_digest.jsonl" ] ||
          die "gh attestation download did not produce sha256:$asset_digest.jsonl for $asset"
        mv "$local_dir/sha256:$asset_digest.jsonl" "$local_dir/$asset.attestation.jsonl"
      fi
    done
  fi
  measure "attestation verification mode" "$attestation_mode"

  note "uploading assets to the droplet"
  remote_user <<'REMOTE'
rm -rf ~/candidate && mkdir -p ~/candidate
REMOTE
  scp "${SSH_OPTS[@]}" -q "$local_dir"/* "${QUAL_USER}@${DROPLET_IP}:candidate/"

  remote_user \
    ARCHIVE="$archive" SBOM="$sbom" TAG="$tag" REPO_SLUG="$REPO_SLUG" \
    SIGNING_REPOSITORIES="$(release_signing_repositories "$REPO_SLUG" "$tag")" \
    GH_CLI_VERSION="$GH_CLI_VERSION" COSIGN_VERSION="$COSIGN_VERSION" BUN_VERSION="$BUN_VERSION" \
    ATTESTATION_MODE="$attestation_mode" SUPPLIED_GH_TOKEN="${GH_TOKEN:-}" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
cd ~/candidate
mkdir -p ~/tools

if [ ! -x ~/tools/cosign ]; then
  curl -fsSL -o ~/tools/cosign "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-amd64"
  chmod 0755 ~/tools/cosign
fi
if [ ! -x ~/tools/gh ]; then
  curl -fsSL -o /tmp/gh.tar.gz "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_amd64.tar.gz"
  tar -xzf /tmp/gh.tar.gz -C /tmp
  install -m 0755 "/tmp/gh_${GH_CLI_VERSION}_linux_amd64/bin/gh" ~/tools/gh
  rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_CLI_VERSION}_linux_amd64"
fi
show "cosign binary sha256" "$(sha256sum ~/tools/cosign | awk '{print $1}')"
show "gh binary sha256" "$(sha256sum ~/tools/gh | awk '{print $1}')"

show "sha256sum --check" "$(sha256sum --check SHA256SUMS | tr '\n' ' ')"
show "archive digest on droplet" "$(sha256sum "$ARCHIVE" | awk '{print $1}')"

for artifact in "$ARCHIVE" "$SBOM" SHA256SUMS; do
  verified=0
  for signer in $SIGNING_REPOSITORIES; do
    identity="https://github.com/${signer}/.github/workflows/signed-release.yml@refs/tags/${TAG}"
    ~/tools/cosign verify-blob \
      --bundle "${artifact}.sigstore.json" \
      --certificate-identity "$identity" \
      --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
      "$artifact" >/dev/null 2>&1 || continue
    attestation_args=()
    if [ "$ATTESTATION_MODE" != "online" ]; then
      attestation_args=(--bundle "${artifact}.attestation.jsonl")
    fi
    if GH_TOKEN="$SUPPLIED_GH_TOKEN" ~/tools/gh attestation verify "$artifact" --repo "$signer" \
      "${attestation_args[@]}" \
      --signer-workflow "${signer}/.github/workflows/signed-release.yml" \
      --source-ref "refs/tags/${TAG}" >/dev/null; then
      verified=1
      break
    fi
  done
  [ "$verified" -eq 1 ] || { echo "release signature verification failed for $artifact at $TAG" >&2; exit 1; }
  show "cosign verify-blob" "$artifact verified"
  show "gh attestation verify" "$artifact verified ($ATTESTATION_MODE)"
done

rm -rf ~/runtime && mkdir -p ~/runtime
tar -xf "$ARCHIVE" -C ~/runtime
root="$(find ~/runtime -maxdepth 1 -mindepth 1 -type d | head -1)"
printf '%s\n' "$root" >~/runtime-root
show "extracted root" "$(basename "$root")"
show "bundled upstream pin" "$(jq -r '.tag + " " + .commit' "$root/UPSTREAM.lock.json")"
show "release-info source commit" "$(jq -r '.sourceCommit' "$root/release-info.json")"
show "release-info version / runtime" "$(jq -r '.version + " / " + .runtime' "$root/release-info.json")"
show "cli mode" "$(stat -c '%a %n' "$root/apps/gateway/src/cli.js")"

if [ ! -x ~/.bun/bin/bun ]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" >/dev/null 2>&1
fi
show "bun version" "$(~/.bun/bin/bun --version)"
REMOTE
}

lane_lifecycle() {
  local dns_name
  dns_name="$(require_dns_name)"

  step "Lane 3: install / status / doctor / rotate, from the artifact"
  remote_user DNS_NAME="$dns_name" GATEWAY_PORT="$GATEWAY_PORT" \
    ALLOWED_LOGIN="$SYNTHETIC_DENIED_LOGIN" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
root="$(cat ~/runtime-root)"
bun=~/.bun/bin/bun
cli="$root/apps/gateway/src/cli.js"

# install derives runtimeDir from XDG_RUNTIME_DIR, and so does the daemon systemd starts. If this
# session lacks it, the installer and managed service would disagree about their runtime paths.
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  echo "XDG_RUNTIME_DIR is unset in this session, so systemd --user paths would be inconsistent" >&2
  exit 1
fi
show "XDG_RUNTIME_DIR" "$XDG_RUNTIME_DIR"

# The Serve mapping must exist before doctor, which checks the exact external host and port against
# the configured public origin.
tailscale serve --bg --https=443 "http://127.0.0.1:${GATEWAY_PORT}" >/dev/null
show "serve mapping" "$(tailscale serve status --json | jq -c '(.TCP // {}) | keys')"

# The allowlist starts as a synthetic address on purpose: this node is tagged, so it presents no user
# identity at all, and lane 4 needs a known-not-allowlisted starting state.
"$bun" "$cli" install --origin "https://${DNS_NAME}" --allow "$ALLOWED_LOGIN" >/dev/null
show "install" "completed with origin https://${DNS_NAME}"
show "status" "$("$bun" "$cli" status || true)"

show "unit path / mode" "$(stat -c '%n %a' "$HOME/.config/systemd/user/omp-session-gateway.service")"
show "unit ExecStart" "$(systemctl --user show -p ExecStart --value omp-session-gateway.service |
  sed 's/--readiness-instance [A-Za-z0-9_-]*/--readiness-instance <redacted>/' | tr -s ' ')"
show "unit WantedBy / Restart" "$(systemctl --user show -p WantedBy -p Restart --value omp-session-gateway.service | tr '\n' ' ')"
show "config mode / dir mode" "$(stat -c '%a' "$HOME/.config/omp-session-gateway/config.json") / $(stat -c '%a' "$HOME/.config/omp-session-gateway")"
show "token mode / bytes" "$(stat -c '%a / %s' "$HOME/.config/omp-session-gateway/readiness-token")"
show "OMP discovery directory" "$(if [ -d "$HOME/${PI_CONFIG_DIR:-.omp}/run/collab-hosts" ]; then stat -c '%a %n' "$HOME/${PI_CONFIG_DIR:-.omp}/run/collab-hosts"; else printf 'absent (no live hosts)'; fi)"
show "listeners on gateway port" "$(ss -ltnH "sport = :${GATEWAY_PORT}" | awk '{print $4}' | tr '\n' ' ')"
show "main pid" "$(systemctl --user show -p MainPID --value omp-session-gateway.service)"

report="$("$bun" "$cli" doctor || true)"
show "doctor true / total" "$(printf '%s' "$report" |
  jq -r '([.checks[]] | length) as $t | ([.checks[] | select(.)] | length) as $ok | "\($ok) / \($t)"')"
show "doctor false checks" "$(printf '%s' "$report" |
  jq -r '[.checks | to_entries[] | select(.value == false) | .key] | join(",") | if . == "" then "<none>" else . end')"

before="$(systemctl --user show -p MainPID --value omp-session-gateway.service)"
"$bun" "$cli" rotate-readiness-token >/dev/null
after="$(systemctl --user show -p MainPID --value omp-session-gateway.service)"
show "token rotation pid" "$before -> $after"
show "status after rotation" "$("$bun" "$cli" status || true)"

bundle="$HOME/diagnostics-$(date -u +%s).tar"
"$bun" "$cli" doctor --bundle --output "$bundle" >/dev/null 2>&1 || true
if [ -f "$bundle" ]; then
  if grep -a -q -F -f "$HOME/.config/omp-session-gateway/readiness-token" "$bundle"; then
    echo "the diagnostics bundle contains the readiness token" >&2
    exit 1
  fi
  show "diagnostics bundle bytes" "$(stat -c '%s' "$bundle")"
  show "token bytes in bundle" "0 (checked with a literal match)"
  show "home path hits in bundle" "$(grep -a -c -F "$HOME" "$bundle" || true)"
  rm -f "$bundle"
fi
REMOTE
}

# Exact mainline OMP qualification on the same Debian host as the signed gateway. This lane is
# intentionally after `artifact lifecycle`: it checks out unmodified upstream source and queries
# the live discovery registry, then removes every OMP-specific process and file before later lanes run.
# Collaboration output is discarded rather than logged because a live OMP UI may render a bearer
# link. Launch bodies flow directly to jq and are never written to disk.
lane_omp() (
  set -euo pipefail
  local dns_name omp_input omp_ssh_pid=""
  dns_name="$(require_dns_name)"
  step "Lane 4: exact mainline OMP build, publication, launch, and revocation"

  remote_user \
    BUN_VERSION="$BUN_VERSION" OMP_SOURCE_COMMIT="$OMP_SOURCE_COMMIT" \
    OMP_SOURCE_TREE="$OMP_SOURCE_TREE" OMP_VERSION="$OMP_VERSION" <<'REMOTE'
set -euo pipefail
show() { printf '   %-38s %s\n' "$1:" "$2"; }
root="$(cat ~/runtime-root)"
omp_root="$HOME/omp-gateway-source"
native_fixture="$HOME/omp-native-fixture"
tree_short="${OMP_SOURCE_TREE:0:8}"
version_dir="$HOME/.local/lib/omp-session-gateway/omp/v${OMP_VERSION}-${tree_short}"

rm -rf "$omp_root" "$native_fixture" "$version_dir"
git clone --filter=blob:none https://github.com/can1357/oh-my-pi.git "$omp_root"
git -C "$omp_root" checkout --detach "$OMP_SOURCE_COMMIT"
test "$(git -C "$omp_root" rev-parse HEAD)" = "$OMP_SOURCE_COMMIT"
test "$(git -C "$omp_root" rev-parse 'HEAD^{tree}')" = "$OMP_SOURCE_TREE"
show "source commit / mainline tree" "${OMP_SOURCE_COMMIT:0:12} / ${OMP_SOURCE_TREE:0:12}"

cd "$omp_root"
test "$(~/.bun/bin/bun --version)" = "$BUN_VERSION"
~/.bun/bin/bun install --frozen-lockfile
mkdir -p "$native_fixture"
printf '%s\n' "{\"private\":true,\"dependencies\":{\"@oh-my-pi/pi-natives\":\"${OMP_VERSION}\"}}" \
  >"$native_fixture/package.json"
(cd "$native_fixture" && ~/.bun/bin/bun install)
native_file=pi_natives.linux-x64-baseline.node
cp "$native_fixture/node_modules/@oh-my-pi/pi-natives-linux-x64/$native_file" \
  "packages/natives/native/$native_file"

# Bound independently from the 50-minute workflow deadline so a stalled upstream suite leaves
# enough time for the always-run droplet teardown.
timeout 1500 ~/.bun/bin/bun run ci:check:full
~/.bun/bin/bun --cwd=packages/coding-agent run build
test "$(packages/coding-agent/dist/omp --version)" = "omp/${OMP_VERSION}"

mkdir -p "$version_dir"
install -m 0755 packages/coding-agent/dist/omp "$version_dir/omp"
"$version_dir/omp" config set collab.autoStart control >/dev/null
"$version_dir/omp" config get collab.autoStart --json |
  jq -e '.value == "control"' >/dev/null
show "binary version" "$("$version_dir/omp" --version)"
show "binary sha256" "$(sha256sum "$version_dir/omp" | awk '{print $1}')"
show "collab config" "autoStart=control"
mkdir -p "$HOME/omp-linux-qualification"
rm -rf "$native_fixture"
REMOTE

  cleanup_omp_lane() (
    set +e
    if [ -n "$omp_ssh_pid" ] && kill -0 "$omp_ssh_pid" >/dev/null 2>&1; then
      kill -TERM "$omp_ssh_pid" >/dev/null 2>&1 || true
      wait "$omp_ssh_pid" >/dev/null 2>&1 || true
    fi
    exec 9>&- 2>/dev/null || true
    remote_user OMP_SOURCE_TREE="$OMP_SOURCE_TREE" OMP_VERSION="$OMP_VERSION" <<'REMOTE' >/dev/null 2>&1
set +e
tree_short="${OMP_SOURCE_TREE:0:8}"
version_dir="$HOME/.local/lib/omp-session-gateway/omp/v${OMP_VERSION}-${tree_short}"
for exe in /proc/[0-9]*/exe; do
  [ "$(readlink "$exe" 2>/dev/null)" = "$version_dir/omp" ] || continue
  pid="${exe#/proc/}"
  kill -TERM "${pid%/exe}" 2>/dev/null || true
done
sleep 1
rm -rf "$HOME/omp-gateway-source" "$HOME/omp-native-fixture" \
  "$HOME/omp-linux-qualification" "$version_dir" "$HOME/.omp"
REMOTE
  )
  trap cleanup_omp_lane EXIT

  # scripts/omp-fixture.json is the single source of the fixture model; OMP_SKIP_SETUP keeps an
  # onboarding wizard from silently dropping prompts on this fresh HOME.
  fixture_model="$(jq -r '.model' "$SCRIPT_ROOT/scripts/omp-fixture.json")"
  case "$fixture_model" in
    "" | null | *[!A-Za-z0-9._/:-]*) die "scripts/omp-fixture.json has no usable fixture model" ;;
  esac

  # Keep an input descriptor open without sending bytes. SSH supplies the real PTY OMP requires;
  # its entire output goes to /dev/null so a collaboration capability cannot enter logs or files.
  omp_input="$LOCAL_TEMP/omp-linux-input"
  mkfifo "$omp_input"
  exec 9<>"$omp_input"
  ssh "${SSH_OPTS[@]}" -tt "${QUAL_USER}@${DROPLET_IP}" \
    "cd \"\$HOME/omp-linux-qualification\" && OMP_SKIP_SETUP=1 exec \"\$HOME/.local/lib/omp-session-gateway/omp/v${OMP_VERSION}-${OMP_SOURCE_TREE:0:8}/omp\" --model '${fixture_model}' --api-key qualification-synthetic-never-sent --no-extensions --no-skills --thinking low" \
    <&9 >/dev/null 2>&1 &
  omp_ssh_pid=$!

  # shellcheck disable=SC2329
  omp_session_present() {
    kill -0 "$omp_ssh_pid" >/dev/null 2>&1 || return 1
    remote_user ALLOWED_LOGIN="$SYNTHETIC_DENIED_LOGIN" GATEWAY_PORT="$GATEWAY_PORT" <<'REMOTE'
curl -fsS -H "Tailscale-User-Login: $ALLOWED_LOGIN" \
  "http://127.0.0.1:${GATEWAY_PORT}/api/v1/sessions" |
  jq -e '
    [.sessions[] | select(.cwdLabel == "omp-linux-qualification")] as $matched
    | ($matched | length) == 1
      and $matched[0].canView
      and $matched[0].canControl
      and ($matched[0].generation == 1)
  ' >/dev/null
REMOTE
  }
  wait_for "mainline OMP publication" 90 1 omp_session_present

  remote_user DNS_NAME="$dns_name" ALLOWED_LOGIN="$SYNTHETIC_DENIED_LOGIN" \
    GATEWAY_PORT="$GATEWAY_PORT" FIXTURE_MODEL="$fixture_model" <<'REMOTE'
set -euo pipefail
show() { printf '   %-38s %s\n' "$1:" "$2"; }
sessions="$(curl -fsS -H "Tailscale-User-Login: $ALLOWED_LOGIN" \
  "http://127.0.0.1:${GATEWAY_PORT}/api/v1/sessions")"
record="$(printf '%s' "$sessions" |
  jq -c '[.sessions[] | select(.cwdLabel == "omp-linux-qualification")] | if length == 1 then .[0] else error("expected exactly one mainline OMP session") end')"
instance_id="$(printf '%s' "$record" | jq -r '.instanceId')"
generation="$(printf '%s' "$record" | jq -r '.generation')"
test "$(printf '%s' "$record" | jq -r '.canView and .canControl')" = true
if [ "$(printf '%s' "$record" | jq -r '.model | type')" != string ]; then
  printf 'FAILED: the OMP fixture published without a model: this OMP did not resolve %s with the synthetic key, so it would reject the Control prompt\n' "$FIXTURE_MODEL" >&2
  exit 1
fi
show "published metadata" "one generation-${generation} session with View and Control"

for mode in view control; do
  headers="$(mktemp)"
  payload="$(jq -nc --argjson generation "$generation" --arg mode "$mode" \
    '{generation: $generation, mode: $mode}')"
  curl -fsS -D "$headers" \
    -H "Tailscale-User-Login: $ALLOWED_LOGIN" \
    -H "Origin: https://${DNS_NAME}" \
    -H "Sec-Fetch-Site: same-origin" \
    -H "Content-Type: application/json" \
    --data-binary "$payload" \
    "http://127.0.0.1:${GATEWAY_PORT}/api/v1/sessions/${instance_id}/launch" |
    jq -e --arg mode "$mode" \
      'keys == ["capability","generation","mode"] and .mode == $mode and (.capability | type) == "string" and (.capability | length) > 0' \
      >/dev/null
  grep -qi '^cache-control:.*no-store' "$headers"
  rm -f "$headers"
  show "$mode launch" "200-shaped response, no-store, capability retained in pipe memory only"
done
REMOTE

  # Closing the SSH PTY terminates the interactive process. The registry must revoke before any
  # OMP files are removed, proving process lifecycle rather than TTL cleanup.
  kill -TERM "$omp_ssh_pid"
  wait "$omp_ssh_pid" >/dev/null 2>&1 || true
  omp_ssh_pid=""
  exec 9>&-

  # shellcheck disable=SC2329
  omp_session_absent() {
    remote_user ALLOWED_LOGIN="$SYNTHETIC_DENIED_LOGIN" GATEWAY_PORT="$GATEWAY_PORT" <<'REMOTE'
curl -fsS -H "Tailscale-User-Login: $ALLOWED_LOGIN" \
  "http://127.0.0.1:${GATEWAY_PORT}/api/v1/sessions" |
  jq -e '[.sessions[] | select(.cwdLabel == "omp-linux-qualification")] | length == 0' >/dev/null
REMOTE
  }
  wait_for "mainline OMP revocation" 45 1 omp_session_absent

  cleanup_omp_lane
  trap - EXIT
  remote_user OMP_SOURCE_TREE="$OMP_SOURCE_TREE" OMP_VERSION="$OMP_VERSION" <<'REMOTE'
tree_short="${OMP_SOURCE_TREE:0:8}"
version_dir="$HOME/.local/lib/omp-session-gateway/omp/v${OMP_VERSION}-${tree_short}"
test ! -e "$version_dir"
test ! -e "$HOME/omp-gateway-source"
printf '   %-38s %s\n' "OMP qualification cleanup:" "source, binary, config, and process removed"
REMOTE
)

lane_identity() {
  # An untagged node presents a real user identity, so it cannot demonstrate denial. Skip rather
  # than fail: the other lanes are still valid on this droplet, and the denial half was measured
  # separately by varying the allowlist against a real Serve-injected identity.
  if [ -z "$(state_read node_tags 2>/dev/null || true)" ]; then
    step "Identity (skipped)"
    note "this droplet joined untagged, so it carries a user identity and cannot prove denial."
    note "re-provision with an auth key applying $TAILNET_TAG to run this lane."
    return 0
  fi
  local dns_name tailscale_ip workstation_login public_ip
  dns_name="$(require_dns_name)"
  public_ip="$DROPLET_IP"
  tailscale_ip="$(remote_root <<'REMOTE'
tailscale ip -4
REMOTE
)"
  workstation_login="${OMP_QUAL_ALLOWED_LOGIN:-}"
  if [ -z "$workstation_login" ] && command -v tailscale >/dev/null 2>&1; then
    workstation_login="$(tailscale status --json 2>/dev/null |
      jq -r '.User[(.Self.UserID | tostring)].LoginName // ""' 2>/dev/null || true)"
  fi

  step "Lane 4a: identity from the tagged droplet itself"
  remote_user DNS_NAME="$dns_name" TS_IP="$tailscale_ip" GATEWAY_PORT="$GATEWAY_PORT" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
probe() { curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null || echo request-failed; }

show "configured allowlist size" "$(jq -r '.auth.allowedLogins | length' "$HOME/.config/omp-session-gateway/config.json")"
show "configured auth mode" "$(jq -r '.auth.mode' "$HOME/.config/omp-session-gateway/config.json")"
show "self tags" "$(tailscale status --json | jq -r '(.Self.Tags // []) | join(",") | if . == "" then "<none>" else . end')"
show "whois self login" "$(tailscale whois --json "$TS_IP" 2>/dev/null | jq -r '.UserProfile.LoginName // "<no user profile>"')"
show "whois self tags" "$(tailscale whois --json "$TS_IP" 2>/dev/null | jq -r '(.Node.Tags // []) | join(",") | if . == "" then "<none>" else . end')"
show "funnel status" "$(tailscale funnel status 2>&1 | head -1)"

show "tagged self -> Serve /api/v1/sessions" "$(probe "https://${DNS_NAME}/api/v1/sessions")"
show "tagged self -> Serve /" "$(probe "https://${DNS_NAME}/")"
show "tailscale-user headers reaching us" "$(curl -sS --max-time 15 -D - -o /dev/null "https://${DNS_NAME}/api/v1/sessions" 2>/dev/null | grep -ci 'tailscale-user' || true)"
# Deliberately kept, and deliberately not trusted. In userspace-networking mode the host has no
# route to its own tailnet address either, so this probe fails on an exposed host exactly as it does
# on a safe one. Only the workstation probe in lane 4b can tell them apart. See #98.
show "backend via tailnet ip, from self" "$(probe "http://${TS_IP}:${GATEWAY_PORT}/api/v1/sessions")"
show "tailnet address on an interface" "$(ip -o addr show 2>/dev/null | awk '$4 ~ /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./ || $4 ~ /^fd7a:115c:a1e0:/ { found = 1 } END { print (found ? "yes (TUN mode)" : "NO (userspace mode: identity trust is unsound)") }')"
show "loopback, no identity supplied" "$(probe "http://127.0.0.1:${GATEWAY_PORT}/api/v1/sessions")"
show "listener addresses" "$(ss -ltnH "sport = :${GATEWAY_PORT}" | awk '{print $4}' | tr '\n' ' ')"
REMOTE
  note "403 for the tagged self probe is the denial observable: Serve adds no user identity for a"
  note "tagged source, so the gateway fails closed. The whois lines above are why."

  step "Lane 4b: identity from this workstation, a distinct user-owned node"
  measure "droplet public ip:port" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
    "http://${public_ip}:${GATEWAY_PORT}/api/v1/sessions" 2>/dev/null || echo connection-failed)"
  # The probe that would have caught #98, and the only one that can. A bind-address check cannot see
  # the failure, and neither can the droplet probing itself: userspace-mode tailscaled forwards
  # inbound tailnet connections to localhost, so the backend port is reachable from any tailnet peer
  # while every local observation still looks correct. Expect connection-refused on a TUN-mode host;
  # any HTTP status here means the backend is exposed to the tailnet.
  measure "droplet tailnet ip:port, no header" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
    "http://${tailscale_ip}:${GATEWAY_PORT}/api/v1/sessions" 2>/dev/null || echo connection-refused)"
  measure "droplet tailnet ip:port, forged hdr" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
    -H "Tailscale-User-Login: ${SYNTHETIC_DENIED_LOGIN}" \
    "http://${tailscale_ip}:${GATEWAY_PORT}/api/v1/sessions" 2>/dev/null || echo connection-refused)"
  measure "workstation tailnet login" "${workstation_login:-<unavailable>}"
  if [ -z "$workstation_login" ]; then
    note "No user-owned tailnet login is available here, so the allowed half is NOT exercised."
    note "Set OMP_QUAL_ALLOWED_LOGIN to a user-owned tailnet login and rerun: $0 qualify identity"
    return 0
  fi
  measure "not-allowlisted, real identity" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
    "https://${dns_name}/api/v1/sessions" 2>/dev/null || echo request-failed)"
  measure "forged header, not allowlisted" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
    -H "Tailscale-User-Login: ${SYNTHETIC_DENIED_LOGIN}" \
    "https://${dns_name}/api/v1/sessions" 2>/dev/null || echo request-failed)"

  note "reinstalling with this workstation's login on the allowlist"
  remote_user DNS_NAME="$dns_name" ALLOWED_LOGIN="$workstation_login" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
root="$(cat ~/runtime-root)"
before="$(systemctl --user show -p MainPID --value omp-session-gateway.service)"
~/.bun/bin/bun "$root/apps/gateway/src/cli.js" install --origin "https://${DNS_NAME}" --allow "$ALLOWED_LOGIN" >/dev/null
after="$(systemctl --user show -p MainPID --value omp-session-gateway.service)"
show "active reinstall pid" "$before -> $after"
show "configured allowlist size" "$(jq -r '.auth.allowedLogins | length' "$HOME/.config/omp-session-gateway/config.json")"
REMOTE
  measure "allowlisted, real identity" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
    "https://${dns_name}/api/v1/sessions" 2>/dev/null || echo request-failed)"
  measure "cache-control on that response" "$(curl -sS -D - -o /dev/null --max-time 20 \
    "https://${dns_name}/api/v1/sessions" 2>/dev/null |
    awk 'tolower($1) == "cache-control:" { sub(/^[^ ]+ /, ""); print }' | tr -d '\r' || true)"
  measure "body keys of that response" "$(curl -sS --max-time 20 \
    "https://${dns_name}/api/v1/sessions" 2>/dev/null | jq -rc 'keys' || echo unavailable)"
  measure "forged header, real login allowed" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
    -H "Tailscale-User-Login: ${SYNTHETIC_DENIED_LOGIN}" \
    "https://${dns_name}/api/v1/sessions" 2>/dev/null || echo request-failed)"
  note "The forged-header pair is the point: the same supplied value is denied when the caller's real"
  note "identity is not allowlisted and ignored when it is, so Serve owns the header, not the caller."
}

# Reboots and returns only once the machine answers SSH with a *different* boot id, so a pre-reboot
# host can never be mistaken for the rebooted one.
reboot_and_wait() {
  local before after index
  before="$(remote_root <<'REMOTE'
cat /proc/sys/kernel/random/boot_id
REMOTE
)"
  measure "boot id before reboot" "$before"
  ssh "${SSH_OPTS[@]}" "root@${DROPLET_IP}" \
    "nohup sh -c 'sleep 1; systemctl reboot' >/dev/null 2>&1 & exit 0" || true
  sleep 10
  for ((index = 1; index <= 60; index++)); do
    after="$(ssh "${SSH_OPTS[@]}" "root@${DROPLET_IP}" "cat /proc/sys/kernel/random/boot_id" 2>/dev/null || true)"
    if [ -n "$after" ] && [ "$after" != "$before" ]; then
      measure "boot id after reboot" "$after (attempt $index)"
      return 0
    fi
    sleep 5
  done
  die "the droplet did not come back with a new boot id within 310s"
}

# Everything here runs as root, never as the qualified user, so measuring cannot create the very login
# session whose absence is the whole point.
#
# $3 is what lingering is expected to be doing: `off` for the negative control, `on` for the
# persistence claim. It decides the assertions, because the two passes require opposite outcomes from
# the same measurements and a function that only printed them left the reader to adjudicate.
measure_after_reboot() {
  note "$1, measured from root only, with no login session for $QUAL_USER"
  remote_root QUAL_USER="$QUAL_USER" TARGET_UID="$2" EXPECT_LINGER="$3" GATEWAY_PORT="$GATEWAY_PORT" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
uid="$TARGET_UID"

# Sessions belonging to the qualified user, as "class|id|type|remote". Enumerated by session id --
# the one column `loginctl list-sessions` has had in every systemd version -- and classified with
# `show-session`, because that table's column layout has changed across releases and a positional
# field is not a fact. Ownership is matched on uid or user name, whichever this systemd renders.
#
# Class is the measurement, never the count. When lingering works the count can never be zero: the
# lingering user manager is itself a session, of class `manager`, and its presence is what lingering
# succeeding looks like. Only a session of class `user` means somebody is logged in.
sessions_of_user() {
  local id owner name class type remote
  while read -r id; do
    [ -n "$id" ] || continue
    owner="$(loginctl show-session "$id" --property=User --value 2>/dev/null || true)"
    name="$(loginctl show-session "$id" --property=Name --value 2>/dev/null || true)"
    [ "$owner" = "$uid" ] || [ "$name" = "$QUAL_USER" ] || continue
    class="$(loginctl show-session "$id" --property=Class --value 2>/dev/null || true)"
    type="$(loginctl show-session "$id" --property=Type --value 2>/dev/null || true)"
    remote="$(loginctl show-session "$id" --property=Remote --value 2>/dev/null || true)"
    printf '%s|%s|%s|%s\n' "${class:-unknown}" "$id" "${type:-unknown}" "${remote:-unknown}"
  done < <(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}')
}
session_display() {
  printf '%s' "$1" | awk -F'|' 'NF { printf "%s(class=%s,type=%s,remote=%s) ", $2, $1, $3, $4 }' |
    sed 's/ *$//' | grep . || printf 'none'
}
session_class_count() {
  printf '%s\n' "$1" | awk -F'|' -v want="$2" 'NF && $1 == want { n++ } END { print n + 0 }'
}
sessions="$(sessions_of_user)"
session_total="$(printf '%s' "$sessions" | grep -c . || true)"

show "linger marker" "$(test -e "/var/lib/systemd/linger/$QUAL_USER" && echo present || echo absent)"
show "sessions for qualified user" "$(session_display "$sessions")"
show "sessions of class user / manager" "$(session_class_count "$sessions" user) / $(session_class_count "$sessions" manager)"
show "user@${TARGET_UID}.service" "$(systemctl is-active "user@${TARGET_UID}.service" 2>/dev/null || true)"
pid="$(pgrep -u "$QUAL_USER" -f 'cli.js serve' | head -1 || true)"
show "gateway pid" "${pid:-none}"
if [ -n "$pid" ]; then
  show "daemon age vs system uptime" "process $(ps -o etimes= -p "$pid" | tr -d ' ')s old, system up $(awk '{printf "%d", $1}' /proc/uptime)s"
fi
show "loopback probe (403 = up, closed)" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${GATEWAY_PORT}/api/v1/sessions" 2>/dev/null || echo request-failed)"
show "listeners on gateway port" "$(ss -ltnH "sport = :${GATEWAY_PORT}" | awk '{print $4}' | tr '\n' ' ' | grep . || echo none)"

fail=0
check() {
  if [ "$2" = "$3" ]; then printf '   %-44s %-24s %s\n' "$1" "$2" PASS
  else printf '   %-44s %-24s %s\n' "$1" "expected $3, got $2" FAIL; fail=1; fi
}
printf '\n   %-44s %-24s %s\n' INVARIANT OBSERVED RESULT
if [ "$EXPECT_LINGER" = off ]; then
  # Lingering disabled: nothing may have started the user manager, so the user owns no session of any
  # class and no daemon exists. This is the control that gives the other pass its meaning.
  check "no session of any class for the user" "$session_total" 0
  check "no gateway daemon" "$(if [ -n "$pid" ]; then printf '%s' "$pid"; else printf 'none'; fi)" none
else
  # Lingering enabled: nobody is logged in, so no session of class `user` may exist. A `manager`
  # session must exist, because that session *is* lingering having taken effect; its absence would
  # mean the daemon came back for some other reason and the pass would prove nothing.
  check "no session of class user" "$(session_class_count "$sessions" user)" 0
  check "manager session present (lingering)" "$(if [ "$(session_class_count "$sessions" manager)" -ge 1 ]; then printf 'present'; else printf 'absent'; fi)" present
  check "gateway daemon present" "$(if [ -n "$pid" ]; then printf 'present'; else printf 'absent'; fi)" present
fi
[ "$fail" -eq 0 ] || { echo "reboot persistence invariants failed with lingering $EXPECT_LINGER" >&2; exit 1; }
REMOTE
}

lane_persistence() {
  local uid
  step "Lane 5: reboot and login persistence"
  uid="$(remote_root QUAL_USER="$QUAL_USER" <<'REMOTE'
id -u "$QUAL_USER"
REMOTE
)"
  measure "qualified user uid" "$uid"

  note "pass A, the negative control: lingering disabled"
  remote_root QUAL_USER="$QUAL_USER" <<'REMOTE'
loginctl disable-linger "$QUAL_USER"
printf '   %-38s %s\n' "linger marker:" "$(test -e "/var/lib/systemd/linger/$QUAL_USER" && echo present || echo absent)"
REMOTE
  reboot_and_wait
  measure_after_reboot "pass A (lingering off)" "$uid" off

  note "pass A follow-up: a login session should pull the unit in through default.target"
  remote_user <<'REMOTE'
root="$(cat ~/runtime-root)"
printf '   %-38s %s\n' "status inside a login session:" "$(~/.bun/bin/bun "$root/apps/gateway/src/cli.js" status || true)"
REMOTE
  remote_root QUAL_USER="$QUAL_USER" TARGET_UID="$uid" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
show "user@${TARGET_UID}.service after login" "$(systemctl is-active "user@${TARGET_UID}.service" 2>/dev/null || true)"
pid="$(pgrep -u "$QUAL_USER" -f 'cli.js serve' | head -1 || true)"
if [ -n "$pid" ]; then
  show "daemon age vs system uptime" "process $(ps -o etimes= -p "$pid" | tr -d ' ')s old, system up $(awk '{printf "%d", $1}' /proc/uptime)s"
else
  show "daemon age vs system uptime" "no daemon process"
fi
REMOTE
  note "A daemon far younger than uptime here means the login started it, not the boot."

  note "pass B: lingering enabled"
  remote_root QUAL_USER="$QUAL_USER" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
loginctl enable-linger "$QUAL_USER"
show "linger marker" "$(test -e "/var/lib/systemd/linger/$QUAL_USER" && echo present || echo absent)"
show "loginctl Linger property" "$(loginctl show-user "$QUAL_USER" --property=Linger --value 2>/dev/null || echo unavailable)"
REMOTE
  reboot_and_wait
  measure_after_reboot "pass B (lingering on)" "$uid" on
  note "Pass B proves persistence because no session of class 'user' exists: the only session the"
  note "qualified user owns is the 'manager' session that lingering itself creates, which is why the"
  note "count is one rather than zero. Nobody is logged in, and the daemon's age tracks system uptime"
  note "rather than the age of our connection."
}

# Explicit forward upgrade and rollback on a real systemd user manager. `qualify-rollback.sh` proves
# this on macOS, but it cannot exercise a user unit, an `enable` state, or a service manager that
# owns the runtime directory, and #69 showed those are exactly where Linux differs. Staged here
# rather than by generalising `lane_artifact`, so the existing lanes keep their behaviour byte for
# byte; this lane only adds a second extracted root beside the primary one and reuses the tools
# `lane_artifact` has already placed on the droplet.
lane_migration() {
  local previous_tag successor_tag version archive sbom local_dir dns_name
  successor_tag="${OMP_QUAL_RELEASE_TAG:-}"
  # No default. A fallback here silently qualifies migration and rollback against whichever stable
  # happened to be current when this line was last edited.
  previous_tag="${OMP_QUAL_PREVIOUS_TAG:-}"
  [ -n "$successor_tag" ] || die "set OMP_QUAL_RELEASE_TAG to the successor candidate tag"
  [ -n "$previous_tag" ] || die "set OMP_QUAL_PREVIOUS_TAG to the published predecessor tag"

  step "Lane 4: explicit upgrade and rollback"
  if [ "$previous_tag" = "$successor_tag" ]; then
    note "predecessor and successor tags are both $successor_tag, so there is nothing to migrate."
    note "set OMP_QUAL_PREVIOUS_TAG to an earlier signed tag to run this lane."
    return 0
  fi

  version="$(version_from_tag "$previous_tag")"
  archive="omp-session-gateway-${version}-bun.tar"
  sbom="omp-session-gateway-${version}.spdx.json"
  local_dir="$STATE_DIR/release/$previous_tag"
  dns_name="$(require_dns_name)"
  measure "predecessor / successor" "$previous_tag -> $successor_tag"

  mkdir -p "$local_dir"
  if [ -f "$local_dir/$archive" ]; then
    measure "predecessor assets" "already downloaded to $local_dir"
  else
    gh release download "$previous_tag" --repo "$REPO_SLUG" --dir "$local_dir"
    measure "predecessor downloaded" "$previous_tag assets into $local_dir"
  fi
  for asset in "$archive" SHA256SUMS "$archive.sigstore.json" SHA256SUMS.sigstore.json; do
    [ -f "$local_dir/$asset" ] || die "release $previous_tag is missing asset $asset"
  done
  measure "predecessor archive sha256" "$(sha256_of "$local_dir/$archive")"

  note "uploading the predecessor to the droplet"
  remote_user <<'REMOTE'
rm -rf ~/candidate-prev && mkdir -p ~/candidate-prev
REMOTE
  scp "${SSH_OPTS[@]}" -q "$local_dir"/* "${QUAL_USER}@${DROPLET_IP}:candidate-prev/"

  remote_user \
    ARCHIVE="$archive" SBOM="$sbom" PREV_TAG="$previous_tag" REPO_SLUG="$REPO_SLUG" \
    SIGNING_REPOSITORIES="$(release_signing_repositories "$REPO_SLUG" "$previous_tag")" \
    DNS_NAME="$dns_name" ALLOWED_LOGIN="$SYNTHETIC_DENIED_LOGIN" GATEWAY_PORT="$GATEWAY_PORT" <<'REMOTE'
set -euo pipefail
show() { printf '   %-38s %s\n' "$1:" "$2"; }
bun=~/.bun/bin/bun

# Verify the predecessor on the droplet with the tools lane_artifact already installed, so a bad
# download cannot be installed even though this lane staged it separately.
cd ~/candidate-prev
sha256sum --check SHA256SUMS >/dev/null
verified=0
for signer in $SIGNING_REPOSITORIES; do
  for workflow in signed-release.yml release.yml; do
    identity="https://github.com/${signer}/.github/workflows/${workflow}@refs/tags/${PREV_TAG}"
    if ~/tools/cosign verify-blob --bundle "${ARCHIVE}.sigstore.json" --certificate-identity "$identity" \
      --certificate-oidc-issuer "https://token.actions.githubusercontent.com" "$ARCHIVE" >/dev/null 2>&1; then
      verified=1
      break 2
    fi
  done
done
[ "$verified" -eq 1 ] || { echo "predecessor Sigstore verification failed for $PREV_TAG" >&2; exit 1; }
show "predecessor verified" "checksum and signature for $PREV_TAG"

rm -rf ~/runtime-prev && mkdir -p ~/runtime-prev
tar -xf "$ARCHIVE" -C ~/runtime-prev
prev_root="$(find ~/runtime-prev -maxdepth 1 -mindepth 1 -type d | head -1)"
next_root="$(cat ~/runtime-root)"
show "predecessor root" "$(basename "$prev_root")"
show "successor root" "$(basename "$next_root")"

state_dir="$HOME/.local/state/omp-session-gateway"
unit="$HOME/.config/systemd/user/omp-session-gateway.service"

# One line per step so the comparison below is textual and auditable rather than remembered.
snapshot() {
  local active_version versions config_digest token_digest token_mode exec_path enabled main_pid listener
  active_version="$(jq -r '.versionDirectory' "$state_dir/installation/current.json")"
  versions="$(find "$state_dir/installation/versions" -maxdepth 1 -mindepth 1 -type d -printf '%f ' | tr ' ' '\n' | sort | tr '\n' ' ')"
  config_digest="$(sha256sum "$HOME/.config/omp-session-gateway/config.json" | awk '{print $1}')"
  token_digest=absent
  token_mode=absent
  if [ -f "$HOME/.config/omp-session-gateway/readiness-token" ]; then
    token_digest="$(sha256sum "$HOME/.config/omp-session-gateway/readiness-token" | awk '{print $1}')"
    token_mode="$(stat -c '%a' "$HOME/.config/omp-session-gateway/readiness-token")"
  fi
  exec_path="$(systemctl --user show -p ExecStart --value omp-session-gateway.service | grep -o '/[^ ]*cli\.js' | head -1)"
  enabled="$(systemctl --user is-enabled omp-session-gateway.service 2>&1 || true)"
  main_pid="$(systemctl --user show -p MainPID --value omp-session-gateway.service)"
  listener="$(ss -ltnH "sport = :${GATEWAY_PORT}" | awk '{print $4}' | tr '\n' ' ' | grep . || echo none)"
  printf '%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
    "$active_version" "$versions" "$config_digest" "$token_digest" "$token_mode" \
    "$exec_path" "$enabled" "$main_pid" "$listener"
}

install_root() {
  "$bun" "$1/apps/gateway/src/cli.js" install --origin "https://${DNS_NAME}" --allow "$ALLOWED_LOGIN" >/dev/null
}

# The publisher credential was retired by the fork-era-to-mainline cutover. This block used to hash
# it before and after that cutover to prove the candidate retired the predecessor's token and
# reminted its own. From a mainline predecessor there is nothing to hash — `v0.4.0` onward never
# mints one — so hashing it aborted the lane on a missing file.
#
# What still holds, and is now asserted at every step rather than only after the cutover: the
# retired path never reappears. Readiness-credential preservation and mode are asserted separately
# by `assert_preserved`, so no coverage is lost here.
legacy_token="$HOME/.config/omp-session-gateway/publisher-token"
"$bun" "$next_root/apps/gateway/src/cli.js" uninstall >/dev/null
install_root "$prev_root"; a="$(snapshot)"
config="$HOME/.config/omp-session-gateway/config.json"
backup="$state_dir/pre-mainline-config.json"
(umask 077; cp "$config" "$backup"; chmod 600 "$backup")
[ ! -e "$legacy_token" ] || { echo "predecessor minted a retired publisher token" >&2; exit 1; }
"$bun" "$prev_root/apps/gateway/src/cli.js" uninstall >/dev/null
install_root "$next_root"; b="$(snapshot)"
[ ! -e "$legacy_token" ] || { echo "legacy publisher token survived cutover" >&2; exit 1; }
"$bun" "$next_root/apps/gateway/src/cli.js" uninstall >/dev/null
cp "$backup" "$config"; chmod 600 "$config"
install_root "$prev_root"; c="$(snapshot)"
[ ! -e "$legacy_token" ] || { echo "recovery minted a retired publisher token" >&2; exit 1; }
show "stopped predecessor/candidate/recovery" "completed; no retired publisher credential at any step"
show "private predecessor config backup" "$backup (mode $(stat -c '%a' "$backup"))"

field() { printf '%s' "$1" | cut -d'|' -f"$2"; }
fail=0
check() {
  if [ "$2" = "$3" ]; then printf '   %-44s %-24s %s\n' "$1" "$2" PASS
  else printf '   %-44s %-24s %s\n' "$1" "expected $3, got $2" FAIL; fail=1; fi
}
printf '\n   %-44s %-24s %s\n' INVARIANT OBSERVED RESULT
check "predecessor install names a version" "$([ -n "$(field "$a" 1)" ] && echo named || echo empty)" named
check "active version changes on upgrade" "$([ "$(field "$a" 1)" != "$(field "$b" 1)" ] && echo changed || echo same)" changed
check "active version restored on rollback" "$(field "$c" 1)" "$(field "$a" 1)"
check "predecessor version dir survives upgrade" "$(printf '%s' "$(field "$b" 2)" | grep -qF "$(field "$a" 1)" && echo present || echo missing)" present
check "config identical across all steps" "$([ "$(field "$a" 3)" = "$(field "$b" 3)" ] && [ "$(field "$b" 3)" = "$(field "$c" 3)" ] && echo identical || echo differs)" identical
check "readiness credential created or preserved" "$([ "$(field "$b" 4)" != absent ] && { [ "$(field "$a" 4)" = absent ] || [ "$(field "$a" 4)" = "$(field "$b" 4)" ]; } && echo valid || echo invalid)" valid
check "readiness credential survives rollback" "$([ "$(field "$c" 4)" = "$(field "$b" 4)" ] && echo unchanged || echo changed)" unchanged
check "readiness token mode after cutover" "$(field "$b" 5)" 600
check "readiness token mode after rollback" "$(field "$c" 5)" 600
check "ExecStart tracks active version" "$(printf '%s' "$(field "$c" 6)" | grep -qF "$(field "$c" 1)" && echo tracks || echo stale)" tracks
check "unit still enabled after rollback" "$(field "$c" 7)" enabled
check "main pid changed across upgrade" "$([ "$(field "$a" 8)" != "$(field "$b" 8)" ] && echo changed || echo same)" changed
check "listener loopback only after rollback" "$(printf '%s' "$(field "$c" 9)" | grep -qE '^127\.0\.0\.1:' && echo loopback || echo "$(field "$c" 9)")" loopback

[ "$fail" -eq 0 ] || { echo "migration invariants failed" >&2; exit 1; }
REMOTE
}

# The fork-era predecessor and mainline candidate do not share a readiness credential.
# Exercise target/history selection while stopped, then the real incompatible activation failure
# and candidate compensation. Recovery is a matching signed archive reinstall, never a token copy
# or an OMP binary rollback. The predecessor config backup contains configuration only (mode 0600).
lane_rollback() {
  local dns_name version_matcher
  step "Lane 8: architecture-crossing rollback, compensation, and stopped recovery"
  dns_name="$(require_dns_name)"
  version_matcher="$(declare -f sha256_of identify_version_by_release_info)"
  remote_user VERSION_MATCHER="$version_matcher" DNS_NAME="$dns_name" ALLOWED_LOGIN="$SYNTHETIC_DENIED_LOGIN" \
    GATEWAY_PORT="$GATEWAY_PORT" <<'REMOTE'
set -euo pipefail
eval "$VERSION_MATCHER"
bun=~/.bun/bin/bun
state_dir="$HOME/.local/state/omp-session-gateway"
versions="$state_dir/installation/versions"
pointer="$state_dir/installation/current.json"
history="$state_dir/installation/history.json"
unit="$HOME/.config/systemd/user/omp-session-gateway.service"
config="$HOME/.config/omp-session-gateway/config.json"
token="$HOME/.config/omp-session-gateway/readiness-token"
backup="$state_dir/pre-mainline-config.json"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
show() { printf '   %-44s %s\n' "$1:" "$2"; }
digest_of() { sha256sum "$1" | cut -d' ' -f1; }
pointer_version() { jq -r '.versionDirectory' "$pointer"; }
unit_version() { sed -n 's|.*installation/versions/\([^/]*\)/apps/gateway/src/cli.js.*|\1|p' "$unit"; }
loaded_version() { systemctl --user show -p ExecStart --value omp-session-gateway.service | sed -n 's|.*installation/versions/\([^/]*\)/apps/gateway/src/cli.js.*|\1|p'; }
main_pid() { systemctl --user show -p MainPID --value omp-session-gateway.service; }
history_last() { jq -r '.activations[-1]' "$history"; }
recorded_predecessor() {
  jq -r '.activations[]' "$history" | awk -v active="$(pointer_version)" '
    { line[NR] = $0; if ($0 == active) last = NR }
    END { for (i = last - 1; i >= 1; i--) if (line[i] != active) { print line[i]; exit } }'
}
CHECKS=0
check() {
  CHECKS=$((CHECKS + 1))
  [ "$2" = "$3" ] || { printf 'FAIL %s: expected %s, got %s\n' "$1" "$3" "$2" >&2; exit 1; }
  show "$1" PASS
}
install_root() { "$bun" "$1/apps/gateway/src/cli.js" install --origin "https://${DNS_NAME}" --allow "$ALLOWED_LOGIN" --port "$GATEWAY_PORT" "${@:2}" >/dev/null; }
stop_root() {
  # uninstall checks loaded-program ownership before touching the user service and preserves data.
  "$bun" "$1/apps/gateway/src/cli.js" uninstall >/dev/null
  if systemctl --user is-active omp-session-gateway.service >/dev/null; then echo "service survived explicit stop" >&2; exit 1; fi
}
restore_predecessor_config() { cp "$backup" "$config"; chmod 600 "$config"; }
status_quad() {
  "$bun" "$1/apps/gateway/src/cli.js" status 2>/dev/null |
    jq -r '[(.installed|tostring),(.active|tostring),(.ready|tostring),(.diverged|tostring)] | join("/")'
}
assert_current() {
  check "$1 pointer" "$(pointer_version)" "$2"
  check "$1 definition" "$(unit_version)" "$2"
  check "$1 loaded definition" "$(loaded_version)" "$2"
  check "$1 readiness" "$(status_quad "$3")" true/true/true/false
}
assert_preserved() {
  check "$1 config" "$(digest_of "$config")" "$BASE_CONFIG"
  check "$1 readiness credential" "$([ "$(digest_of "$token")" = "$BASE_TOKEN" ] && echo unchanged || echo changed)" unchanged
  check "$1 readiness mode" "$(stat -c '%a' "$token")" 600
}
[ -s ~/runtime-root ] && [ -f "$backup" ] || { echo "run artifact lifecycle migration first" >&2; exit 1; }
check "predecessor config backup private" "$(stat -c '%a' "$backup")" 600
next_root="$(cat ~/runtime-root)"
prev_root="$(find ~/runtime-prev -maxdepth 1 -mindepth 1 -type d | head -1)"
prev_version="$(identify_version_by_release_info "$prev_root" "$versions")"
next_version="$(identify_version_by_release_info "$next_root" "$versions")"
[ "$prev_version" != "$next_version" ] || { echo "identical rollback pair" >&2; exit 1; }
check "migration left predecessor active" "$(pointer_version)" "$prev_version"
assert_current "predecessor baseline" "$prev_version" "$prev_root"
show "predecessor / candidate" "$prev_version / $next_version"

# Stopped target selection is valid across architectures; no readiness claim is made for it.
stop_root "$prev_root"
install_root "$next_root" --no-start
BASE_CONFIG="$(digest_of "$config")"
BASE_TOKEN="$(digest_of "$token")"
"$bun" "$next_root/apps/gateway/src/cli.js" rollback --to "$prev_version" >/dev/null
check "stopped explicit target pointer" "$(pointer_version)" "$prev_version"
check "stopped explicit target definition" "$(unit_version)" "$prev_version"
check "stopped explicit target history" "$(history_last)" "$prev_version"
check "actual recorded predecessor" "$(recorded_predecessor)" "$next_version"
"$bun" "$next_root/apps/gateway/src/cli.js" rollback >/dev/null
check "stopped history target pointer" "$(pointer_version)" "$next_version"
check "stopped history target definition" "$(unit_version)" "$next_version"
check "stopped history target recorded" "$(history_last)" "$next_version"
check "stopped walk did not start a daemon" "$(main_pid)" 0
assert_preserved "stopped target walk"
install_root "$next_root"
assert_current "candidate activation" "$next_version" "$next_root"

# `docs/UPGRADE_ROLLBACK.md` records that mainline-to-mainline reinstalls retain the normal
# active-service path, so the predecessor installer takes over a running candidate rather than
# refusing it. The refusal this used to assert belonged to the fork-era predecessor, which could not
# authenticate the mainline readiness proof; every mainline predecessor can. Proving the takeover
# succeeds and lands on the predecessor is the stronger claim, because it is the downgrade an
# operator actually performs.
before_pid="$(main_pid)"
rc=0
install_root "$prev_root" >"$work/active-install.log" 2>&1 || rc=$?
check "active predecessor installer accepted" "$([ "$rc" -eq 0 ] && echo accepted || echo refused)" accepted
assert_current "active predecessor takeover" "$prev_version" "$prev_root"
check "active takeover restarted the daemon" "$([ "$before_pid" != "$(main_pid)" ] && echo restarted || echo unchanged)" restarted
assert_preserved "active predecessor takeover"
install_root "$next_root"
assert_current "candidate reactivation" "$next_version" "$next_root"

# A mainline predecessor is a real rollback target, so both the explicit and the history-selected
# rollback must activate it, preserve configuration and the readiness credential, and restart the
# daemon. The fork-era predecessor could not be activated at all, which is why this block used to
# assert refusal and compensation back to the candidate. Each iteration reinstalls the candidate so
# the next selection starts from the same state.
for selection in explicit history; do
  check "$selection target in actual history" "$(recorded_predecessor)" "$prev_version"
  before_pid="$(main_pid)"
  rc=0
  if [ "$selection" = explicit ]; then
    "$bun" "$next_root/apps/gateway/src/cli.js" rollback --to "$prev_version" >"$work/rollback.log" 2>&1 || rc=$?
  else
    "$bun" "$next_root/apps/gateway/src/cli.js" rollback >"$work/rollback.log" 2>&1 || rc=$?
  fi
  check "$selection rollback activates the predecessor" "$([ "$rc" -eq 0 ] && echo activated || echo refused)" activated
  assert_current "$selection rollback" "$prev_version" "$prev_root"
  check "$selection rollback restarted the daemon" "$([ "$before_pid" != "$(main_pid)" ] && echo restarted || echo unchanged)" restarted
  assert_preserved "$selection rollback"
  install_root "$next_root"
  assert_current "$selection rollback reset" "$next_version" "$next_root"
done

# Reproduce the reachable crash state: newer definition, older pointer. It is not a claim to
# have crashed between the writes. No third runtime or falsified activation history is introduced.
stop_root "$next_root"
restore_predecessor_config
install_root "$prev_root" --no-start
sed -i "s|/installation/versions/${prev_version}/|/installation/versions/${next_version}/|g" "$unit"
systemctl --user daemon-reload
systemctl --user start omp-session-gateway.service
for _ in $(seq 1 30); do
  status="$("$bun" "$next_root/apps/gateway/src/cli.js" status 2>/dev/null || true)"
  [ "$(printf '%s' "$status" | jq -r '.ready')" = true ] && break
  sleep 1
done
check "divergence newer definition loaded" "$(loaded_version)" "$next_version"
check "divergence retains older pointer" "$(pointer_version)" "$prev_version"
check "divergence observed with ready daemon" "$(printf '%s' "$status" | jq -r '[.ready,.diverged] | @tsv')" "$(printf 'true\ttrue')"
before_state="$(digest_of "$pointer")/$(digest_of "$unit")/$(digest_of "$history")/$(main_pid)"
rc=0
"$bun" "$next_root/apps/gateway/src/cli.js" rollback --to "$prev_version" >"$work/divergence.log" 2>&1 || rc=$?
check "diverged rollback to current refuses" "$([ "$rc" -ne 0 ] && echo refused || echo accepted)" refused
check "divergence refusal leaves state" "$(digest_of "$pointer")/$(digest_of "$unit")/$(digest_of "$history")/$(main_pid)" "$before_state"
stop_root "$next_root"
restore_predecessor_config
install_root "$prev_root"
assert_current "signed predecessor reinstall recovery" "$prev_version" "$prev_root"
check "predecessor config restored exactly" "$(digest_of "$config")" "$(digest_of "$backup")"
assert_preserved "predecessor recovery"

stop_root "$prev_root"
install_root "$next_root"
assert_current "final candidate" "$next_version" "$next_root"
assert_preserved "final candidate"
check "final publisher credential retired" "$([ ! -e "$HOME/.config/omp-session-gateway/publisher-token" ] && echo absent || echo present)" absent
show "OMP binary rollback" "not performed; gateway-only recovery"
printf '\n   %d/%d invariants PASS\n' "$CHECKS" "$CHECKS"
REMOTE
}

lane_uninstall() {
  step "Lane 6: uninstall from the artifact"
  remote_user GATEWAY_PORT="$GATEWAY_PORT" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }
root="$(cat ~/runtime-root)"
bun=~/.bun/bin/bun
cli="$root/apps/gateway/src/cli.js"

if "$bun" "$cli" uninstall --no-stop >/dev/null 2>&1; then
  echo "uninstall --no-stop succeeded while the service was active; it is required to refuse" >&2
  exit 1
fi
show "uninstall --no-stop while active" "refused, as required"

"$bun" "$cli" uninstall >/dev/null
show "uninstall" "completed"
show "is-enabled" "$(systemctl --user is-enabled omp-session-gateway.service 2>&1 || true)"
show "unit file still present" "$(test -e "$HOME/.config/systemd/user/omp-session-gateway.service" && echo yes || echo no)"
show "remaining gateway pids" "$(pgrep -u "$(id -u)" -f 'cli.js serve' | tr '\n' ' ' | grep . || echo none)"
show "listeners on gateway port" "$(ss -ltnH "sport = :${GATEWAY_PORT}" | awk '{print $4}' | tr '\n' ' ' | grep . || echo none)"
tailscale serve reset >/dev/null 2>&1 || true
show "serve mapping after reset" "$(tailscale serve status 2>&1 | head -1)"
REMOTE
}

# Lane `init`: what the installer does on a host whose init system it does not support.
#
# apps/gateway/src/service.ts builds a systemd user unit for every `linux` platform and then drives
# `systemctl --user daemon-reload`, `enable`, and `start`. Nothing in that path inspects the init
# system, so on an OpenRC host `install` cannot succeed. This lane exists because "cannot succeed" has
# two very different shapes and the ledger needs to know which one is real: a refusal that leaves the
# machine as it found it, or a partial install that reports failure while leaving a token, a staged
# runtime, and possibly a listener behind.
#
# A NON-ZERO install exit is therefore the expected, successful outcome of this lane. Only three things
# are asserted, and each is a safety property rather than a message: the install refused, no gateway
# process survives, and nothing is listening. Everything else — the verbatim message, the residue, and
# how `status`, `doctor`, and `uninstall` behave afterwards — is measured and printed for the lead to
# read, because those are the findings, and asserting a predicted answer would hide a surprise.
#
# This lane implements no OpenRC backend and its passing must not be read as OpenRC being supported.
lane_init() {
  step "Lane 7: install on a host with no systemd"
  remote_user GATEWAY_PORT="$GATEWAY_PORT" ORIGIN="$OPENRC_SYNTHETIC_ORIGIN" \
    ALLOWED_LOGIN="$SYNTHETIC_DENIED_LOGIN" <<'REMOTE'
show() { printf '   %-38s %s\n' "$1:" "$2"; }

# Measured, never inferred from OMP_QUAL_INIT: the knob shaped provisioning, the machine decides what
# is running now.
. /etc/os-release
show "distribution" "${PRETTY_NAME:-unknown}"
show "kernel" "$(uname -srm)"
show "pid 1" "$(tr '\0' ' ' </proc/1/cmdline | awk '{print $1}')"
show "/run/systemd/system" "$(test -d /run/systemd/system && echo present || echo absent)"
show "systemctl on PATH" "$(command -v systemctl || echo absent)"
show "rc-service on PATH" "$(command -v rc-service || echo absent)"
show "rc-status default runlevel" "$(rc-status -s 2>/dev/null | wc -l | tr -d ' ') services listed"

if [ -d /run/systemd/system ]; then
  show "verdict" "systemd is running here, so there is no refusal to observe"
  echo "   This lane measures the installer on a NON-systemd host. On systemd the applicable lane is"
  echo "   'lifecycle', which installs for real; running this one would only duplicate it."
  exit 0
fi

if [ ! -f ~/runtime-root ]; then
  echo "no extracted artifact on this droplet: run lane 'artifact' before lane 'init'" >&2
  exit 1
fi
root="$(cat ~/runtime-root)"
bun=~/.bun/bin/bun
cli="$root/apps/gateway/src/cli.js"
unit="$HOME/.config/systemd/user/omp-session-gateway.service"
config_dir="$HOME/.config/omp-session-gateway"
state_dir="$HOME/.local/state/omp-session-gateway"

# The runtime's own portability is a separate question from the service manager's, and it is answered
# for free: this is Bun's musl build, and every CLI invocation below is that binary executing the
# archive's JavaScript. `ldd --version` exits non-zero on musl, hence the guard.
show "bun version" "$("$bun" --version)"
show "libc" "$(ldd --version 2>&1 | head -1 || true)"
show "XDG_RUNTIME_DIR" "${XDG_RUNTIME_DIR:-<unset>}"
show "unit before install" "$(test -e "$unit" && echo present || echo absent)"
show "config dir before install" "$(test -d "$config_dir" && echo present || echo absent)"

# Capture the failure instead of dying on it: the message is the evidence this lane exists to collect.
install_log="$(mktemp)"
install_status=0
"$bun" "$cli" install --origin "$ORIGIN" --allow "$ALLOWED_LOGIN" >"$install_log" 2>&1 || install_status=$?
show "install exit status" "$install_status"
show "install output bytes" "$(wc -c <"$install_log" | tr -d ' ')"
printf '   install output, verbatim:\n'
sed 's/^/     | /' "$install_log"
rm -f "$install_log"

# Residue. Printed rather than asserted: whether a systemd unit is written on a machine with no
# systemd, and whether a token and a staged runtime outlive the refusal, are the open questions.
show "unit after install" "$(test -e "$unit" && echo present || echo absent)"
show "config.json after install" "$(test -e "$config_dir/config.json" && stat -c 'mode %a' "$config_dir/config.json" || echo absent)"
show "readiness-token after install" "$(test -e "$config_dir/readiness-token" && stat -c 'mode %a, %s bytes' "$config_dir/readiness-token" || echo absent)"
# busybox `find` has no `-printf`, and `ls` would miscount a name containing a newline, so count
# directory entries with the intersection of GNU and busybox `find` that both support.
show "staged version dirs" "$(find "$state_dir/installation/versions" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
show "installation/current.json" "$(test -e "$state_dir/installation/current.json" && echo present || echo absent)"

# busybox `pgrep` has no `-u`, and the point of this droplet is that its userland is not the familiar
# one, so read /proc directly rather than depend on procps being packaged under a particular name.
# The glob is expanded once, before any helper in the loop exists, so the loop cannot match itself.
pids=""
for entry in /proc/[0-9]*; do
  [ -r "$entry/cmdline" ] || continue
  if tr '\0' ' ' <"$entry/cmdline" 2>/dev/null | grep -q 'cli\.js serve'; then
    pids="$pids ${entry#/proc/}"
  fi
done
pids="${pids# }"
show "gateway processes" "${pids:-none}"

# Assert on curl's exit status, not its stdout: `-w '%{http_code}'` still prints `000` when the
# connection is refused, so the stdout of a failed probe is "000" *and* whatever the `||` branch adds.
# The exit status is the unambiguous statement that nothing answered, and both numbers are printed.
probe_status=0
probe_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${GATEWAY_PORT}/api/v1/sessions" 2>/dev/null)" || probe_status=$?
show "loopback probe curl exit / code" "$probe_status / ${probe_code:-<none>}"
if command -v ss >/dev/null 2>&1; then
  show "listeners on gateway port" "$(ss -ltnH "sport = :${GATEWAY_PORT}" | awk '{print $4}' | tr '\n' ' ' | grep . || echo none)"
else
  show "listeners on gateway port" "ss unavailable; the loopback probe above is the measurement"
fi

# How the rest of the CLI behaves after the refusal. All three are measurements: an operator who hits
# this will run exactly these commands next, and what they print is part of whether the refusal is
# intelligible or merely non-zero.
status_status=0
status_out="$("$bun" "$cli" status 2>&1)" || status_status=$?
show "status exit status" "$status_status"
show "status output" "$(printf '%s' "$status_out" | tr '\n' ' ' | cut -c1-160)"

doctor_status=0
doctor_out="$("$bun" "$cli" doctor 2>&1)" || doctor_status=$?
show "doctor exit status" "$doctor_status"
show "doctor output" "$(printf '%s' "$doctor_out" | tr '\n' ' ' | cut -c1-240)"

uninstall_status=0
uninstall_out="$("$bun" "$cli" uninstall 2>&1)" || uninstall_status=$?
show "uninstall exit status" "$uninstall_status"
show "uninstall output" "$(printf '%s' "$uninstall_out" | tr '\n' ' ' | cut -c1-240)"
show "unit after uninstall" "$(test -e "$unit" && echo present || echo absent)"

fail=0
check() {
  if [ "$2" = "$3" ]; then printf '   %-44s %-24s %s\n' "$1" "$2" PASS
  else printf '   %-44s %-24s %s\n' "$1" "expected $3, got $2" FAIL; fail=1; fi
}
printf '\n   %-44s %-24s %s\n' INVARIANT OBSERVED RESULT
check "install refused" "$([ "$install_status" -ne 0 ] && echo refused || echo accepted)" refused
check "no gateway process survives" "${pids:-none}" none
check "nothing answers on the gateway port" "$([ "$probe_status" -ne 0 ] && echo refused || echo "http $probe_code")" refused

[ "$fail" -eq 0 ] || { echo "the refusal was not clean; read the FAIL rows above" >&2; exit 1; }
REMOTE
  note "A non-zero install with nothing left running is this lane PASSING. The Linux service backend"
  note "is systemd-only and must refuse rather than half-install; the rows above say whether it does."
  note "Nothing here implements or implies OpenRC support."
}

cmd_qualify() {
  local lane lanes="$*"
  # The default set follows the init system, because on a non-systemd host every lane after `artifact`
  # presumes an install that is expected to be refused. A bare `qualify` there would spend twenty
  # minutes of droplet time failing six lanes for the same already-known reason.
  if [ -z "$lanes" ]; then
    if [ "$QUAL_INIT" = "openrc" ]; then
      lanes="host artifact init"
    else
      lanes="host artifact lifecycle omp migration rollback identity persistence uninstall"
    fi
  fi
  # Reject a typo, and an impossible lane, before anything slow or billable is touched.
  for lane in $lanes; do
    case "$lane" in
      host | artifact | init) ;;
      lifecycle | omp | migration | rollback | identity | persistence | uninstall)
        [ "$QUAL_INIT" != "openrc" ] ||
          die "lane '$lane' needs an installed service, and on a non-systemd host the install is expected to be refused. Run 'host artifact init' instead, or unset OMP_QUAL_INIT to qualify a systemd droplet."
        ;;
      *) die "unknown lane '$lane'; choose from host artifact lifecycle omp migration rollback identity persistence uninstall init" ;;
    esac
  done

  preflight_tools
  init_ssh_options
  HOURLY_RATE="$(size_hourly_rate)"
  require_droplet
  LOCAL_TEMP="$(mktemp -d)"
  measure "droplet" "$DROPLET_NAME at $DROPLET_IP"
  measure "lanes" "$lanes"

  for lane in $lanes; do
    case "$lane" in
      host) lane_host ;;
      artifact) lane_artifact ;;
      lifecycle) lane_lifecycle ;;
      omp) lane_omp ;;
      migration) lane_migration ;;
      rollback) lane_rollback ;;
      identity) lane_identity ;;
      persistence) lane_persistence ;;
      uninstall) lane_uninstall ;;
      init) lane_init ;;
      *) die "unknown lane '$lane'; choose from host artifact lifecycle omp migration rollback identity persistence uninstall init" ;;
    esac
  done

  step "Qualification lanes finished"
  note "Every line above is a measurement, not a verdict. Nothing here promotes a ledger row."
  note "Record the numbers against the candidate tag, then run '$0 destroy'."
}

main() {
  local command="${1:-}"
  [ -n "$command" ] || die "usage: $0 <provision|qualify|destroy|status>"
  shift
  trap on_exit EXIT
  case "$command" in
    provision) cmd_provision "$@" ;;
    qualify) cmd_qualify "$@" ;;
    destroy) cmd_destroy "$@" ;;
    status) cmd_status "$@" ;;
    *) die "unknown command '$command'; expected provision, qualify, destroy, or status" ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
