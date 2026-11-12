# Bento 部署

从仓库根目录执行 Bento 的构建和启动命令。[平台架构](../docs/00-governance/ARCHITECTURE.md)说明组件职责。

## Web Docker

[基础 Compose](compose.yaml)启动 Bento Web 和 MySQL，NGINX 在宿主机回环提供 Web 和 API。[Keycloak 覆盖配置](compose.keycloak.yaml)启用受邀认证。使用 Docker Compose 2.24.4 或更新版本。Web 默认使用 Compose 项目名 `bento`。如果已有部署使用自定义项目名，继续使用原项目名以复用命名卷。

### 本机预览

在仓库根目录通过 Compose 构建个人端镜像，再启动模拟模式。预览命令中的数据库参数只用于解析 Compose 配置。

```sh
BENTO_MYSQL_PASSWORD=preview docker compose -f deploy/compose.yaml build bento-web
docker run --rm --stop-timeout 60 \
  -p 127.0.0.1:8080:8080 \
  -e BENTO_ONE_MODE=mock \
  -e BENTO_ONE_ORIGIN=http://127.0.0.1:8080 \
  bento-web:local
```

打开 <http://127.0.0.1:8080>。模拟账号和验证流程见 [独立前端说明](../apps/workspace/web/README.md)。

### 配置真实环境

使用账号文件模式时，在本地受控目录准备 `runtime/accounts.json` 和 `runtime/web.env`。账号文件按 [task-entry 配置](../apps/workspace/api/README.md)创建。让容器内的 `node` 用户（UID 1000）可以只读访问账号文件。基础 Compose 把它挂载到 `/run/bento/accounts.json`。Keycloak 覆盖配置会移除此挂载。MySQL 8.4 服务通过 Compose 私有网络提供账号存储，数据保存在 `bento-mysql-data` 卷。空间 SQLite 保存在 `bento-web-data` 卷的 `/data`。

