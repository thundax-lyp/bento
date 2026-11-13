# A8 Web 镜像回滚演练

状态：已换源码基线，待独立复审，2026-11-13（Asia/Shanghai）。工作边界为 bento-b 基线 `1803ad643fde18a470ae6d08cb4d891b94e285c2`。本草稿仅供审阅。执行需 MASTER 放行。A6 与本任务共享 Readiness，更新前由 MASTER 协调基线和合入顺序。

## 目标与边界

在指定开发宿主使用独立 Compose 项目 `bento-b-a8-rollback`，验证同一源码构建的 Web 镜像健康启动、故障镜像触发原生健康检查、原镜像恢复。使用真实 Web 入口、真实 MySQL、合成账号及 Web 命名卷标记。业务模式为 mock。此演练的结论限于同版本镜像替换和两项合成持久数据。发布版本降级、数据库迁移、真实登录、Keycloak、Orchestrator、Temporal、OpenShell、S3、生产恢复、RPO/RTO、审计告警平台均在演练范围之外。A7 原有三库备份还原结论继续适用。

依据为[需求 A7/A8](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)、[执行链实施设计](APPLICATION-BOUNDARIES-DESIGN.md#执行链实施设计)、[部署手册](../../deploy/README.md#启动与检查)、[Readiness](../40-readiness/CURRENT-READINESS.md)及 [RUNBOOK 规则](../00-governance/RUNBOOK-RULES.md)。实际路径为 [Compose](../../deploy/compose.yaml) 的 `services.bento-web.build.dockerfile_inline` → [启动脚本](../../deploy/workspace/start.sh) → [NGINX 配置](../../deploy/workspace/nginx.conf) → [Go 入口](../../apps/workspace/api/go/main.go) 的 `main` 和 [账号初始化](../../apps/workspace/api/go/accounts.go) 的 `initializeAccounts`。原镜像的健康检查要求首页、匿名会话与 Go 健康端点依次返回 200、401、204。故障镜像只在 NGINX 加入 `/api/session` 的 503 路由，保持入口、其余配置和健康检查相同。

## 提交边界与启动入口

当前 `rev` 为 #39、#40 合入后的源码基线。从 `5c8ffb9` 到该提交，变更限于 `apps/orchestrator/execution-service/service.test.ts`、`apps/orchestrator/temporal_test.go`、`apps/workspace/api/space-files.test.ts` 和 Readiness。Orchestrator 测试在 Web 构建输入之外，`space-files.test.ts` 不进入当前 Docker 构建上下文。Compose 内联 Dockerfile、NGINX、服务入口、健康探针、Go 模块清单和 pnpm 锁文件均无变更。Readiness 新增 A6、WEB-04 证据，收口时保留这两项。正式审核须同时固定源码 `rev`、独立计划提交和本文 blob。执行分支从获审源码基线建立，计划提交只包含本文。执行过程中无代码提交。收口提交只包含部署手册、Readiness 及本文删除。任何额外路径都 STOP。

由获审计划提交所在的干净分支，在本地仓库根目录运行下列命令。这里的 `plan` 必须与 MASTER 放行的计划提交相同。固定 launcher 由获审计划中的五个 Bash 区块原样拼接。随后使用既有受控 SSH 入口，以 `bash --noprofile --norc` 执行 launcher。执行期间保留同一个 Bash 进程和锁。T0 记录启动后，第二条受控连接上传归档到私有目录，先写 `source.tar.part`，完成后在同一目录原子改名为 `source.tar`。launcher 最多等待 120 秒。SSH 必须使用既有受控身份和已验证主机密钥。

```sh
set -eu
rev=1803ad643fde18a470ae6d08cb4d891b94e285c2
plan=$(git rev-parse HEAD)
path=docs/30-designs/RUNBOOK-A8-WEB-IMAGE-ROLLBACK.md
test -z "$(git status --porcelain)"
git merge-base --is-ancestor "$rev" "$plan"
test "$(git rev-parse "$plan^")" = "$rev"
test "$(git diff-tree --no-commit-id --name-only -r "$plan")" = "$path"
git rev-parse "$plan:$path"
local_root=$(mktemp -d)
git archive --format=tar "$rev" > "$local_root/source.tar"
git show "$plan:$path" | awk '
    /^```bash$/ { copying=1; blocks++; next }
    copying && /^```$/ { copying=0; next }
    copying { print }
    END { if (copying || blocks != 5) exit 1 }
' > "$local_root/launcher.sh"
bash -n "$local_root/launcher.sh"
printf '%s\n' "$local_root"
```

## T0：核验宿主前提并持锁

2026-11-13 换基线后只读复查确认 Docker 28.1.1、Compose 2.35.1、linux/amd64，Docker 和 home 文件系统各可用约 8.8 TiB。回环端口 18084 空闲，目标项目标签下无容器（含停止）、网络或卷，默认网络、预计卷名、两个镜像标签、私有目录与锁文件均无冲突。Bash、Git、flock、timeout、ss、curl、sha256sum、awk、sed 和 tar 可用。以下为宿主当前本地镜像配置 ID。三者均为 linux/amd64，`RepoDigests` 为空。

| 标签 | 本地镜像 ID（sha256） |
| --- | --- |
| mysql:8.4 | bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb |
| node:22-bookworm-slim | b774d993885c47eca14db241ba8cc7e5789235142f76e4a2a6a65ec350a1bac0 |
| golang:1.25-bookworm | e3c6b02e53225e75dff3e6a3b4c0bf9567fe16564fb20a5f63d4e39361ee32e3 |

放行后在远端专用 Bash 会话运行以下命令，直到 T4 才退出。T0 文件范围仅为固定锁文件、私有目录与 `operations.log`。固定 flock 文件必须留存，所有演练执行者通过同一文件加锁。2026-11-13 的 T0 观察为只读，尚未创建锁文件。任何冲突、漂移或 SSH 身份验证失败均 STOP。每步在命令失败时立即退出，记录最后完成阶段及脱敏失败原因。禁止修改或读取共享项目配置与数据，禁止系统级 Docker 清理，禁止远端写入直到审核放行。

```bash
set -euo pipefail
p=bento-b-a8-rollback
rev=1803ad643fde18a470ae6d08cb4d891b94e285c2
root="$HOME/$p"
base="$p-web:base"
bad="$p-web:fault"
for command in bash git flock timeout ss curl sha256sum awk sed tar; do
    command -v "$command" >/dev/null
done
# 执行放行后开启专用 Bash；本文件锁在整个进程退出后释放。
(umask 077; touch "$HOME/.$p.lock")
exec 9<>"$HOME/.$p.lock"
flock -n 9
test ! -e "$root"
test "$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')" = linux/amd64
docker compose version --short
project_ids() {
    local kind=$1
    shift
    if [[ "$kind" != volume ]]; then set -- "$@" --no-trunc; fi
    docker "$kind" ls "$@" -q --filter "label=com.docker.compose.project=$p"
}
for kind in container network volume; do
    args=()
    if [[ "$kind" = container ]]; then args=(--all); fi
    ids=$(project_ids "$kind" "${args[@]}")
    test -z "$ids"
done
names=$(docker network ls --format '{{.Name}}')
test -z "$(awk -v name="${p}_default" '$0 == name' <<< "$names")"
names=$(docker volume ls --format '{{.Name}}')
for volume in web-data mysql-data; do
    test -z "$(awk -v name="${p}_$volume" '$0 == name' <<< "$names")"
done
tags=$(docker image ls --all --format '{{.Repository}}:{{.Tag}}')
for image in "$base" "$bad"; do
    test -z "$(awk -v name="$image" '$0 == name' <<< "$tags")"
done
listeners=$(ss -H -ltn '( sport = :18084 )')
test -z "$listeners"
image_id() { docker image inspect --format '{{.Id}}' "$1"; }
mysql_id=sha256:bced325a4ab7aec848f4688371c7433351dcb5dba26fbcc29c67727d898ae5cb
test "$(image_id mysql:8.4)" = "$mysql_id"
test "$(image_id node:22-bookworm-slim)" = sha256:b774d993885c47eca14db241ba8cc7e5789235142f76e4a2a6a65ec350a1bac0
test "$(image_id golang:1.25-bookworm)" = sha256:e3c6b02e53225e75dff3e6a3b4c0bf9567fe16564fb20a5f63d4e39361ee32e3
(umask 077; mkdir "$root")
cd "$root"
export DRILL_RUN
DRILL_RUN=$(cat /proc/sys/kernel/random/uuid)
label=org.bento.drill.run
export DRILL_WEB="$base"
phase=T1
rollback_pending=0
compose_started=0
completed=0
dc() { docker compose --env-file /dev/null -p "$p" -f "$root/compose.yaml" "$@"; }
record() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$root/operations.log"; }

owned_project() {
    local kind ids id template owner
    for kind in container network volume; do
        if [[ "$kind" = container ]]; then
            ids=$(project_ids "$kind" --all) || return
            template='{{index .Config.Labels "org.bento.drill.run"}}'
        else
            ids=$(project_ids "$kind") || return
            template='{{index .Labels "org.bento.drill.run"}}'
        fi
        for id in $ids; do
            owner=$(docker "$kind" inspect --format "$template" "$id") || return
            test "$owner" = "$DRILL_RUN" || return
        done
    done
}
restore_web() {
    export DRILL_WEB="$base"
    owned_project
    test "$(image_id "$base")" = "$base_id"
    dc up --no-deps --no-build --pull never --force-recreate -d --wait --wait-timeout 180 web
    restored=$(dc ps -q web)
    test "$(inspect '{{.Image}}' "$restored")" = "$base_id"
    test "$(status /)" = 200
    test "$(status /api/session)" = 401
}
cleanup() {
    local kind ids tag images id owner template
    if (( compose_started )); then
        owned_project
        # 精确删除本轮资源 ID，卷删除前复核本轮标签。
        for kind in container network volume; do
            if [[ "$kind" = container ]]; then
                ids=$(project_ids "$kind" --all)
                template='{{index .Config.Labels "org.bento.drill.run"}}'
            else
                ids=$(project_ids "$kind")
                template='{{index .Labels "org.bento.drill.run"}}'
            fi
            for id in $ids; do
                owner=$(docker "$kind" inspect --format "$template" "$id")
                test "$owner" = "$DRILL_RUN"
                if [[ "$kind" = container ]]; then docker stop "$id"; fi
                docker "$kind" rm "$id"
            done
        done
    fi
    for tag in "$bad" "$base"; do
        images=$(docker image ls --all --format '{{.Repository}}:{{.Tag}}')
        if [[ -n "$(awk -v name="$tag" '$0 == name' <<< "$images")" ]]; then
            id=$(image_id "$tag")
            owner=$(docker image inspect -f '{{index .Config.Labels "org.bento.drill.run"}}' "$id")
            test "$owner" = "$DRILL_RUN"
            test "$(image_id "$tag")" = "$id"
            docker image rm "$tag"
        fi
    done
    for kind in container network volume; do
        if [[ "$kind" = container ]]; then
            ids=$(project_ids "$kind" --all)
        else
            ids=$(project_ids "$kind")
        fi
        test -z "$ids"
    done
    listeners=$(ss -H -ltn '( sport = :18084 )')
    test -z "$listeners"
    record "cleanup project_objects=absent port=free"
}
finish() {
    local result=$? restore_result=0 cleanup_result
    trap - EXIT
    trap '' HUP INT TERM
    set +e
    if (( rollback_pending )); then
        (set -e; restore_web)
        restore_result=$?
        record "emergency_restore phase=$phase status=$restore_result"
    fi
    (set -e; cleanup)
    cleanup_result=$?
    if (( result || restore_result || cleanup_result || !completed )); then
        record "stop phase=$phase status=$result restore=$restore_result cleanup=$cleanup_result"
        exit 1
    fi
    set -e
    sha256sum operations.log input.sha256 compose.yaml row-before.txt row-after.txt \
        volume-before.txt volume-after.txt > evidence.sha256
    sha256sum -c evidence.sha256
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
record "start source=$rev run=$DRILL_RUN"
printf "%s\n" "T0 PASS: upload source archive"

```

## T1：生成隔离输入并构建镜像

文件范围为私有目录中的 `source.tar.part`、`source.tar`、`source/`、两份 Dockerfile、`fault.conf`、`fault-context/`、两份构建日志与 `input.sha256`。

允许写入仅限远端 `~/bento-b-a8-rollback`、本演练固定锁文件、两个镜像标签、构建缓存和无网络且自动删除的权限探针容器。通过受控 SSH 认证上传源码归档。归档由上述本地命令从获审源码生成。T0 创建私有目录后，通过第二条 SSH 连接上传为该目录的 `source.tar`，原执行 Bash 持续持锁。禁止上传本地未跟踪文件或部署配置。运行以下命令。保留构建日志在该私有目录，公开证据仅记录失败阶段和脱敏原因。

```bash
cd "$root"
deadline=$((SECONDS + 120))
while [[ ! -f source.tar ]] && (( SECONDS < deadline )); do sleep 1; done
test -f source.tar
mkdir source
test "$(git get-tar-commit-id < source.tar)" = "$rev"
tar -xpf source.tar -C source
awk '
    /dockerfile_inline: \|/ { copying = 1; next }
    copying && /^        image:/ { exit }
    copying { sub(/^                /, ""); gsub(/\$\$/, "$"); print }
' source/deploy/compose.yaml > Base.Dockerfile
grep -q '^HEALTHCHECK ' Base.Dockerfile
grep -q '^ENTRYPOINT ' Base.Dockerfile
phase=T1-base-build
timeout --kill-after=15s 20m docker build --progress=plain --no-cache --pull=false --label "org.opencontainers.image.revision=$rev" --label "$label=$DRILL_RUN" \
    -t "$base" -f Base.Dockerfile source > build-base.log 2>&1
phase=T1-fault-input
sed '/root \/srv\/bento;/a\
        location = /api/session { return 503; }
' source/deploy/workspace/nginx.conf > fault.conf
test "$(grep -Fc 'location = /api/session { return 503; }' fault.conf)" = 1
printf 'FROM %s\nCOPY --chmod=0644 fault.conf /etc/nginx/bento.conf\n' "$base" > Fault.Dockerfile
mkdir fault-context
cp fault.conf fault-context/fault.conf
phase=T1-fault-build
timeout --kill-after=15s 3m docker build --progress=plain --pull=false --label "$label=$DRILL_RUN" -t "$bad" -f Fault.Dockerfile fault-context > build-fault.log 2>&1
phase=T1-image-check
base_id=$(image_id "$base")
bad_id=$(image_id "$bad")
test "$base_id" != "$bad_id"
test "$(docker image inspect -f '{{json .Config.Healthcheck}}' "$base_id")" = \
     "$(docker image inspect -f '{{json .Config.Healthcheck}}' "$bad_id")"
test "$(docker image inspect -f '{{.Config.User}}' "$base_id")" = node
test "$(docker image inspect -f '{{.Config.User}}' "$bad_id")" = node
for image_id in "$base_id" "$bad_id"; do
    docker run --rm --pull never --network none --entrypoint /bin/sh "$image_id" -ec '
        test "$(id -un)" = node
        test -r /etc/nginx/bento.conf
        test -x /usr/local/bin/bento-web
        test -x /usr/local/bin/bento-web-api
        test -r /app/register-paths.mjs
        test -r /app/apps/workspace/api/main.ts
        test -r /app/apps/workspace/auth/dist/login.html
        test -r /srv/bento/index.html
    '
done
sha256sum source.tar Base.Dockerfile Fault.Dockerfile fault.conf > input.sha256
```

PASS 为两个不同镜像 ID、健康检查配置相同，且两个镜像的默认用户均为 `node`，在无网络的一次性容器中通过配置和产物可读性及入口可执行性检查。原镜像构建限时 20 分钟并禁用构建层缓存，候选构建限时 3 分钟。基础镜像从 T0 核验的本地标签解析。原镜像构建需要 Debian apt（nginx、tini）、Go 模块下载、Corepack 获取 pnpm 12.15.0 及 pnpm 按冻结锁文件下载依赖。T0 已核验本地镜像和工具，以上下载连通性及构建器解析基础镜像仍以 T1 实测为准。T1 依赖获取限于源码构建所需的公开软件源，不引入代理凭据、私有镜像或运行时外部服务。

任一构建返回非零即 STOP，由 EXIT trap 在持锁期间清理带本轮标签的镜像。超时同样 STOP。若远端构建器在客户端超时后仍运行，保留运行目录及日志，由 MASTER 核对构建器已退出及本轮残留标签后才允许另一次执行。回报阶段、退出码和首个失败步骤的脱敏类别（基础镜像解析、apt、Go 模块、Corepack/pnpm、应用构建或候选构建）。原始日志保留在私有目录。本轮禁止重试、修改软件源或代理、拉取替代基础镜像、借用共享 Web 镜像、改动共享标签或调整验收断言。

## T2：建立健康基线并写入合成数据

文件范围为私有目录的 `compose.yaml`、`row-before.txt`、`volume-before.txt`、`operations.log`，以及演练卷中的账号行和标记文件。

在同一远端 Bash 会话继续。Compose 输入只包含 Web 与 MySQL，固定项目名、回环端口和命名卷。环境文件及 Compose 输入只含公开 fixture 值。外部对象存储与执行适配器无配置。使用 `--pull never` 和镜像 ID 断言核验每次实际启动。

```bash
phase=T2
cat > compose.yaml <<'YAML'
services:
  web:
    image: ${DRILL_WEB:?}
    labels: {org.bento.drill.run: "${DRILL_RUN:?}"}
    ports: ["127.0.0.1:18084:8080"]
    environment:
      BENTO_ONE_MODE: mock
      BENTO_ONE_ORIGIN: http://127.0.0.1:18084
      BENTO_MYSQL_HOST: mysql:3306
      BENTO_MYSQL_USER: bento
      BENTO_MYSQL_DATABASE: bento
      BENTO_MYSQL_PASSWORD: fixture-only
    volumes: [web-data:/data]
    depends_on:
      mysql:
        condition: service_healthy
  mysql:
    image: mysql:8.4
    labels: {org.bento.drill.run: "${DRILL_RUN:?}"}
    environment:
      MYSQL_DATABASE: bento
      MYSQL_USER: bento
      MYSQL_PASSWORD: fixture-only
      MYSQL_RANDOM_ROOT_PASSWORD: "yes"
    volumes: [mysql-data:/var/lib/mysql]
    healthcheck:
      test: [CMD-SHELL, "MYSQL_PWD=fixture-only mysql --protocol=tcp -h 127.0.0.1 -u bento bento -e 'SELECT 1'"]
      interval: 5s
      timeout: 3s
      retries: 20
volumes:
  web-data:
    labels: {org.bento.drill.run: "${DRILL_RUN:?}"}
  mysql-data:
    labels: {org.bento.drill.run: "${DRILL_RUN:?}"}
networks:
  default:
    labels: {org.bento.drill.run: "${DRILL_RUN:?}"}
YAML
inspect() { docker container inspect --format "$1" "$2"; }
sql() {
    docker exec -e MYSQL_PWD=fixture-only "$db" mysql --protocol=tcp \
        -h 127.0.0.1 -u bento bento --batch --skip-column-names -e "$1"
}
status() {
    curl --noproxy '*' -sS --max-time 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:18084$1"
}
export DRILL_WEB="$base"
dc config --quiet
compose_started=1
dc up --no-build --pull never -d --wait --wait-timeout 180
web=$(dc ps -q web)
db=$(dc ps -q mysql)
test "$(inspect '{{.Image}}' "$web")" = "$base_id"
test "$(inspect '{{.Image}}' "$db")" = "$mysql_id"
test "$(status /)" = 200
test "$(status /api/session)" = 401
sql "INSERT INTO web_accounts (owner_id, account) VALUES ('fixture-owner', 'rollback@example.invalid')"
read_row="SELECT CONCAT(HEX(owner_id),':',HEX(account),':',closed) FROM web_accounts ORDER BY owner_id"
test "$(sql "$read_row")" = '666978747572652D6F776E6572:726F6C6C6261636B406578616D706C652E696E76616C6964:0'
docker exec "$web" sh -ec 'printf "%s\n" rollback-fixture > /data/rollback-fixture'
sql "$read_row" > row-before.txt
docker exec "$web" sha256sum /data/rollback-fixture > volume-before.txt
mounts() { inspect '{{range .Mounts}}{{println .Name .Destination}}{{end}}' "$1"; }
test "$(mounts "$web")" = "${p}_web-data /data"
test "$(mounts "$db")" = "${p}_mysql-data /var/lib/mysql"
db_started=$(inspect '{{.State.StartedAt}}' "$db")
record "baseline source=$rev web=$web image=$base_id mysql=$db image=$mysql_id http=200,401"
```

PASS 为原镜像健康且外部回环响应符合断言，账号表仅包含预置合成行，卷标记已读回。STOP 时收集阶段和状态，按 T4 清理本演练资源。

## T3：观测候选失败并恢复原镜像

文件范围为私有目录的 `row-after.txt`、`volume-after.txt` 和 `operations.log`。

只允许替换 Web 容器。候选明确出现 `unhealthy` 且 HTTP 为 200、503 才算故障已被观测。固定 150 秒等待。超时或提前退出记录为未观测到预期故障，随后仍执行原镜像恢复，整次判 STOP。

```bash
phase=T3
owned_project
rollback_pending=1
export DRILL_WEB="$bad"
dc up --no-deps --no-build --pull never --force-recreate -d web
candidate=$(dc ps -aq web)
test "$candidate" != "$web"
test "$(inspect '{{.Image}}' "$candidate")" = "$bad_id"
deadline=$((SECONDS + 150))
while (( SECONDS < deadline )); do
    test "$(inspect '{{.State.Status}}' "$candidate")" = running || break
    test "$(inspect '{{.State.Health.Status}}' "$candidate")" != unhealthy || break
    sleep 2
done
fault_ok=0
health=$(inspect '{{.State.Health.Status}}' "$candidate")
if [[ "$health" = unhealthy ]] && [[ "$(status /)" = 200 ]] && [[ "$(status /api/session)" = 503 ]]; then
    fault_ok=1
fi
record "fault web=$candidate image=$bad_id health=$health expected_observed=$fault_ok"
restore_web
rollback_pending=0
test "$restored" != "$candidate"
test "$restored" != "$web"
test "$(inspect '{{.Image}}' "$restored")" = "$base_id"
test "$(status /)" = 200
test "$(status /api/session)" = 401
test "$(dc ps -q mysql)" = "$db"
test "$(inspect '{{.State.StartedAt}}' "$db")" = "$db_started"
test "$(inspect '{{.State.Health.Status}}' "$db")" = healthy
test "$(mounts "$restored")" = "${p}_web-data /data"
test "$(mounts "$db")" = "${p}_mysql-data /var/lib/mysql"
sql "$read_row" > row-after.txt
docker exec "$restored" sha256sum /data/rollback-fixture > volume-after.txt
cmp row-before.txt row-after.txt
cmp volume-before.txt volume-after.txt
record "restored web=$restored image=$base_id mysql=$db http=200,401 row_and_volume=equal"
test "$fault_ok" = 1
```

T3 启用 `rollback_pending` 后，候选切换、检查或常规恢复中的任意命令失败都会触发 EXIT trap。trap 先核对项目身份和原镜像 ID，再尝试原镜像恢复，随后清理。即使回退或清理失败也保留脱敏阶段与退出码，并返回 STOP。

## T4：清理、证据与收口

远端文件写入限于 `operations.log` 和 `evidence.sha256`。本地收口文件限于部署手册、Readiness 和删除本文。

```bash
phase=T4
completed=1
exit 0
```

EXIT trap 在释放锁前完成回退与清理。T1 部分构建失败也走同一入口，由镜像的本轮标签确认归属。容器和网络按实际 ID 清理，卷按名称和本轮标签复核后清理。固定锁只覆盖遵守该协议的执行者。任何身份不符立即停止相应操作，保留现场并报告。强制杀死 Bash 或宿主断电后，重新取得锁并由 MASTER 核对本轮记录及残留身份，禁止直接重跑。保留本轮受控目录及固定锁文件。成功与失败证据均只交付脱敏记录，禁止交付原始构建日志或 Docker 全量 inspect。

T0 至 T4 全部 PASS 后才更新 [Readiness](../40-readiness/CURRENT-READINESS.md) A8 行，保留 A8 部分实现，记录日期、源码版本、实际镜像 ID、探针及数据断言和清理结果。A7 行只需在协调后引用该局部回滚证据，保留未覆盖的生产及其他部署边界。复跑入口迁移到部署手册，提交前运行 `git diff --check`、`git diff --cached --check`、`pnpm exec prettier --check deploy/README.md docs/40-readiness/CURRENT-READINESS.md`，核对新增相对链接目标与锚点，再用 `git diff --cached --name-status` 核对仅有两个文档修改及本文删除。稳定说明与结果通过审核后按 RUNBOOK Rules 删除本草稿。
