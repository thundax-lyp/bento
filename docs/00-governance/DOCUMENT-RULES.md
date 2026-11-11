# Document Rules

## Purpose

本文档定义 Bento 工程文档的分类、命名、真相源、写作、同步和迁移规则，使文档能够被人类审阅、被 Agent 最小化加载，并随代码一起通过 Git 维护。

## Authority And Read Order

按文档职责读取最小必要范围：

1. [工程治理](./DOCUMENT-RULES.md)：`docs/00-governance/` 维护稳定的开发、验证和交付规则。
2. [需求](../10-requirements/README.md)和已确认的接口：约束可验收的产品行为、跨边界契约和兼容性。
3. [设计](../30-designs/README.md)：记录如何实现需求与契约。
4. [Readiness](../40-readiness/README.md)：记录实现覆盖、验证结果和未覆盖范围。
5. [部署手册](../../deploy/README.md)：维护通用运行流程。

讨论、草稿与原始验证材料用于解释背景和追溯证据。结论确认后写入对应的工程文档；原始日志及远端配置留在本地受控工作区。

当文档之间发生冲突时，不得静默选择方便实现的一方。应按文档职责、适用范围和已确认的需求、契约或决策依据判断。更新时间仅用于追溯变更，不能证明新内容已经确认，也不能让讨论稿或当前代码覆盖正式口径；无法消解时，将冲突记录为待讨论项并请求人工确认。

## Directory Responsibilities

### `00-governance`

- 保存稳定、跨任务适用的工程规则。
- 不记录一次任务的执行过程、临时方案或完成历史。
- 规则变化时检查直接引用它的入口和 Skill。
- 系统组成、所有权和依赖边界由[平台架构](../30-designs/PLATFORM-ARCHITECTURE-DESIGN.md)定义；源码目录和导入约定由 `ARCHITECTURE-RULES.md` 定义。依赖版本、provider 与源码接线由对应设计维护，治理文档只引用其入口。
- 暂存、提交和历史修改规则统一由 `COMMIT-RULES.md` 定义。
- 分支、PR、Review、CI 和合并规则统一由 `PR-RULES.md` 定义。

### `10-requirements`

- 只保存已经确认、可以形成验收标准的需求。
- 必须区分 Scope、Non-goals、业务规则和 Acceptance Criteria。
- 不保存框架选型、类结构、数据库实现或仍待讨论的产品问题。

### 接口

- 保存进程、模块和外部系统之间的接口、事件、状态、错误、权限、配置与数据格式契约。
- 契约应说明 producer、consumer、所有权、兼容策略和失败语义。
- 可机器校验的 Schema 应与说明文档放在同一目录，并明确哪一方是真相源。

### `30-designs`

- 保存模块设计、状态机、数据所有权、依赖方向和专项设计。
- 设计必须关联需求或契约，不能替代产品决策。
- 复杂临时任务可以使用 `RUNBOOK-*.md`；任务关闭时必须迁移长期结论并删除 RUNBOOK。

### `40-readiness`

- 保存实现覆盖矩阵、测试结果、运行时证据、未覆盖项和交付状态。
- 证据必须记录日期、验证范围、环境或 commit 边界、执行方式、结果和 `Not Covered`。
- “进程已启动”“端口正在监听”或单次命令成功不能自动证明业务就绪。

### `deploy/README.md`

- 保存可重复执行的启动、停止、诊断、恢复、升级、发布和故障处置流程。
- 操作文档必须列出前置条件、执行步骤、成功判据、失败处理和恢复方式。
- 自动化脚本是执行入口时，文档应引用脚本而不是复制一份可能漂移的实现。

## Repository Entry And Design Ownership

[README](../../README.md) 链接仓库的使用、设计和开发入口。完整规则由对应文件维护，Skill 引用规则并提供操作流程，不另建规则副本。

- 实现和验证：[架构规则](./ARCHITECTURE-RULES.md)。
- 小步交付：[Commit 规则](./COMMIT-RULES.md)、[PR 规则](./PR-RULES.md)。

| 文档                                                             | 维护内容                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------- |
| [平台架构](../30-designs/PLATFORM-ARCHITECTURE-DESIGN.md)        | 系统组成、Session 与 Workspace 的所有权、执行与权限边界 |
| [能力与证据](../40-readiness/DSH-OPENSHELL-EVIDENCE.md)          | 已验证能力、证据的适用条件和未覆盖边界                  |
| [实施设计](../30-designs/DSH-OPENSHELL-IMPLEMENTATION-DESIGN.md) | 实现阶段和必要扩展                                      |
| [交付验收](../40-readiness/DSH-OPENSHELL-ACCEPTANCE.md)          | 放行条件和验收所需证据                                  |
| [部署手册](../../deploy/README.md)                               | 接入、运行和部署前提                                    |

## File Naming

