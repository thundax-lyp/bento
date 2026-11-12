#!/bin/bash
set -euo pipefail

# The API port and bind address are private to this container.
export BENTO_ONE_PORT=4101
nginx -t -c /etc/nginx/bento.conf

go_pid=
api_pid=
nginx_pid=
discovery_pid=

stop() {
    trap '' TERM INT

    if [[ -n "$discovery_pid" ]]; then
        kill -TERM "$discovery_pid" 2>/dev/null || true
        wait "$discovery_pid" || true
    fi

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

# The local issuer is served through the NGINX listener we just started.
case "${BENTO_OIDC_ISSUER:-}" in
    http://127.0.0.1:8080/identity/realms/*)
        node --input-type=module <<'JS' &
import { setTimeout } from 'node:timers/promises';

const issuer = process.env.BENTO_OIDC_ISSUER.replace(/\/$/, '');
const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
    try {
        const response = await fetch(issuer + '/.well-known/openid-configuration', {
            signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, deadline - Date.now()))),
        });
        if (response.ok && (await response.json()).issuer === issuer) process.exit(0);
        await response.body?.cancel();
    } catch {
        // NGINX or the identity upstream may still be starting.
    }
    await setTimeout(250);
}
console.error('Bento local OIDC discovery did not become ready.');
process.exitCode = 1;
JS
        discovery_pid=$!
        if ! wait "$discovery_pid"; then
            discovery_pid=
            stop
            exit 1
        fi
        discovery_pid=
        ;;
esac

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
