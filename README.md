# bento

基于 DSH 与 OpenShell 的云端异步 Agent 平台，提供在线 Agent 工作空间。用户提交任务后，Agent 在云端隔离环境中后台执行，并交付结果。

主线源码提供单执行宿主的 Session 执行与接管入口。可信部署端提供 OpenShell 沙盒生命周期和观察，Bento 负责 Run 授权、会话持久化和接管。

## 架构

![Bento 目标架构九宫格，按应用入口、控制与编排、隔离执行分层](assets/architecture.svg)

[整体架构与当前接线](docs/00-governance/ARCHITECTURE.md) · [需求完成状况](docs/40-readiness/CURRENT-READINESS.md)

## 当前代码入口

| 目录                                                                                            | 当前职责                                                               |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`apps/workspace/auth`](apps/workspace/auth/package.json)                                       | 个人端独立构建的认证页面，由个人端 API 提供                            |
| [`apps/workspace/web`](apps/workspace/web/README.md)                                            | 个人端 `/` 工作区，包含本地启动和浏览器验收命令                        |
| [`apps/workspace/api`](apps/workspace/api/README.md)                                            | 个人端 HTTP API，Go 提供入口和 MySQL 账号仓储，TypeScript 处理业务请求 |
| [`apps/orchestrator`](apps/orchestrator/go.mod)                                                 | Go Temporal 编排模块                                                   |
| [`apps/worker`](apps/worker/run-worker.ts)                                                      | DSH Worker 进程入口                                                    |
| [`apps/orchestrator/src/execution-service`](apps/orchestrator/src/execution-service/service.ts) | 当前的执行 HTTP 服务和 Run 权威账本                                    |

[部署手册](deploy/README.md)说明如何通过[统一 Compose](deploy/compose.yaml)启动 Bento，以及如何接入 OpenShell 和 Temporal。启动 Orchestrator 前需按手册生成和配置执行环境版本。

## 设计与验证

- [需求](docs/10-requirements/README.md) · [验证与交付](docs/40-readiness/CURRENT-READINESS.md)

## 开发

[AGENTS.md](AGENTS.md) 是仓库协作入口。[工程治理规则](docs/00-governance/DOCUMENT-RULES.md)约定文档、实现、测试、提交与 PR 的做法。

Node.js 22.19+ 的 22.x 或 24+，pnpm 12.15.0，Go 1.25.3+。

TypeScript 使用 `@/` 引用仓库根目录下的源码，导入保留显式 `.ts` 路径。直接用 Node 启动仓库的 TypeScript 入口时，从仓库根目录传入 `--import ./register-paths.mjs`。

```sh
pnpm install
pnpm check
pnpm format
```

认证前端可独立执行 `pnpm --filter @bento/workspace-auth build`。

可按工程运行 `pnpm check:workspace`（个人端认证、API 和 Web）、`pnpm check:orchestrator`（Run 编排与执行宿主）或 `pnpm check:worker`（独立 Worker）。

Orchestrator 的 TypeScript 测试按模块放在 [`apps/orchestrator/tests/`](apps/orchestrator/tests/)，可通过 `pnpm --filter @bento/orchestrator test` 运行。Go Temporal 控制端位于 `apps/orchestrator/src/control/`，从 `apps/orchestrator` 运行 `go build ./src/control` 构建。

CI 按完整变更范围选择检查：Web 常规回归、空间完整性和队列隔离分别触发；Orchestrator 或 Worker 变更同时触发使用其真实执行宿主的队列验收。公共配置和未知路径执行全量检查。浏览器安装使用 Ubuntu 官方 HTTPS 软件源，保留 Chromium 与系统依赖校验。

CI 的 `Repository quality`、`Workspace checks`、`Orchestrator core checks` 和 `Worker reuse acceptance` 按既有路径判定并行执行，长时 Worker 验收不再等待常规检查。`Repository checks` 保留为聚合门禁：路径检测与质量检查必须成功，所有应执行的分支必须成功，失败、取消或意外跳过均不能通过。Orchestrator 常规分支仍使用 `pnpm --filter @bento/orchestrator check:core:fast`，本地检查命令与验收范围不变。Temporal 重投与 package 契约继续在独立的 `Temporal retry acceptance` job 执行。CI 以仅下载步骤可见的只读 GitHub token 预取官方固定 Temporal CLI 1.5.1 Linux amd64 归档，120秒上限，核对大小/SHA后通过既有 `BENTO_A6_TEMPORAL_ARCHIVE` 入口再次校验成员、binary和版本并执行九项真实验收；测试进程不接收该token，私有归档在job结束时清理。这条路径不覆盖工具默认无输入下载分支。上述拆分不改变本地 `pnpm check` 的完整验收范围。

Worker正式运行时可选用[base-bootstrap.ts](apps/worker/base-bootstrap.ts)，每轮新建官方DSH与SDK资源，清理后才返回回执。可信配置、模型factory及Task投影边界见[Worker运行时部署](deploy/README.md#worker-正式运行时与复用验证)。

`pnpm --filter @bento/orchestrator test:worker-runtime`运行bootstrap/transport单测，`test:worker-reuse`运行SDK准备、生产ingress和64轮常驻Worker验收（默认长时模式最少315秒）；两者均纳入本地 `check:core`。PR CI 使用 `BENTO_A6_WORKER_REUSE_MODE=burst` 连续执行相同64轮及隔离断言，不主动补足轮间5秒间隔；main CI和本地默认 `soak` 保留至少315秒跨度。连续模式不代表长时间驻留验证通过。GitHub CI 对仅涉及执行服务测试目录和两个 Go Temporal 测试文件的变更运行常规检查。Orchestrator 或 Worker 的运行代码、部署、验收及未知范围变更仍触发常驻 Worker 验收。SDK默认按固定官方来源真实构建，本地受控输入范围见部署手册。

使用 ESLint 与 Prettier，统一 4 空格缩进。

管理端诊断入口的配置与启动见[部署手册](deploy/README.md#管理端诊断入口)。
