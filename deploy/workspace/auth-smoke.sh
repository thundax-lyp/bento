#!/bin/bash
set -euo pipefail

prefix="bento-auth-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
mysql_container="$prefix-mysql"
network_id=
mysql_id=

cleanup() {
    if [[ -n "$mysql_id" ]]; then docker rm -f "$mysql_id" >/dev/null; fi
    if [[ -n "$network_id" ]]; then docker network rm "$network_id" >/dev/null; fi
}
trap cleanup EXIT

if docker network inspect "$prefix" >/dev/null 2>&1; then
    echo "Auth smoke network already exists" >&2
    exit 1
fi
for name in "$mysql_container" "$prefix-web" "$prefix-missing"; do
    if docker container inspect "$name" >/dev/null 2>&1; then
        echo "Auth smoke container already exists" >&2
        exit 1
    fi
done

network_id="$(docker network create "$prefix")"
mysql_id="$(docker run --detach --name "$mysql_container" --network "$network_id" \
    --tmpfs /var/lib/mysql --env MYSQL_DATABASE=bento --env MYSQL_USER=bento \
    --env MYSQL_PASSWORD=fixture-only --env MYSQL_RANDOM_ROOT_PASSWORD=yes mysql:8.4)"
deadline=$((SECONDS + 90))
until docker exec -e MYSQL_PWD=fixture-only "$mysql_id" \
    mysql --protocol=tcp --connect-timeout=1 -h 127.0.0.1 -u bento bento -e 'SELECT 1' >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
        echo "Auth smoke MySQL did not become ready" >&2
        exit 1
    fi
    sleep 1
done

run_smoke() {
    local name="$1"
    local mode="$2"
    shift 2
    docker run --rm --name "$name" --network "$network_id" \
        --env "BENTO_MYSQL_HOST=$mysql_container:3306" \
        --env BENTO_MYSQL_USER=bento --env BENTO_MYSQL_DATABASE=bento \
        --env BENTO_MYSQL_PASSWORD=fixture-only \
        --mount "type=bind,source=$PWD/deploy/workspace/auth-smoke.mjs,target=/tmp/bento-auth-smoke/auth-smoke.mjs,readonly" \
        --mount "type=bind,source=$PWD/apps/workspace/api/oidc-fixture.ts,target=/tmp/bento-auth-smoke/oidc-fixture.ts,readonly" \
        "$@" --entrypoint node bento-web:local /tmp/bento-auth-smoke/auth-smoke.mjs "$mode"
}

run_smoke "$prefix-web" --normal
run_smoke "$prefix-missing" --missing-artifacts --tmpfs /app/apps/workspace/auth/dist
