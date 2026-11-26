#!/usr/bin/env bash
set -euo pipefail
lease=${PWD##*/}
image=node:24.19.0-bookworm-slim
target=$lease-target
controller=$lease-controller
run() { docker run --network none --label "bento.a307.lease=$lease" -v "$PWD:/lease" "$@"; }
cleanup() { docker rm -f "$controller" "$target" >/dev/null 2>&1 || :; }
trap cleanup EXIT
for scenario in inflight rapid race; do
    mkdir "$scenario"
    payload='printf "started\n" >>/data/count; exec sleep 90'
    if [[ $scenario == rapid ]]; then payload='printf "started\n" >>/data/count; exit 17'; fi
    id=$(docker create --network none --label "bento.a307.lease=$lease" --name "$target" -v "$PWD/$scenario:/data" "$image" sh -c "$payload")
    run -d --name "$controller" -w "/lease/$scenario" "$image" node --import /lease/src/register-paths.mjs /lease/case.mjs initial >/dev/null
    for i in $(seq 1 120); do [[ ! -f $scenario/start-request ]] || break; sleep .1; done
    if [[ ! -f $scenario/start-request ]]; then docker logs "$controller" 2>&1 | tail -15; exit 1; fi
    trial() { run --rm -w "/lease/$scenario" "$image" node --import /lease/src/register-paths.mjs /lease/case.mjs "$@"; }
    if [[ $scenario == inflight ]]; then trial pending false; fi
    # Keep a docker client attached to the exact start while the controller is killed.
    docker start -a "$id" >"$scenario/docker-start.log" 2>&1 &
    start_pid=$!
    for i in $(seq 1 120); do [[ ! -f $scenario/count ]] || break; sleep .1; done
    test -f "$scenario/count"
    if [[ $scenario == inflight ]]; then kill -0 "$start_pid"; fi
    docker kill --signal KILL "$controller" >/dev/null
    test "$(docker inspect --format '{{.State.ExitCode}}' "$controller")" = 137
    if [[ $scenario == rapid ]]; then
        wait "$start_pid" || test "$?" = 17
        test "$(docker inspect --format '{{.State.ExitCode}}' "$id")" = 17
        trial pending "$(docker inspect --format '{{.State.Running}}' "$id")"
    elif [[ $scenario == race ]]; then
        observed=$(docker inspect --format '{{.State.Running}}' "$id")
        trial race "$observed" >"$scenario/one" & first=$!
        trial race "$observed" >"$scenario/two" & second=$!
        wait "$first"
        wait "$second"
        cat "$scenario/one" "$scenario/two"
        grep -Fx 'READY generation 2' "$scenario/one" "$scenario/two"
        trial race-check
    else
        trial restart "$(docker inspect --format '{{.State.Running}}' "$id")"
    fi
    test "$(wc -l <"$scenario/count")" -eq 1
    test "$(docker inspect --format '{{.Id}}' "$target")" = "$id"
    printf '%s: same target, one physical side effect\n' "$scenario"
    cleanup
    wait "$start_pid" || :
done
test -z "$(docker ps -aq --filter "label=bento.a307.lease=$lease")"
python3 - <<'PY'
import sqlite3

for scenario, expected in (
    ("inflight", (2, "READY", None)),
    ("rapid", (1, "START_UNKNOWN", "run")),
    ("race", (2, "READY", None)),
):
    with sqlite3.connect(f"file:{scenario}/authority.sqlite?mode=ro", uri=True) as db:
        current = db.execute("SELECT generation, state, run FROM execution_sessions").fetchall()
        starts = db.execute("SELECT generation, operation, controller FROM management_starts").fetchall()
        assert current == [expected], (scenario, current)
        assert starts == [(2, "start", "single-host")], (scenario, starts)
        print(f"{scenario}: {expected[1]}, one start reservation")
PY
