#!/bin/bash
# Private per-command ownership shared by TypeScript and the retained-Mac shell harness.
# Run and settle travel over independent SSH sessions. No credentials enter this protocol.
set -u
mode="${1:-}"; id="${2:-}"; shift 2 || exit 125
[[ "$id" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]] || exit 125
case "$mode" in run|run-reboot|settle) ;; *) exit 125 ;; esac
umask 077
owner="$HOME/.local/state/omp-qualification/command-owners/$id"
mkdir -p "$owner" || exit 125
boot="$(/usr/sbin/sysctl -n kern.bootsessionuuid 2>/dev/null || /bin/cat /proc/sys/kernel/random/boot_id 2>/dev/null)" || exit 125
[ -n "$boot" ] || exit 125
if [ "$mode" = settle ]; then
  : > "$owner/cancel" || exit 125
  claimed=0
  if mkdir "$owner/admission" 2>/dev/null; then claimed=1; fi
  if [ -s "$owner/boot" ]; then
    read -r admitted_boot < "$owner/boot" || exit 125
    # A reboot proves termination even if the new kernel reused an old process-group ID.
    if [ "$admitted_boot" != "$boot" ]; then rm -rf "$owner"; exit 0; fi
  fi
  # 97 is the caller's closed pre-handoff guard refusal; all other reboot exits need boot proof.
  if [ -e "$owner/reboot" ]; then
    [ "$(cat "$owner/done" 2>/dev/null)" = 97 ] || exit 125
    rm -f "$owner/reboot" || exit 125
  fi
  for ((i=0; i<50; i++)); do
    [ -s "$owner/pgid" ] && break
    if [ -e "$owner/done" ] && [ ! -e "$owner/launching" ]; then rm -rf "$owner"; exit 0; fi
    # Keep the cancel tombstone to fence an SSH launch that has not reached admission yet.
    if [ "$claimed" = 1 ] && [ ! -e "$owner/launching" ]; then exit 0; fi
    sleep .1
  done
  read -r pgid < "$owner/pgid" || exit 125
  case "$pgid" in ''|*[!0-9]*) exit 125 ;; esac
  [ "$pgid" -gt 1 ] || exit 125
  # A done marker proves only the leader exited. Check the entire group on every path.
  if ! kill -0 -- -"$pgid" 2>/dev/null; then rm -rf "$owner"; exit 0; fi
  kill -TERM -- -"$pgid" 2>/dev/null || :
  for ((i=0; i<100; i++)); do
    if ! kill -0 -- -"$pgid" 2>/dev/null; then rm -rf "$owner"; exit 0; fi
    sleep .1
  done
  kill -KILL -- -"$pgid" 2>/dev/null || :
  for ((i=0; i<50; i++)); do
    if ! kill -0 -- -"$pgid" 2>/dev/null; then rm -rf "$owner"; exit 0; fi
    sleep .1
  done
  exit 125
fi
pgid=
trap 'status=$?; trap - EXIT; printf "%s\n" "$status" > "$owner/done"; exit "$status"' EXIT
trap 'if [ -n "$pgid" ]; then kill -TERM -- -"$pgid" 2>/dev/null; wait "$pgid" 2>/dev/null; fi; exit 125' HUP INT TERM
mkdir "$owner/admission" 2>/dev/null || exit 125
[ ! -e "$owner/cancel" ] || exit 125
printf '%s\n' "$boot" > "$owner/boot" || exit 125
if [ "$mode" = run-reboot ]; then : > "$owner/reboot" || exit 125; fi
set -m
: > "$owner/launching" || exit 125
/bin/bash -c '
owner=$1; shift
for ((i=0; i<100; i++)); do
  [ -e "$owner/cancel" ] && exit 125
  if [ -e "$owner/go" ]; then exec "$@"; fi
  sleep .05
done
exit 125
' -- "$owner" "$@" <&0 &
pgid=$!
# The group already exists; non-PTY owners need no monitor notifications in their evidence.
if [ ! -t 0 ]; then set +m; fi
if ! printf '%s\n' "$pgid" > "$owner/pgid.tmp" || ! mv "$owner/pgid.tmp" "$owner/pgid" || ! : > "$owner/go"; then
  kill -TERM -- -"$pgid" 2>/dev/null
  wait "$pgid" 2>/dev/null
  exit 125
fi
rmdir "$owner/admission"
# A stock-OMP reader needs the foreground PTY group. Plain SSH stdin remains a pipe.
if [ -t 0 ]; then fg %1 >/dev/null; else wait "$pgid"; fi
exit "$?"
