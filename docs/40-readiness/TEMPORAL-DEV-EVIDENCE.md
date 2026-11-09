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

## Not Covered

Temporal Server 重启或数据丢失、生产部署、多执行宿主、Worker 池容量、真实多账号负载和任意工具不在本轮覆盖内。A6 的完整门槛见 [实施与验收](../research/implementation.md)。

## Closure

独立冒烟、Bento 页面纵向验证和 Activity 重投验证通过。远端 Temporal 实例保留运行。临时执行服务、Worker 和 OpenShell 测试资源已清理，原 Gateway 未改动。探针与原始日志留在内部工作区。
