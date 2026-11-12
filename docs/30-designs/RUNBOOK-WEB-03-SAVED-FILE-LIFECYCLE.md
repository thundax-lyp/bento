# RUNBOOK · WEB-03 已保存单文件生命周期

状态 `Executable`，执行中。2026-11-12 建立于 bento-a 的 `main` / `origin/main`，基线 `b33c8e722a26126556d01794a82756f9b11b42fc`。范围为 [WEB-03 与 WEB-A05](../10-requirements/WEB-REQUIREMENTS.md#web-03-空间额度与文件生命周期) 中的单文件预览、删除、对象清理和额度回收。仅做已保存 UTF-8 文件预览，保留下载、执行快照和历史 Run/diff。项目整体删除、文件树改版、二进制预览及上传协议排除。

现有 `apps/workspace/api/space.ts` 的 `mySpace.route` 只提供已保存文件下载。 `apps/workspace/api/space-execution.ts` 的 `spaceExecution.start` 绑定不可变输入清单。Go 入口 `apps/workspace/api/go/main.go` 将 `/api/` 转发给 task-entry，`projects.go` 的直接提交路由在此基线未注册。task-entry 的 Run 提交最终由 `apps/orchestrator/execution-service/http.ts` 调用 `Store.addRun`。空间 API 先查询 Run 再写删除状态仍会留下竞态。Run 入队门禁归 [Orchestrator](../00-governance/ARCHITECTURE.md#应用与编排的目标职责)，对象与额度归空间 API。遵循 [Web 接口](../20-interfaces/WEB-INTERFACE.md#项目详情及目标扩展)、[单文件删除设计](WEB-DESIGN.md#单文件删除--目标) 和 [Readiness](../40-readiness/CURRENT-READINESS.md)。

## 执行前检查（T0，作者或维护者负责）

本节在机械步骤之外，不计步骤和文件数。核对干净基线与获授权的执行分支、Node 22、锁定 pnpm、依赖和 Chromium headless shell。检查 4319/4320 空闲，测试对象源另用随机回环端口。以 `git status --short --branch`、`git rev-parse main origin/main` 及 `git diff --check` 核对起点。本地 fixture 不读真实配置，也不依赖主 checkout 的部署改动。维护者已在独立任务分支核对执行条件。

WEB-03 单文件生命周期与 WEB-07 取消 Run 各在独立分支编写和验证。并行实施时，本计划的预览 T1–T2 可先行。已核对两个分支共同基线 b33c8e7，用户确认 WEB-03 先合入、WEB-07 后合入。WEB-07 在包含 WEB-03 的最新 main 上聚焦复验交叠的 Run 入队、取消状态和单文件删除门禁。

## 执行与提交

从仓库根执行 T1–T7。文件数包含专门核对和 RUNBOOK，不含工具间接读入的依赖或 fixture 自动生成的 SQLite sidecar。每步 PASS 后移除已完成步骤，将后续前置改为可检查的已提交产物或验证事实，保留后续编号，按步将产物、必要的公开清单条目和 RUNBOOK 清理一起本地提交。T7 同次提交删除本文。STOP 时保留现场、未完成步骤和持久状态，报告最后 PASS 的提交、触发点、复现命令及脱敏结果。Fixture 退出后只清理其自建临时资源。无事件、outbox、旧部署迁移或新清理框架。

## 机械步骤

### T7：同步接口、设计和验证证据

前置状态：HEAD 已含预览和单文件删除的账本、API、界面及 fixture，各产物按步提交。Orchestrator、workspace-api 与 Web typecheck，以及 T1–T6 的 Node 和 Chromium 聚焦用例均已通过。

允许修改：`docs/20-interfaces/WEB-INTERFACE.md`、`docs/30-designs/WEB-DESIGN.md`、`docs/40-readiness/CURRENT-READINESS.md`、`apps/workspace/api/README.md`，最后删除本文。共 5 个文件。

禁止修改：需求、部署配置、项目整体删除口径。

执行：将文本预览及单文件删除标为已实现，记录 302/413、DELETE 202/204、404 等价、409/503、私有入队门禁及删除额度确认点。Web 设计保留项目删除为目标。API README 写明私有桶需允许本 Web origin 的 CORS GET，沿用既有 PUT 配置。Readiness 的 WEB-03 保留「部分实现」，记录实际基线、Node/Chromium fixture、覆盖范围，注明真实 S3/CORS、真实多账号和项目整体删除未验收。沿用原有文档链接。

验证：

```bash
pnpm exec prettier --check docs/20-interfaces/WEB-INTERFACE.md docs/30-designs/WEB-DESIGN.md docs/40-readiness/CURRENT-READINESS.md apps/workspace/api/README.md
git diff --check
if rg -n -F 'RUNBOOK-WEB-03-SAVED-FILE-LIFECYCLE' docs/20-interfaces/WEB-INTERFACE.md docs/30-designs/WEB-DESIGN.md docs/40-readiness/CURRENT-READINESS.md apps/workspace/api/README.md; then
    exit 1
else
    test "$?" -eq 1
fi
```

PASS：格式和空白检查通过，rg 退出 1 表示无引用。随后 `rm docs/30-designs/RUNBOOK-WEB-03-SAVED-FILE-LIFECYCLE.md`，用 `test ! -e docs/30-designs/RUNBOOK-WEB-03-SAVED-FILE-LIFECYCLE.md` 核对，并与四份文档同次提交。

STOP：证据缺项、范围不符、引用存在或扫描失败，保留本文。

作者自检按 [RUNBOOK Rules](../00-governance/RUNBOOK-RULES.md) 和 [文档规则](../00-governance/DOCUMENT-RULES.md) 核对基线、源码、公开文件登记、步骤及验收边界。交付阶段仅验证文档。
