# Temporal 开发环境验收

## Scope

2026-11-09，在现有远端 Linux x86_64 开发宿主上部署独立 Temporal 开发实例。版本与健康检查命令见 [部署说明](../deployments/HOW-TO-TEMPORAL-DEV.md)。

## Validated Contract

在没有 Worker 轮询时，Workflow 可先进入 Task Queue。执行有副作用的 Activity 时，Worker 可能在写入成功、结果尚未返回的窗口失联。该场景要求流程转入只读对账，并禁止重新派发原写入。独立探针通过禁用写入 Activity 重试实现这一约束。

## Executed Validation

- gRPC 健康检查和 UI HTTP 请求均通过。两个端口均只监听回环地址，且 gRPC 与 UI 均可通过 SSH 隧道访问。
- 探针先提交 Workflow，再启动第一个 Worker。该 Worker 写入并同步文件标记，保持 Activity 未完成。随后启动备用 Worker，并向第一个 Worker 发送 `SIGKILL`。
- 备用 Worker 在 Activity 超时后领取只读对账任务，读到第一个 Worker 写入的原标记。原 Workflow 状态为 `COMPLETED`。历史中依次各调度了一次 `dispatch` 和 `reconcile`，独立尝试记录也仅有首个 Worker 的一次写入。

## Not Covered

Bento Run 接入、真实模型、OpenShell 执行、Temporal Server 重启或数据丢失、生产部署、多执行宿主、Worker 池容量、真实多账号负载和任意工具不在本轮覆盖内。A6 的完整门槛见 [实施与验收](../research/implementation.md)。

## Closure

独立 Temporal 冒烟通过。远端 Temporal 实例保留运行，两个测试 Worker 随探针退出。探针与原始日志留在内部工作区。
