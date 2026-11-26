#!/usr/bin/env bash
set -euo pipefail

root=${BENTO_A304_GATEWAY_DIR:?Set the private OpenShell Gateway directory}
owner=${BENTO_A304_GATEWAY_NAMESPACE:?Set the isolated Gateway namespace}
sandbox=${BENTO_A304_SANDBOX:?Set the stopped probe sandbox}
volume=${BENTO_A304_VOLUME:?Set the dedicated probe volume}
candidate=${BENTO_A304_CANDIDATE:?Set the candidate with mounted Gateway SDK and client certificates}
driver=${BENTO_A304_DRIVER:-$(dirname "$0")/freeze-case.mjs}
export XDG_CONFIG_HOME="$root/xdg-config" XDG_DATA_HOME="$root/xdg-data" XDG_STATE_HOME="$root/xdg-state"
cli() { timeout 15 "$root/inputs/openshell" -g "$owner" "$@" </dev/null; }
exec 9>"$root/a304-probe.lock"
flock -n 9
test "$(cli sandbox list | awk -v name="$sandbox" '$1==name{print $NF}')" = Stopped
suffix="$(date +%s)x$$"
log="$(mktemp)"
sandbox_id=
own() { test "$(docker inspect -f '{{index .Config.Labels "openshell.ai/sandbox-namespace"}}/{{index .Config.Labels "openshell.ai/isolation-role"}}' "$sandbox_id")" = "$owner/sandbox"; }
cleanup() {
  docker exec "$candidate" rm -f "/tmp/a304-fenced-$suffix" >/dev/null 2>&1 || true
  if test -n "$sandbox_id" && own && test "$(docker inspect -f '{{.State.Paused}}' "$sandbox_id")" = true; then docker kill --signal KILL "$sandbox_id" >/dev/null 2>&1 || true; fi
  cli sandbox stop "$sandbox" >/dev/null 2>&1 || true
  docker run --rm --network none --label bento.acceptance=a3-04 --mount "type=volume,src=$volume,dst=/proof" node:24.19.0-bookworm-slim rm -f "/proof/a304-$suffix.before" "/proof/a304-$suffix.ready" "/proof/a304-$suffix.after" >/dev/null 2>&1 || true
  rm -f "$log"
}
trap cleanup EXIT
cli sandbox start "$sandbox" >/dev/null 2>&1
for i in $(seq 1 15); do cli sandbox exec "$sandbox" -- true >/dev/null 2>&1 && break; sleep 1; done
sandbox_id="$(docker ps --no-trunc -q --filter "volume=$volume" --filter "label=openshell.ai/sandbox-namespace=$owner" --filter "label=openshell.ai/sandbox-name=$sandbox" --filter label=openshell.ai/isolation-role=sandbox)"
test "$(printf '%s' "$sandbox_id" | wc -c)" -eq 64
own
docker exec -e A304_SUFFIX="$suffix" -e A304_SANDBOX="$sandbox" -e A304_VOLUME="$volume" -e "A304_GATEWAY_URL=${BENTO_A304_GATEWAY_URL:-https://127.0.0.1:28881}" -i "$candidate" node --disable-warning=ExperimentalWarning --experimental-strip-types --import ./register-paths.mjs --input-type=module >"$log" 2>&1 <"$driver" &
probe_pid=$!
for i in $(seq 1 120); do grep -Fxq A304_FENCE_READY "$log" && break; kill -0 "$probe_pid" 2>/dev/null || break; sleep 0.02; done
if ! grep -Fxq A304_FENCE_READY "$log"; then cat "$log"; exit 3; fi
own
docker pause "$sandbox_id" >/dev/null
test "$(docker inspect -f '{{.State.Paused}}' "$sandbox_id")" = true
docker exec "$candidate" touch "/tmp/a304-fenced-$suffix"
wait "$probe_pid" || { cat "$log"; exit 4; }
grep -Fx A304_REVOCATION_AFTER_CONFIRMED_FREEZE "$log"
sleep 4
own
test "$(docker inspect -f '{{.State.Paused}}' "$sandbox_id")" = true
docker run --rm --network none --read-only --label bento.owner=bento-worker-a --mount "type=volume,src=$volume,dst=/proof,readonly" node:24.19.0-bookworm-slim sh -c 'test -f "$1.ready" && test "$(cat "$1.before")" = positive && test ! -e "$1.after"' sh "/proof/a304-$suffix"
echo A304_VOLUME_UNCHANGED_PAST_CHILD_DEADLINE_WHILE_FROZEN
docker kill --signal KILL "$sandbox_id" >/dev/null
test "$(docker inspect -f '{{.State.Running}}' "$sandbox_id")" = false
cli sandbox stop "$sandbox" >/dev/null 2>&1 || true
test "$(cli sandbox list | awk -v name="$sandbox" '$1==name{print $NF}')" = Stopped
test -z "$(docker ps -q --filter "volume=$volume")"
echo A304_KILLED_FROZEN_INSTANCE_GATEWAY_STOPPED_ZERO_WRITERS
