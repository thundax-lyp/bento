# Bento 工程结构

[应用与编排边界需求](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md) 定义产品行为和验收边界。目标源码结构如下。

```text
apps/
├── workspace/
│   ├── auth/
│   ├── web/
│   └── api/
├── admin/
│   ├── auth/
│   ├── web/
│   └── api/
├── orchestrator/
└── worker/
deploy/
├── workspace/
├── admin/
├── execution/
├── keycloak/
├── temporal/
└── worker/
docs/
validation/
runtime/
```

## 职责与依赖

- 个人端和管理端各有独立认证前端、业务前端和 API。个人端 API 由单个 Go 进程提供 HTTP、认证会话和业务接口，并直接访问 MySQL。各端 API 持有自身会话及业务授权，通过内部服务身份调用 Orchestrator。Keycloak 托管身份认证和凭据，个人端与管理端使用独立 Realm。
- 单一 Go Orchestrator 拥有 Run 权威账本、Temporal 编排、槽位、Worker 生命周期、执行授权和故障恢复。Temporal 保存编排历史，业务状态由 Orchestrator 读取和写入。
- Worker 是独立的 DSH 执行工程，使用当次授权与 OpenShell 执行接口。受信停启观察、管理凭据和账本写入属于 Orchestrator。

## 状态与失败处理

同一部署重启后，Run、执行尝试、槽位、Session、Workspace 和代次绑定继续按持久账本恢复。Temporal 重投按业务 Run 读回既有尝试。启动权在发出运行时请求前持久消费，结果未知时按原尝试观察或清理。运行时对象不存在、查询失败和已确认停止分别处理。确认宿主与沙盒旧执行停止后释放槽位。工具结果缺少证据时保留 `UNKNOWN`。

## 当前代码与验收

个人端三类源码已平级，Go Web 入口和账号仓储在 `workspace/api/go`，Temporal Go 模块在 `orchestrator`，DSH Worker 在 `worker` 自带协议和运行依赖，并可独立构建镜像。独立认证前端构建、管理端三项实现、Go 执行账本与受信执行路径仍待交付。当前运行能力依赖 `apps/orchestrator/execution-service/` 中的 TS 执行服务及其 SQLite 账本。受信 OpenShell 控制面同属 Orchestrator，位于 `apps/orchestrator/openshell/`。此项属于实现差距，目标架构以单一 Go Orchestrator 为准。

Go 接管验收须覆盖正常派发、超时清理、快速退出后重投、`docker start` 在途强杀、同一尝试并发重投、旧代拒写、双侧停止观察和 `UNKNOWN` 恢复。真实 OpenShell 验收须能独立核对副作用次数。 [实现验收](../40-readiness/DSH-OPENSHELL-ACCEPTANCE.md)