在仓库根目录的受控 `.env` 中设置随机生成的 `BENTO_MYSQL_PASSWORD`（例如通过 `openssl rand -hex 32` 生成），Compose 用同一个值配置 MySQL 的 `bento` 用户和 Go 连接。MySQL 容器健康检查通过后启动 Web，MySQL 端口保持在 Compose 网络内。首次初始化创建数据库和用户；密码轮换需要同步修改数据库账号与部署配置。镜像环境变量说明见 [MySQL 官方镜像](https://hub.docker.com/_/mysql)。

参照以下配置填写 `runtime/web.env`。

```dotenv
BENTO_ONE_MODE=http
BENTO_ONE_ORIGIN=https://bento.example.com
BENTO_ONE_TWO_URL=http://execution-gateway.example.internal:4201
BENTO_ONE_TWO_BEARER=<执行服务凭据>
BENTO_SPACE_DB=/data/space.sqlite
BENTO_SPACE_S3_ENDPOINT=https://storage.example.com
BENTO_SPACE_S3_BUCKET=bento-private
AWS_REGION=us-east-1
```

S3 访问凭据通过运行环境的 AWS 凭证链提供。使用环境变量时，把真实值配置在受控的 `runtime/web.env`。镜像构建上下文只包含源码和部署配置。若本次部署暂未配置云端空间，省略全部三个 `BENTO_SPACE_*` 配置。执行服务地址必须从容器可达。若执行服务只监听宿主机回环地址，需要使用现有内网入口或受控代理。

```sh
docker compose -f deploy/compose.yaml config --quiet
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml ps
```

Compose 默认将容器的 `8080` 发布到宿主机回环。生产由宿主机 HTTPS 入口转发至 `http://127.0.0.1:8080`，保留浏览器的 `Origin`。将 `BENTO_ONE_ORIGIN` 设为用户实际访问的 HTTPS origin，包含非默认端口时也一并填写。更新容器时保留 `bento-web-data`、`bento-mysql-data` 卷和原账号文件。

`docker compose -f deploy/compose.yaml ps` 显示 `healthy` 时，首页已返回 `200`，未登录的 `/api/session` 已返回 `401`，Go 的数据库探针已通过。部署后再检查直接打开任务链接、登录后下载 diff，以及浏览器能否连接 S3 端点。

启动失败时用 `docker compose -f deploy/compose.yaml logs --tail=100 bento-web` 检查容器日志，核对账号文件的读取权限和必需环境变量。停止服务用 `docker compose -f deploy/compose.yaml stop`，恢复原配置后用 `docker compose -f deploy/compose.yaml up -d` 重新启动并检查健康状态。

Go Temporal 调度运行在执行宿主侧，按 [Temporal 接入](#接入-bento)独立构建部署。

历史远端构建版本、已验证路径和覆盖范围见 [Web Docker 验收](../docs/40-readiness/README.md)。

### Keycloak 受邀认证

全新部署可使用现有 Compose 配置及 Keycloak 覆盖文件。该配置由 Bento
提供 `/auth` 登录入口和 `/` 工作区，Keycloak 负责邀请、注册、邮箱验证、设置密码与认证审计。

1. 在 Keycloak Realm 启用 Organizations、邮箱验证及 SMTP，关闭公开注册。建立用于 Bento 准入的组织，保存组织 alias。由管理员通过该组织发邀请，注册邀请使用默认 account client。组织的重定向地址可设为 Bento 的 `/auth`。
2. 创建 confidential OIDC client，开启 Standard Flow 和 S256 PKCE。关闭 Direct Access Grants。添加可选的 `organization` scope，保证 ID Token 包含 `email`、`email_verified` 和组织声明。精确登记 Bento 的 `/api/oidc/callback` 回调和 `/auth` 退出回跳地址。
3. 在受限权限的 `runtime/web.env` 中，设置现有的 `BENTO_ONE_ORIGIN` 及执行服务配置，再设置以下变量。Bento 服务端和用户浏览器均需能访问同一个 issuer。正式环境使用 HTTPS。本机调试可使用环回 HTTP。
4. 以同一个 Compose 项目名启动并验证空数据库初始化。

| 变量                       | 用途                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| `BENTO_OIDC_ISSUER`        | Keycloak Realm 的完整 issuer，例如 `https://id.example.com/realms/bento` |
| `BENTO_OIDC_CLIENT_ID`     | Bento 的 confidential client ID                                          |
| `BENTO_OIDC_CLIENT_SECRET` | 服务端客户端凭据                                                         |
| `BENTO_OIDC_ORGANIZATION`  | 受邀组织的 alias                                                         |

```sh
docker compose -f deploy/compose.yaml -f deploy/compose.keycloak.yaml config --quiet
docker compose -f deploy/compose.yaml -f deploy/compose.keycloak.yaml up -d --build
```

查看状态、日志、停服和重启时也使用相同的两个 `-f` 参数。

从 Keycloak 组织发一条测试邀请，确认完成邮箱验证与设置密码后，从 Bento
`/auth` 登录能进入工作区。再次登录应复用 MySQL 中同一个 `owner_id`。
在 Keycloak Realm 的 Events 中启用并查询注册、邮箱验证、凭据更新、登录和退出事件。

### 远端开发身份环境

[Keycloak 开发 Compose](keycloak/compose.yaml) 定义独立 Keycloak、PostgreSQL、Mailpit、Bento 登录主题和持久卷。将整个 `deploy/keycloak` 目录复制到远端专用目录，在该目录创建权限为 `0600` 的 `.env`，设置 `KEYCLOAK_DB_PASSWORD` 和 `KEYCLOAK_ADMIN_PASSWORD`。使用独立项目名启动：

```sh
docker compose -p bento-keycloak-dev up -d
docker compose -p bento-keycloak-dev ps
```

网络受限的宿主可先导入与宿主架构匹配的镜像，再执行 `up -d --pull never`。Keycloak 管理员用户名为 `bento-dev-admin`。按上节配置 Realm、组织和 Bento 客户端。SMTP 主机为 `mailpit`，端口为 `1025`，使用专用测试发件地址和接收地址。

从开发机将本地 `18491` 和 `18494` 分别转发至宿主回环上的同名端口：

```sh
ssh -NT -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:18491:127.0.0.1:18491 \
  -L 127.0.0.1:18494:127.0.0.1:18494 \
  "$BENTO_DEV_SSH_HOST"
```

Keycloak 管理台走本地 `18491/admin/`，Mailpit 走本地 `18494`。Bento 和浏览器使用同一 issuer。容器化 Bento 需在其网络命名空间内建立可达的转发。重启 Keycloak 使用 `docker compose -p bento-keycloak-dev restart keycloak`，通过发现端点及管理台核对 Realm、客户端和历史审计。保留两个命名卷可保留身份数据和测试邮件。

## OpenShell 执行宿主

### 接入前检查

1. 使用受信执行入口接入启用 mTLS 的 OpenShell Gateway。将后端管理凭据限制在受信服务端。确认 Worker 无法直连 Gateway 或访问 Docker 管理接口。
2. 为 Workspace 准备独立持久 Volume。受测 Docker driver 启用 `allow_driver_config`，卷使用 `sandbox-attachable=true` 和 `sandbox-attachable-workspace=default` 标签。部署后核对沙盒挂载、工作目录与策略。
3. 通过测试 Session 验证文件和命令访问同一卷。重建沙盒时保留原卷，确认旧执行已退出、新沙盒的策略和挂载正确后再发布新代 READY。严格隔离模式应拒绝仅提供 partial enforcement 的环境。

运行边界和既有实验结果见 [需求完成状况](../docs/40-readiness/README.md)。

### 启动执行服务

执行服务在回环地址提供 HTTP v1，供受信的任务入口调用。任务入口从认证后的账号派生 `X-Bento-Owner-Id`，并在服务间请求携带独立的 bearer。执行服务按 owner 限定项目、Run 和 diff 的访问，每个执行宿主默认串行处理 Run。

在仓库根目录执行 `pnpm --filter @bento/orchestrator... install --frozen-lockfile`，安装 Orchestrator 和 Worker 依赖。部署端为每个控制器配置独占的私有 `BENTO_STATE_DIR`，注入 `BENTO_SERVICE_BEARER`，并选择一种宿主接入方式。

- `BENTO_HOST_CONFIG` 指向私有 JSON。配置包含 Gateway 和 workspace scope、mTLS 文件、固定 SDK 的 `raw.js` 以及可信 `control` 和 `worker` 命令。控制命令负责项目导入、独立读卷、沙盒停启与状态观察。使用 DSH worker 入口时，由 worker 环境的 `BENTO_DSH_BOOTSTRAP` 提供运行时、模型和工具接线。协议见[命令宿主适配器](../apps/orchestrator/execution-service/command-host.ts)和[worker 入口](../apps/worker/run-worker.ts)。
- `BENTO_HOST_MODULE` 指向实现 [`ExecutionHost`](../apps/orchestrator/execution-service/types.ts) 的可信模块，默认导出工厂并提供 SDK ingress 配置。

```sh
node --experimental-strip-types apps/orchestrator/execution-service/start.ts
```

启动成功时输出回环地址，监听端口可由 `BENTO_PORT` 设置。导入项目后先确认项目为 `ready`，再提交 Run，记录 Run ID 与 Session ID。用同一账号重新读取状态及 diff。使用 `SIGTERM` 停止服务，重启时沿用同一状态目录及宿主绑定。只验证本机服务时可用独立的状态目录，清除两种宿主配置并在命令末尾加 `--local`，此模式使用确定性夹具。

启用 Temporal 调度时，按 [Temporal 开发环境](#接入-bento)为执行服务配置独占 Task Queue。

在私有 `BENTO_HOST_CONFIG` 中设置 `"prewarmWorker": true`，并给 [DSH Worker 入口](../apps/worker/run-worker.ts)传入 `--warm`，即可启用单槽预热。Worker 导入 bootstrap 后进入空闲状态，每次收到 Run 才绑定当次 Session、Workspace 和授权。bootstrap 必须为每次调用创建独立运行时，并在回执前关闭该次运行的 Agent、连接和监听器。bootstrap 模块可预加载依赖，运行数据与授权只放在该次调用内。

Worker 镜像从仓库根独立构建。受信启动器以交互 stdin/stdout 连接镜像，按环境挂载私有 bootstrap 并设置 `BENTO_DSH_BOOTSTRAP`。镜像工作目录是 `/app/apps/worker`，bootstrap 可挂载到此目录下，以解析镜像中的 Worker 依赖。Worker 的协议包括单次 JSON 请求、`--warm` 模式的逐行请求和回执。

```sh
docker build -f deploy/worker/Dockerfile -t bento-worker .
```

启用 Temporal 和预热后，在同一份宿主配置中设置 `"workerSlots": 2` 可开启两个槽位。每个 Run 占用一个槽位直到执行或恢复结束，两槽都占用时其他 Run 留在队列。项目与 Session、Workspace 一一绑定，同一项目仍只接受一个未结束的 Run。调低槽位数或回退到旧版本前，先排空执行宿主。

受信启动器负责隔离 Worker 及其子进程，并将终止信号传给整个容器或进程组。异常退出、租约超时或需要人工核对的回执会淘汰该 Worker。执行服务在旧进程关闭后补位。关闭服务时等待预热进程退出，随后释放控制器锁。停用预热时，排空后移除私有配置中的 `prewarmWorker` 和 `workerSlots`，移除 Worker 命令的 `--warm`，再重启执行服务。

遇到 worker 失联时，执行服务撤销旧代授权并在原卷上恢复 Session。恢复 worker 只对账会话历史，原 prompt 不重发。Run 进入 `needs_review` 时，可信部署端先独立核对预期修改，再通过[进程内 `reviewRun`](../apps/orchestrator/execution-service/service.ts) 提供代次、稳定操作 ID 和预期整卷哈希。执行服务核对恢复回执、绑定、UNKNOWN 操作及卷快照，原子保存确认记录和 diff。核对失败时，Run 继续等待可信核对，diff 暂不可用。

使用 `start.ts` 的部署可设置 `BENTO_REVIEW_MODULE`，指向仅由可信部署端控制的模块。模块默认导出同步安装函数 `(reviewRun) => cleanup`。安装函数接入部署端的复核工具，并在停服时通过 `cleanup` 停止接收新请求、等待在途复核结束。复核提交须包含 `runId`、`failedGeneration`、`readyGeneration`、`stableOperationId` 和 `expectedSnapshotSha256`。模块与执行服务同进程运行，部署端应限制模块文件及复核入口的访问权限。

账号注销清理需要可信宿主实现幂等的工作区删除。命令宿主处理 `{action:"purge",binding}`，只删除该绑定独占的沙盒与卷，独立确认两者不存在后返回 `{sandbox,volume,absent:true}`。自定义宿主实现 `ExecutionHost.purge(binding)`。删除失败应报错，Bento 会保留清理请求以便重试。Docker 驱动的宿主可用 [dockerOpenShellPurge](../apps/orchestrator/execution-service/docker-openshell-purge.ts)，并提供与部署时一致的卷标签。

## Temporal 开发环境

### 启动

前置条件为 Linux x86_64、可通过 SSH 进入开发宿主、可用的 `17233` 和 `18233` 回环端口。SDK 探针使用 Node.js 24 和 Temporal TypeScript SDK 1.25.0。部署使用 Temporal CLI 1.10.0，内置 Server 1.32.2 和 UI 2.56.1。先下载对应的 Linux amd64 压缩包与 `checksums.txt`，校验 SHA-256 后解包。宿主无法直接访问下载源时，可在本机校验后通过 SSH 上传，并在宿主再次校验。[Temporal CLI 1.10.0](https://github.com/temporalio/cli/releases/tag/v1.10.0)

以下命令在宿主执行。`TEMPORAL_DEV_DIR` 是本次测试专用目录，操作时使用受控配置中的实际路径。

```sh
umask 077
: "${TEMPORAL_DEV_DIR:?set TEMPORAL_DEV_DIR to the private test directory}"
mkdir -p "$TEMPORAL_DEV_DIR"
chmod 700 "$TEMPORAL_DEV_DIR"
cd "$TEMPORAL_DEV_DIR"

archive=temporal_cli_1.10.0_linux_amd64.tar.gz
awk -v file="$archive" '$2 == file { print }' checksums.txt | sha256sum -c - &&
  tar -xzf "$archive" temporal
```

检查校验和解包均成功。已有实例时直接做健康检查。新启动前用 `ss -ltn` 检查两个端口均空闲，再执行以下命令。

```sh
nohup ./temporal server start-dev --ip 127.0.0.1 --port 17233 \
  --ui-port 18233 --db-filename temporal.sqlite \
  >server.log 2>&1 </dev/null &
echo "$!" >server.pid
```

```sh
./temporal operator cluster health --address 127.0.0.1:17233
curl -fsS http://127.0.0.1:18233/ >/dev/null
ss -ltnH '( sport = :17233 or sport = :18233 )'
```

成功时 gRPC 健康检查报告 `SERVING`，UI 返回成功响应，两个端口都只监听 `127.0.0.1`。启动失败时，在宿主查看 `server.log`，核对端口占用与目录权限。若出现非回环监听，停止实例并修正绑定后重启。此配置使用 Temporal 的单节点开发服务器。[Temporal CLI 文档](https://docs.temporal.io/cli)

### 访问与验证

在本机以已有的 SSH 配置建立隧道，将 `DEV_HOST` 替换为受控配置中的宿主别名。

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:17233:127.0.0.1:17233 \
  -L 127.0.0.1:18233:127.0.0.1:18233 DEV_HOST
```

浏览器打开 `http://127.0.0.1:18233`。客户端使用 `127.0.0.1:17233` 和 `default` Namespace。每次探针生成独立 Workflow ID 和 Task Queue，避免领取其他运行的任务。Worker 轮询 Task Queue。[Temporal Tasks](https://docs.temporal.io/tasks)

探针和覆盖范围见 [Temporal 开发环境验收](../docs/40-readiness/README.md)。

### 接入 Bento

按 [执行服务部署说明](#启动执行服务)配置宿主、状态目录和服务认证，再向同一进程提供以下环境变量。

```sh
mkdir -p runtime
(cd apps/orchestrator && go build -trimpath -o ../../runtime/bento-orchestrator .)
export BENTO_GO_CONTROL="$PWD/runtime/bento-orchestrator"
export BENTO_TEMPORAL_ADDRESS=127.0.0.1:17233
export BENTO_TEMPORAL_NAMESPACE=default
export BENTO_TEMPORAL_TASK_QUEUE=bento-dev-host
node --experimental-strip-types apps/orchestrator/execution-service/start.ts
```

为每个控制器状态目录分配独占 Task Queue。重启时保留状态目录、Namespace 和队列名。Go Temporal Worker 作为执行宿主的子进程启动，通过私有 stdio 协议交接。Activity 并发跟随宿主槽位数，默认一个槽位，启用 [DSH Worker 预热](#启动执行服务)后可配置两个槽位。Temporal Worker 领取任务后，由受信宿主适配器分配 DSH 执行 Worker。使用 Go 1.25.3+ 构建控制面二进制。该模式面向受信网络内的开发服务。

诊断时用 UI 搜索 Workflow ID，检查队列的 Worker 和 `advanceRun` 历史，并核对 Bento 的 Run 状态。控制器进程失联时，Activity 心跳超时后可被重新领取。保持原有数据与队列，重启执行服务。停用 Temporal 模式前先确认该控制器已排空，停止进程后清除这三项配置，再按相同状态目录启动。避免在 Temporal UI 手工终止或重置未结束的 Bento Workflow。

### 停止与恢复

在测试目录读取 `server.pid`，用 `ps -p "$(cat server.pid)" -o args=` 核对 PID 仍对应本目录启动的 Temporal 实例及测试端口。确认无误后发送 `kill -TERM "$(cat server.pid)"`，等待两个端口释放后移除 PID 文件。保留 `temporal.sqlite` 和日志。恢复时在同一目录按启动步骤运行，使用同一个数据库文件。

该实例由开发者手工启停，宿主重启后需重新启动。服务状态、数据库和 Worker 日志均通过受控 SSH 访问。
