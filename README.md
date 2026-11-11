# bento

基于 DSH 与 OpenShell 的云端异步 Agent 平台，提供在线 Agent 工作空间。用户提交任务后，Agent 在云端隔离环境中后台执行，并交付结果。

主线源码提供单执行宿主的 Session 执行与接管入口。可信部署端提供 OpenShell 沙盒生命周期和观察，Bento 负责 Run 授权、会话持久化和接管。

## 当前代码入口

| 目录                                                                                    | 当前职责                                                               |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`apps/workspace/auth`](apps/workspace/auth/auth-page.ts)                               | 个人端 `/auth` 页面，由个人端 API 渲染                                 |
| [`apps/workspace/web`](apps/workspace/web/README.md)                                    | 个人端 `/` 工作区，包含本地启动和浏览器验收命令                        |
| [`apps/workspace/api`](apps/workspace/api/README.md)                                    | 个人端 HTTP API，Go 提供入口和 MySQL 账号仓储，TypeScript 处理业务请求 |
| [`apps/orchestrator`](apps/orchestrator/go.mod)                                         | Go Temporal 编排模块                                                   |
| [`apps/worker`](apps/worker/run-worker.ts)                                              | DSH Worker 进程入口                                                    |
| [`apps/orchestrator/execution-service`](apps/orchestrator/execution-service/service.ts) | 当前的执行 HTTP 服务和 Run 权威账本                                    |

目标结构与实现差距见[工程结构设计](docs/30-designs/ENGINEERING-STRUCTURE-DESIGN.md)。管理端、个人端独立认证构建及 Go 接管 Run 账本仍待实现。

[部署手册](deploy/README.md)提供 Web Docker、Keycloak、OpenShell 执行宿主和 Temporal 开发环境的操作步骤。

## 设计与验证

- [需求](docs/10-requirements/README.md) · [设计](docs/30-designs/README.md) · [验证与交付](docs/40-readiness/README.md)
- [平台架构](docs/30-designs/PLATFORM-ARCHITECTURE-DESIGN.md)：一顶层业务 Session 一沙盒、Run 调度、共享 worker 池；包括权限、持久化、恢复与扩展边界。

## 开发

[AGENTS.md](AGENTS.md) 是仓库协作入口。[工程治理规则](docs/00-governance/DOCUMENT-RULES.md)约定文档、实现、测试、提交与 PR 的做法。

Node.js 22.19+ 的 22.x 或 24+，pnpm 12.15.0，Go 1.25.3+。

```sh
pnpm install
pnpm check
pnpm format
```

使用 ESLint 与 Prettier，统一 4 空格缩进。`DRAFT.md` 为本地草稿，忽略且不提交 Git。
