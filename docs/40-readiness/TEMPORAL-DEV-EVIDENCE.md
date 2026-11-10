# Temporal 开发环境验收

## Scope

2026-11-09，在现有远端 Linux x86_64 开发宿主上部署 Temporal 开发实例，并接入 Bento 单执行宿主。版本与健康检查命令见 [部署说明](../deployments/HOW-TO-TEMPORAL-DEV.md)。

## Validated Contract

在没有 Worker 轮询时，Workflow 可先进入 Task Queue。执行有副作用的 Activity 时，Worker 可能在写入成功、结果尚未返回的窗口失联。该场景要求流程转入只读对账，并禁止重新派发原写入。独立探针通过禁用写入 Activity 重试实现这一约束，Bento 接入使用持久 Run 状态控制重投后的路径。

## Executed Validation

- gRPC 健康检查和 UI HTTP 请求均通过。两个端口均只监听回环地址，且 gRPC 与 UI 均可通过 SSH 隧道访问。
- 探针先提交 Workflow，再启动第一个 Worker。该 Worker 写入并同步文件标记，保持 Activity 未完成。随后启动备用 Worker，并向第一个 Worker 发送 `SIGKILL`。
- 备用 Worker 在 Activity 超时后领取只读对账任务，读到第一个 Worker 写入的原标记。原 Workflow 状态为 `COMPLETED`。历史中依次各调度了一次 `dispatch` 和 `reconcile`，独立尝试记录也仅有首个 Worker 的一次写入。

### Bento 页面纵向验证

- 用一个受邀账号在浏览器导入真实 Git 项目的两个文件并提交 Run。Temporal 历史记录该 Run 的 `advanceRun` Activity。真实 DeepSeek V4 Flash 返回一次工具调用，由 DSH Worker 通过 OpenShell 修改 README。
- 独立读取 Workspace 确认副作用已落盘，Session 已持久化工具调用，尚无工具结果。此时强杀 DSH Worker，退出码为 137。新 Worker 使用原 Session 和 Workspace 的下一 generation，且未收到原 prompt。
- 原历史前缀保留，新增的中断结果为 `TOOL_OUTCOME_UNKNOWN`。旧代 operation 和持久化入口均返回 HTTP 403，OpenShell SDK ingress 返回 gRPC 16。操作账本在可信核对前后均保持 `UNKNOWN`，Workspace 中只出现一次预期追加。
- 重新打开页面看到 `needs_review`，此时无法下载 diff。可信侧核对整卷哈希后冻结 diff。从页面下载的 diff 与冻结版本哈希一致，可应用到原 Git 快照，且只追加一行。

### Activity 重投验证

用同一个远端 Temporal 服务和本机文件夹具复跑控制器故障。工具写入并同步文件后，执行 Worker 退出，控制器在首次 Activity 的接管阶段被 `SIGKILL`。使用同一状态目录和 Task Queue 重启，Temporal 历史记录第 2 次 Activity 尝试。新尝试接管原 Session，原写入仍只有一次，旧代被拒，后续排队 Run 也完成。该用例使用确定性文件夹具。

### 单槽 DSH Worker 预热

在同一远端 Temporal 环境使用真实 DeepSeek V4 Flash 和 OpenShell。每轮从浏览器执行一次冷启动，再让三个受邀账号分别导入独立项目并依次使用同一个预热进程。各 Run 有独立的租户、Session、沙盒和 Workspace。切换账号时，在新 Run 活跃期间验证旧授权失效，并验证新授权访问上一 Session 返回 HTTP 403。三个账号之间的项目、Run 和 diff 读取请求均返回 HTTP 404。

在第三个账号的工具写入落盘、结果回执前向容器发送 `SIGKILL`。新进程以新 generation 接管原 Session 和原卷，保留原历史前缀。旧代操作和持久化请求返回 HTTP 403，旧代 SDK 执行请求返回 gRPC 16。账本保留 `UNKNOWN`，记录到一次工具调用和一次预期写入。可信侧独立核对后，从页面下载的 diff 成功应用到原 Git 快照。

从浏览器发出 Run 请求到 DSH 进入首次工具调用的耗时如下。两端时钟通过请求往返时间校准。两轮共八个样本，耗时用来比较本轮冷启动和预热路径。

