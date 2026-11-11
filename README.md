# bento

基于 DSH 与 OpenShell 的云端异步 Agent 平台，提供在线 Agent 工作空间。用户提交任务后，Agent 在云端隔离环境中后台执行，并交付结果。

主线源码提供单执行宿主的 Session 执行与接管入口。可信部署端提供 OpenShell 沙盒生命周期和观察，Bento 负责 Run 授权、会话持久化和接管。接入方式见[部署说明](docs/deployments/openshell-dsh.md#单执行宿主接入)。 单执行宿主的 Temporal Run 调度见 [Temporal 开发环境](docs/deployments/HOW-TO-TEMPORAL-DEV.md)。

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

[Web 单镜像部署](docs/deployments/HOW-TO-WEB-DOCKER.md)提供 Docker Compose 配置。NGINX 同域提供前端和 API，Go 提供 API 入口与 MySQL 账号仓储，task-entry 在容器内处理业务请求。Compose 包含持久化的 MySQL 8.4 服务。

受邀注册、邮箱验证及认证审计的配置见 [Keycloak 受邀认证](docs/deployments/HOW-TO-WEB-DOCKER.md#keycloak-受邀认证)。

## 设计与验证

- [研究结论与实现验收](docs/research/README.md)：冻结架构、已验证能力、必要扩展与实现阶段验收条件。
- [平台架构](docs/research/architecture.md)：一顶层业务 Session 一沙盒、Run 调度、共享 worker 池；包括权限、持久化、恢复与扩展边界。

公开源码、主题文档与内部证据的边界见[公开发布规则](docs/PUBLISHING.md)。原始实验和部署快照不随公开仓库发布。

## 开发

[AGENTS.md](AGENTS.md) 是仓库协作入口。[工程治理规则](docs/00-governance/DOCUMENT-RULES.md)约定文档、实现、测试、提交与 PR 的做法。

Node.js 22.19+ 的 22.x 或 24+，pnpm 12.15.0，Go 1.25.3+。

```sh
pnpm install
pnpm check
pnpm format
```

使用 ESLint 与 Prettier，统一 4 空格缩进。`DRAFT.md` 为本地草稿，忽略且不提交 Git。
