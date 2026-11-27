# Bento 仓库协作约定

- Bento 当前按全新部署构建。默认从空数据库和空运行状态初始化。除非用户明确要求，开发时无需考虑旧部署的数据迁移、旧存储格式兼容或双写。
- 同一部署重启后，持久化数据和执行恢复仍按现有契约处理。
- 处理本地部署、测试环境连接或服务排障时，先检查仓库根目录的 `./ENVIRONMENTS.md`，存在时读取相关章节。文件用途和维护方式见 [开发环境说明书](./ENVIRONMENTS.example.md)，CI 无需提供本地文件。文件缺失且任务确实依赖其中的信息时，向用户索取所需信息。敏感值仅供本地使用，不得复制到 Git 跟踪的文件、PR、日志或聊天回复。
- Bento 禁止使用 Git worktree。各任务使用独立的本地 Git checkout，优先复用用户指定且已核实可用的独立 clone，缺少合适目录时用 `git clone` 创建。禁止通过 `git worktree` 或 Codex 的工作树工具创建、挂载、恢复或使用工作树作为任务目录。
- 按[平台架构](docs/00-governance/ARCHITECTURE.md)维护应用边界。个人端 `apps/workspace` 和管理端 `apps/admin` 各自按 `<所属端>-<职责>` 命名应用目录，`workspace-auth`、`workspace-web`、`workspace-api` 保持平级，`admin-auth`、`admin-web`、`admin-api` 保持平级。`apps/orchestrator` 下的 Go `orchestrator-control` 持有 Run 权威状态和 Temporal 编排，TypeScript `orchestrator-execution-host` 提供执行 HTTP 和运行适配。`apps/worker` 保持独立。
- TypeScript 工程在各自的 `package.json` 声明运行依赖。仓库内 TypeScript 导入使用显式 `.ts` 路径。跨两级及以上父目录的导入使用仓库根别名 `@/`。Orchestrator 的 TypeScript 公共入口是 `apps/orchestrator/index.ts`。
- 变更目录、入口或部署配置时，同步检查 README、架构设计、启动命令和发布清单。实现覆盖和验证结果按实际代码记录。
- 工程、测试和文档规则见 [仓库治理说明](docs/00-governance/DOCUMENT-RULES.md)。
- 创建、修改、审计、执行或收口临时 RUNBOOK 前，读取 [RUNBOOK Rules](docs/00-governance/RUNBOOK-RULES.md)。
