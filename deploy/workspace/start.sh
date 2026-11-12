#!/bin/bash
set -euo pipefail

# The API port and bind address are private to this container.
export BENTO_ONE_PORT=4101
nginx -t -c /etc/nginx/bento.conf

go_pid=
api_pid=
nginx_pid=

stop() {
    trap '' TERM INT

    if [[ -n "$nginx_pid" ]] && kill -0 "$nginx_pid" 2>/dev/null; then
        kill -QUIT "$nginx_pid" 2>/dev/null || true
        wait "$nginx_pid" || true
    fi
    if [[ -n "$api_pid" ]] && kill -0 "$api_pid" 2>/dev/null; then
        kill -TERM "$api_pid" 2>/dev/null || true
        wait "$api_pid" || true
    fi
    if [[ -n "$go_pid" ]] && kill -0 "$go_pid" 2>/dev/null; then
        kill -TERM "$go_pid" 2>/dev/null || true
        wait "$go_pid" || true
    fi
}

trap 'stop; exit 0' TERM INT

nginx -c /etc/nginx/bento.conf -g 'daemon off;' &
nginx_pid=$!
bento-web-api &
go_pid=$!
node apps/workspace/api/main.ts &
api_pid=$!

# Exit when any child stops so Docker can restart the service.
status=0
wait -n "$api_pid" "$go_pid" "$nginx_pid" || status=$?
stop
if (( status == 0 )); then
    status=1
fi
exit "$status"
