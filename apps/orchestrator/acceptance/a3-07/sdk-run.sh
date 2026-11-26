#!/usr/bin/env bash
set -euo pipefail
base=${BENTO_A307_GATEWAY_DIR:?Set the isolated Gateway SDK and client directory}
gateway=${BENTO_A307_GATEWAY_NAMESPACE:?Set the isolated Gateway sandbox namespace}
lease=$(printf "a307-%x-%x" "$(date +%s)" "$(($$ % 65536))")
sandbox="$lease"
vol="$lease-vol"
controller="$lease-controller"
image=node:24.19.0-bookworm-slim
mkdir sdk-case
run() { docker run --network host --label "bento.a307.lease=$lease" -v "$PWD:/lease" -v "$base/sdk:/gateway/sdk:ro" -v "$base/client:/gateway/client:ro" -e "A307_GATEWAY_URL=${BENTO_A307_GATEWAY_URL:-https://127.0.0.1:24761}" -e "A307_SANDBOX=$sandbox" -e "A307_VOLUME=$vol" -w /lease/sdk-case "$@"; }
driver() { run --rm "$image" node /lease/sdk-control.mjs "$@"; }
case_run() { run --rm "$image" node --import /lease/src/register-paths.mjs /lease/sdk-case.mjs "$@"; }
cleanup() {
    docker rm -f "$controller" >/dev/null 2>&1 || :
    driver delete >/dev/null 2>&1 || :
    docker volume rm "$vol" >/dev/null 2>&1 || :
}
trap cleanup EXIT
docker volume create --label "bento.a307.lease=$lease" --label openshell.ai/sandbox-attachable=true --label openshell.ai/sandbox-attachable-workspace=default "$vol" >/dev/null
driver create
run -d --name "$controller" "$image" node --import /lease/src/register-paths.mjs /lease/sdk-case.mjs initial >/dev/null
for i in $(seq 1 120); do [[ ! -f sdk-case/rpc-dispatched ]] || break; sleep .1; done
if [[ ! -f sdk-case/rpc-dispatched ]]; then docker logs "$controller" 2>&1 | tail -20; exit 1; fi
case_run pending
driver broker-start >sdk-case/broker.log &
broker=$!
for i in $(seq 1 400); do [[ ! -f sdk-case/rpc-sent ]] || break; sleep .01; done
test -f sdk-case/rpc-sent
test ! -f sdk-case/rpc-returned
docker kill --signal KILL "$controller" >/dev/null
date +%s%3N >sdk-case/controller-killed
wait "$broker"
test "$(cat sdk-case/controller-killed)" -lt "$(cat sdk-case/rpc-returned)"
test "$(cat sdk-case/controller-killed)" -lt "$(cat sdk-case/rpc-ready)"
echo 'controller killed while real SDK StartSandbox RPC outstanding'
test "$(docker inspect --format '{{.State.ExitCode}}' "$controller")" = 137
ids() { docker ps -q --no-trunc --filter "label=openshell.ai/sandbox-namespace=$gateway" --filter "label=openshell.ai/sandbox-name=$sandbox" | sort; }
before=$(ids)
test -n "$before"
sent=$(cat sdk-case/rpc-sent)
ready=$(cat sdk-case/rpc-ready)
kill=$(cat sdk-case/controller-killed)
docker events --since "$((sent/1000))" --until "$((ready/1000+1))" \
    --filter type=container --filter event=start \
    --filter "label=openshell.ai/sandbox-namespace=$gateway" \
    --filter "label=openshell.ai/sandbox-name=$sandbox" \
    --format '{{.TimeNano}} {{.ID}}' >sdk-case/docker-start-events
test "$(awk '{print $2}' sdk-case/docker-start-events | sort)" = "$before"
python3 - "$sent" "$kill" "$ready" <<'PYTIME'
from pathlib import Path
import sys
sent, killed, ready = map(int, sys.argv[1:])
events = [int(line.split()[0]) // 1000000 for line in Path('sdk-case/docker-start-events').read_text().splitlines()]
assert any(killed < event <= ready for event in events), events
print(f"controller killed at +{killed-sent} ms; latest Docker start event at +{max(events)-sent} ms; SDK READY at +{ready-sent} ms")
PYTIME
docker inspect --format '{{range .Mounts}}{{println .Name}}{{end}}' $before | grep -Fx "$vol" >/dev/null
case_run restart
test "$(ids)" = "$before"
test "$(cat sdk-case/rpc-dispatched)" = 1
python3 - <<'PY'
import sqlite3
with sqlite3.connect('file:sdk-case/authority.sqlite?mode=ro', uri=True) as db:
    assert db.execute('select generation,state,run from execution_sessions').fetchall() == [(2,'READY',None)]
    assert db.execute('select generation,operation from management_starts').fetchall() == [(2,'start')]
print('SDK startup: one reservation and unchanged Docker target IDs')
PY
cleanup
test -z "$(ids)"
test -z "$(docker volume ls -q --filter "label=bento.a307.lease=$lease")"
