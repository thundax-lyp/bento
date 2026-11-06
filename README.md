# bento

基于 DSH 与 OpenShell 的云端异步 Agent 平台，提供在线 Agent 工作空间。用户提交任务后，Agent 在云端隔离环境中后台执行，并交付结果。

当前为 TypeScript 工程骨架，尚未实现运行服务。已完成部分 DSH / OpenShell 集成验证，范围与限制见验证记录。

## 设计与验证

- [研究结论与实现验收](docs/research/README.md)：冻结架构、已验证能力、必要扩展与实现阶段验收条件。
- [平台架构](docs/research/architecture.md)：一顶层业务 Session 一沙盒、Run 调度、共享 worker 池；包括权限、持久化、恢复与扩展边界。

公开源码、主题文档与内部证据的边界见[公开发布规则](docs/PUBLISHING.md)。原始实验和部署快照不随公开仓库发布。

## 开发

Node.js >=22.13.0，pnpm 12.15.0。

```sh
pnpm install
pnpm check
pnpm format
```

使用 ESLint 与 Prettier，统一 4 空格缩进。`DRAFT.md` 为本地草稿，忽略且不提交 Git。
