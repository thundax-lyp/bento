# Temporal 开发环境

本环境用于验证 Temporal Task Queue、Worker 领取与故障接续。使用远端开发宿主上的独立 Temporal Dev Server 和 SQLite 文件。Temporal 调度 Bento Run，Bento 服务裁决 Session、Workspace、执行租约和 generation，OpenShell 执行工具调用。副作用结果不明时，Bento 进入恢复和可信对账路径。

## 启动

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

## 访问与验证

在本机以已有的 SSH 配置建立隧道，将 `DEV_HOST` 替换为受控配置中的宿主别名。

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:17233:127.0.0.1:17233 \
  -L 127.0.0.1:18233:127.0.0.1:18233 DEV_HOST
```

浏览器打开 `http://127.0.0.1:18233`。客户端使用 `127.0.0.1:17233` 和 `default` Namespace。每次探针生成独立 Workflow ID 和 Task Queue，避免领取其他运行的任务。Worker 轮询 Task Queue。[Temporal Tasks](https://docs.temporal.io/tasks)

复跑时，在已部署环境的探针目录执行 `node smoke.cjs`。探针启动两个测试 Worker，结束时关闭它们。重建探针时，从内部工作区取回 `smoke.cjs`、`workflow.cjs`、`package.json` 和锁文件，在独立目录执行 `npm ci`。如遇宿主下载超时，可在本机准备包含 Linux x86_64 原生模块的依赖包，校验后上传。内部探针、原始日志与远端配置按公开发布规则留存。通过条件见 [Temporal 开发环境验收](../40-readiness/TEMPORAL-DEV-EVIDENCE.md)。

## 接入 Bento

按 [执行服务部署说明](openshell-dsh.md#two-执行服务)配置宿主、状态目录和服务认证，再向同一进程提供以下环境变量。

```sh
export BENTO_TEMPORAL_ADDRESS=127.0.0.1:17233
export BENTO_TEMPORAL_NAMESPACE=default
export BENTO_TEMPORAL_TASK_QUEUE=bento-dev-host
node --experimental-strip-types src/execution-service/start.ts
```

为每个控制器状态目录分配独占 Task Queue。重启时保留状态目录、Namespace 和队列名。控制器与 Temporal Worker 共进程。Activity 并发跟随宿主槽位数，默认一个槽位，启用 [DSH Worker 预热](openshell-dsh.md#two-执行服务)后可配置两个槽位。Temporal Worker 领取任务后，由受信宿主适配器分配 DSH 执行 Worker。通过 `pnpm install --frozen-lockfile` 安装 SDK 与当前平台的原生依赖。该模式面向受信网络内的开发服务。

HTTP 接受 Run 后，Bento 将其放入 SQLite 待处理队列。空槽可用时，Bento 按租户优先级持久化派发决定，再发布或补发 Temporal Workflow。固定 Workflow ID 为 `bento-run-<run-id>`，重复发布使用同一 ID。Temporal 历史只传 Run ID，prompt、凭据和授权保留在 Bento 边界内。Temporal 暂不可用时，待发布记录保留，控制器重试发布。

`advanceRun` 可以被 Temporal 重投。控制器只在 Run 为 `queued` 时启动原执行，并在颁发租约前持久化 `running`。重投遇到 `running` 或 `recovering` 时进入原 Session 的接管路径，恢复 Worker 不接收 prompt。出现 `UNKNOWN` 时，页面等待可信核对，随后提供已冻结的 diff。Temporal Workflow 完成表示调度活动已返回，页面的业务结果以 Bento Run 状态为准。

诊断时用 UI 搜索 Workflow ID，检查队列的 Worker 和 `advanceRun` 历史，并核对 Bento 的 Run 状态。控制器进程失联时，Activity 心跳超时后可被重新领取。保持原有数据与队列，重启执行服务。停用 Temporal 模式前先确认该控制器已排空，停止进程后清除这三项配置，再按相同状态目录启动。避免在 Temporal UI 手工终止或重置未结束的 Bento Workflow。

## 停止与恢复

在测试目录读取 `server.pid`，用 `ps -p "$(cat server.pid)" -o args=` 核对 PID 仍对应本目录启动的 Temporal 实例及测试端口。确认无误后发送 `kill -TERM "$(cat server.pid)"`，等待两个端口释放后移除 PID 文件。保留 `temporal.sqlite` 和日志。恢复时在同一目录按启动步骤运行，使用同一个数据库文件。

该实例由开发者手工启停，宿主重启后需重新启动。服务状态、数据库和 Worker 日志均通过受控 SSH 访问。
