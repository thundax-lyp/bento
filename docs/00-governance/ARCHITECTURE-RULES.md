# Architecture Rules

## Purpose And Scope

本文定义 Bento 源码的目录、模块入口、依赖与执行边界。系统组成、所有权和依赖方向由 [Architecture](../30-designs/PLATFORM-ARCHITECTURE-DESIGN.md) 定义；本文件只规定如何在源码中落实这些边界。

规则分为两个独立层级：`Hard Rules` 必须有稳定、实际执行的门禁；`Review Rules` 由人工或 Agent 结合职责语义审阅。相同要求不得在两层重复。Review Rule 有可靠门禁后，迁入 Hard Rules，并删除原审阅条目。

## Hard Rules

- TypeScript 严格类型检查、NodeNext 模块解析和 ESLint 规则由仓库根配置定义，统一通过 `pnpm check` 执行。

## Review Rules

- 源码按 [Bento 工程结构](../30-designs/ENGINEERING-STRUCTURE-DESIGN.md) 划分工程边界。

- 对外 API 由 `apps/orchestrator/index.ts` 显式导出；内部模块只公开当前调用方需要的能力，不为缩短路径建立无职责的入口。
- 保持 NodeNext/ESM 约定：引用仓库内 TypeScript 模块时使用当前源码的显式 `.ts` 路径，不引入未经配置的路径别名或目录导入。
- 新增入口或移动文件时审阅职责、依赖方向和授权边界。执行入口必须保留 generation 校验和会话所有权约束；恢复流程保留原 Session 与 Workspace，不自动重放 UNKNOWN 工具调用。边界变化时同步 [Architecture](../30-designs/PLATFORM-ARCHITECTURE-DESIGN.md)。
