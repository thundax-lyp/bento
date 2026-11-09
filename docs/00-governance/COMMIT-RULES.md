# Commit Rules

## Purpose

本文档定义 Bento 的提交授权、Commit 边界、消息格式、验证、TODO 同步和历史修改规则。

Commit 用于记录一个明确的工程判断或小步能力变化，不代表阶段性交付完成。阶段性交付、Review、CI 和合并规则由 `PR-RULES.md` 定义。

## Authorization

- 修改完成后默认保留在工作区；只有用户明确要求“提交”时，才执行暂存和 commit。
- 暂存、commit、push、创建 PR 和合并 PR 是不同操作，不能从单项授权推断用户未表达的其他操作。用户可以在一句请求中同时授权多项操作；已明确的组合授权持续有效，不逐步重复确认。
- 用户只要求修改、检查或验证时，不得自动 commit。
- 用户明确要求提交时，只提交当前任务范围内的文件，不纳入无关或归属不明的工作区改动。

## Commit Boundary

- 一个 commit 表达一个可以用一句话说明的工程判断、小步能力变化、测试锁定、配置装配或文档规则落点。
- 同一判断需要的代码、测试、接口契约、配置和文档应放在同一个 commit。
- 不同判断、独立风险或可以单独回滚的变化应拆成不同 commit。
- Commit 可以是阶段任务的中间判断，但必须语义明确、范围可解释，并且不故意留下不清楚的破坏状态。
- 不为了减少 commit 数量机械 squash。
- 不为了追求小文件数拆出无法独立理解或验证的中间状态。
- 文件数量只用于帮助检查内聚性，不作为机械拆分或合并标准。
- 不混入与当前任务无关的格式化、重构、临时文件或用户已有改动。

## Commit Message

Commit message 延续 Bento 当前历史的格式：

```text
type(scope): <工程判断或能力变化>
```

- 使用小写类型，如 `feat`、`fix`、`docs`、`test`、`refactor` 或 `ci`。
- Scope 使用稳定模块或工程领域，例如 `openshell`、`research`、`governance`；没有清晰归属时可省略。
- 标题用一句话说明本次完成的工程判断或行为变化；需要时在正文说明动机、不可拆分的原因和验证。

## Before Commit

提交前必须：

1. 检查 `git status` 并阅读完整待提交 diff，确认仅包含当前任务改动，无凭据、临时数据或无关个人路径。
2. 确认满足 [Engineering Rules](./ENGINEERING-RULES.md#validation-and-evidence) 的相关验证与证据要求；适用证据可以复用，不要求仅因 commit 再运行相同检查。
3. 按下节核对文档和已登记任务同步；明确本 commit 的工程判断，不能把未完成范围描述为完成。

## TODO And Document Sync

文档同步按 [Document Rules](./DOCUMENT-RULES.md#document-sync)。涉及已登记 TODO 时，按 [TODO Closure Rules](./TODO-RULES.md#closure-rules) 在完成该项的 commit 中删除或收窄；涉及 RUNBOOK 时按其 [Completion And Deletion](./RUNBOOK-RULES.md#completion-and-deletion) 处理。未涉及的项目不新增检查记录或文档。

## History Safety

- 不自动 amend、rebase、squash 或重写已有 commit；只有用户明确要求时才能修改历史。
- 不重写已经发布到远端或进入协作范围的历史，除非用户明确确认具体范围和风险。
- 需要更新已发布历史时，只使用安全的 lease 保护方式，不使用无保护的 force push。
- 不使用破坏性命令丢弃用户提交、工作区改动或未跟踪文件。
