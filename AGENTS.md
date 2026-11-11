# Bento 仓库协作约定

- Bento 当前按全新部署构建。默认从空数据库和空运行状态初始化。除非用户明确要求，开发时无需考虑旧部署的数据迁移、旧存储格式兼容或双写。
- 同一部署重启后，持久化数据和执行恢复仍按现有契约处理。
- 按 [工程结构设计](docs/30-designs/ENGINEERING-STRUCTURE-DESIGN.md) 维护应用边界。个人端和管理端各自的 `auth`、`web`、`api` 保持平级。Run 权威状态和 Temporal 编排归一套 Go Orchestrator，Worker 保持独立。
- 变更目录、入口或部署配置时，同步检查 README、架构设计、启动命令和发布清单。实现覆盖和验证结果按实际代码记录。
- 工程、测试和文档规则见 [仓库治理说明](docs/00-governance/DOCUMENT-RULES.md)。