- 治理文件沿用 `*-RULES.md`；同主题新文档沿用现有目录的命名风格，不使用中文或空格。以下命名约定用于独立的工程文档，不要求重命名现有主题文档。
- 固定入口文件可以使用 `README.md` 和 `AGENTS.md`。
- 需求文档命名为 `*-REQUIREMENTS.md`。
- 接口文档命名为 `*-INTERFACE.md`，机器契约使用相同主题名称。
- 模块设计命名为 `*-DESIGN.md`，专项设计命名为 `*-SPECIAL-DESIGN.md`。
- 临时执行手册命名为 `RUNBOOK-*.md`。
- 可重复操作说明命名为 `HOW-TO-*.md`。
- 验证证据命名为 `*-EVIDENCE.md`，交付门槛命名为 `*-ACCEPTANCE.md`，实现覆盖命名为 `*-IMPLEMENTATION-COVERAGE.md`。
- 讨论材料应通过文件名明确标记 `DRAFT`、`RESEARCH` 或 `ARCHIVE` 等状态。

## Language And Style

- 业务和工程说明使用中文。
- 协议名、类型名、字段名、模块名、命令和工具名保留英文原文。
- 文档应明确、简洁、可执行，不使用宣传性语言代替边界、规则或验收标准。
- 事实、已确认规则、候选方案和推断必须明确区分。
- 同一规则只保留一个当前真相源，其他文档使用链接引用。
- Mermaid 流程图应显式使用 ELK 布局；非流程图不强制。

## Required Structures

以下清单规定必须覆盖的语义，不要求逐项使用同名独立章节。可以合并标题、表格或引用已有真相源；不得省略当前任务相关的内容，也不为无关主题填充空泛段落。不适用项可以集中说明及给出原因。

需求文档覆盖：

- `Purpose`
- `Scope`
- `Non-goals`
- `Functional Requirements`
- `Business Rules`
- `Acceptance Criteria`
- `Related Documents`

接口文档覆盖：

- `Purpose`
- `Boundary And Ownership`
- `Transport Or Invocation`
- `Data And State Contract`
- `Error And Permission Semantics`
- `Compatibility`
- `Related Documents`

设计文档覆盖：

- `Purpose`
- `Scope And Non-goals`
- `Related Requirements And Interfaces`
- `Responsibilities And Dependencies`
- `State And Failure Handling`
- `Security And Observability`
- `Acceptance`

readiness 证据覆盖：

- `Scope`
- `Validated Contract`
- `Executed Validation`
- `Not Covered`
- `Closure`

## Document Lifecycle

1. 讨论与调研保留状态标记；决策确认后迁移到对应需求、契约或设计。
2. 实现和验证完成后更新对应证据与未覆盖范围；稳定的操作流程同步到部署文档。
3. 当前结论迁移完成后删除重复表述或明确归档状态。

## Document Sync

变更收口前至少检查：

- 产品行为或接口变化：更新对应需求、跨边界契约或当前维护其语义的主题文档。
- 系统组成、所有权或依赖方向变化：更新[平台架构](../30-designs/PLATFORM-ARCHITECTURE-DESIGN.md)。
- 实现结构、状态机或失败处理变化：更新对应设计。DSH / OpenShell 的实施顺序和复用方案由[实施设计](../30-designs/DSH-OPENSHELL-IMPLEMENTATION-DESIGN.md)维护。
- 验证范围、交付状态或已知缺口变化：更新对应验收或证据，注明基线和未覆盖项。
- 启动、恢复、升级或发布方式变化：更新受影响的部署或发布说明。
- 固定工程做法变化：更新对应治理规则及直接引用它的入口。仅落实既有规则的代码迁移不要求改写规则。

纯实现补齐且未改变既有口径时，不应顺手改写无关文档。公开文件以 [public-files.json](../../public-files.json) 为准，npm 打包范围由 [package.json](../../package.json) 的 `files` 独立维护。原始验证材料和远端配置保存在受控工作区，公开证据使用审阅过的脱敏副本。

提交前核对暂存文件与公开白名单、敏感信息和文档链接。CI 的 Repository checks 拒绝 Git 跟踪的 Python 文件。使用 `npm pack --dry-run --json` 检查 npm 打包文件。

## Skill Boundary

- `.agents/skills/` 保存项目专用、可重复执行的 Agent 工程工作流。
- 仓库通用 Skill 放在仓库根 `.agents/skills/`；只有确实限定于子工程时，才放在该子目录的 `.agents/skills/`。
- 跨仓库个人 Skill 放在 `$HOME/.agents/skills/`，不得作为 Bento 仓库交付内容。
- Skill 可以引用治理、需求、接口、设计和操作文档，但不能成为产品需求或业务契约的唯一真相源。
- `.agents/skills/` 中的 Skill 不能直接作为 Bento 产品运行时角色或模板的真相源。

产品运行时数据、角色和模板由产品契约与架构维护，不属于工程 Skill。