| 轮次 | 冷启动 | 预热账号 1 | 预热账号 2 | 预热账号 3 |
| ---- | ------ | ---------- | ---------- | ---------- |
| 1    | 3.24 s | 2.10 s     | 1.99 s     | 2.00 s     |
| 2    | 3.48 s | 2.25 s     | 2.10 s     | 1.87 s     |

从派发到 Worker 绑定 Run，冷启动耗时 943–971 ms，预热耗时 0–3 ms。模型请求在这八次运行中耗时 892–1,215 ms。

### 双槽并发与故障隔离

在同一远端 Temporal 环境启用两个预热 DSH Worker，使用真实 DeepSeek V4 Flash 和 OpenShell。三个受邀账号从浏览器导入独立项目并提交 Run。

- A、B 使用不同的 Worker 和 Workspace，观测到两个 Run 同时处于 `running`。C 提交后保持 `queued`，没有收到执行授权。A、B 使用各自当代授权访问对方 Session 和 OpenShell 沙盒，分别收到 HTTP 403 和 gRPC 7。三个账号之间读取项目、Run 和 diff 的请求返回 HTTP 404。
- A 写入落盘并持久化工具调用后，在结果回执前对其 Worker 发送 `SIGKILL`，进程退出码为 137。替换进程在 A 原槽位进入恢复。在 A 仍处于 `recovering` 时，B 在原 Worker 完成，页面成功下载 diff。C 此后才取得 B 释放的槽位。
- A 恢复原 Session 和 Workspace，保留原会话历史前缀。旧代操作和持久化请求返回 HTTP 403，旧代 OpenShell 执行请求返回 gRPC 16。账本在可信核对前后均保持 `UNKNOWN`，A 的原写入只发生一次。A、B、C 的页面 diff 分别应用到原 Git 快照，各自只产生预期改动。

### 租户准入与公平派发

2026-11-10，在同一远端环境启用两个预热槽位和每账号两个排队名额。三个受邀账号先导入独立项目，再通过浏览器提交九条最终接受的 Run。真实 DeepSeek V4 Flash 在每条 Run 中选择受控文件编辑工具，经 OpenShell 执行。测试让 A 维持长任务积压，B、C 各间歇提交两条短任务。

- A 单独占满两个槽。A2、A3 排队后，A4 的首次提交从浏览器收到 HTTP 429 和 `tenant_queue_full`。B0、C0 在 A 排队额度耗尽时仍收到 HTTP 202。A2 领取后，A4 重试成功。
- A0 持续占用恢复槽位时，B、C 的四条任务先于 A2、A3 领取。A 的任务保持提交顺序。下表从服务端接受 Run 开始计时，到执行 Worker 领取为止。等待包含人为设置的故障与任务释放屏障。

| 领取顺序 | Run | 等待     | 槽位 |
| -------- | --- | -------- | ---- |
| 1        | A0  | 0.469 s  | 0    |
| 2        | A1  | 0.805 s  | 1    |
| 3        | B0  | 16.594 s | 1    |
| 4        | C0  | 27.439 s | 1    |
| 5        | B1  | 20.431 s | 1    |
| 6        | C1  | 19.827 s | 1    |
| 7        | A2  | 60.580 s | 1    |
| 8        | A3  | 69.457 s | 0    |
| 9        | A4  | 11.335 s | 1    |

- A0 写入落盘后、回执前强杀 Worker，退出码为 137。另一槽的原 Worker 继续执行，在 A0 仍处于 `recovering` 时交付 B0 的页面 diff。替换进程接管 A0 的原 Session 和 Workspace，旧代操作与持久化请求返回 HTTP 403，旧代 SDK 执行请求返回 gRPC 16。账本仍为 `UNKNOWN`，A0 写入只发生一次。九份页面 diff 均成功应用到各自的原 Git 快照。

## Not Covered

Temporal Server 重启或数据丢失、生产部署、多执行宿主、超过两个槽位的容量、长时间压测和任意工具不在本轮覆盖内。A6 的完整门槛见 [实施与验收](../research/implementation.md)。

## Closure

独立冒烟、Bento 页面纵向验证、Activity 重投、单槽预热、双槽故障隔离和租户公平派发验证通过。远端 Temporal 实例保留运行。临时执行服务、Worker 和 OpenShell 测试资源已清理，原 Gateway 未改动。探针与原始日志留在内部工作区。
