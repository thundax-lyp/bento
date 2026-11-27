#!/bin/bash
set -euo pipefail

nginx -t -c /etc/nginx/bento.conf

go_pid=
nginx_pid=

stop() {
    trap '' TERM INT

    if [[ -n "$nginx_pid" ]] && kill -0 "$nginx_pid" 2>/dev/null; then
        kill -QUIT "$nginx_pid" 2>/dev/null || true
        wait "$nginx_pid" || true
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
        deadline=$((SECONDS + 15))
        while ! curl -fsS --max-time 1 -o /dev/null "${BENTO_OIDC_ISSUER%/}/.well-known/openid-configuration"; do
            if (( SECONDS >= deadline )); then
                echo 'Bento local OIDC discovery did not become ready.' >&2
                stop
                exit 1
            fi
            sleep 0.25
        done
        ;;
esac

bento-web-api &
go_pid=$!
# Exit when any child stops so Docker can restart the service.
status=0
wait -n "$go_pid" "$nginx_pid" || status=$?
stop
if (( status == 0 )); then
    status=1
fi
exit "$status"
