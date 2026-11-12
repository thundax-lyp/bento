# RUNBOOK · WEB-03 已保存单文件生命周期

状态 `Executable`，执行中。2026-11-12 建立于 bento-a 的 `main` / `origin/main`，基线 `b33c8e722a26126556d01794a82756f9b11b42fc`。范围为 [WEB-03 与 WEB-A05](../10-requirements/WEB-REQUIREMENTS.md#web-03-空间额度与文件生命周期) 中的单文件预览、删除、对象清理和额度回收。仅做已保存 UTF-8 文件预览，保留下载、执行快照和历史 Run/diff。项目整体删除、文件树改版、二进制预览及上传协议排除。

现有 `apps/workspace/api/space.ts` 的 `mySpace.route` 只提供已保存文件下载。 `apps/workspace/api/space-execution.ts` 的 `spaceExecution.start` 绑定不可变输入清单。Go 入口 `apps/workspace/api/go/main.go` 将 `/api/` 转发给 task-entry，`projects.go` 的直接提交路由在此基线未注册。task-entry 的 Run 提交最终由 `apps/orchestrator/execution-service/http.ts` 调用 `Store.addRun`。空间 API 先查询 Run 再写删除状态仍会留下竞态。Run 入队门禁归 [Orchestrator](../00-governance/ARCHITECTURE.md#应用与编排的目标职责)，对象与额度归空间 API。遵循 [Web 接口](../20-interfaces/WEB-INTERFACE.md#项目详情及目标扩展)、[单文件删除设计](WEB-DESIGN.md#单文件删除--目标) 和 [Readiness](../40-readiness/CURRENT-READINESS.md)。

## 执行前检查（T0，作者或维护者负责）

本节在机械步骤之外，不计步骤和文件数。核对干净基线与获授权的执行分支、Node 22、锁定 pnpm、依赖和 Chromium headless shell。检查 4319/4320 空闲，测试对象源另用随机回环端口。以 `git status --short --branch`、`git rev-parse main origin/main` 及 `git diff --check` 核对起点。本地 fixture 不读真实配置，也不依赖主 checkout 的部署改动。维护者已在独立任务分支核对执行条件。

WEB-03 单文件生命周期与 WEB-07 取消 Run 各在独立分支编写和验证。并行实施时，本计划的预览 T1–T2 可先行。已核对两个分支共同基线 b33c8e7，用户确认 WEB-03 先合入、WEB-07 后合入。WEB-07 在包含 WEB-03 的最新 main 上聚焦复验交叠的 Run 入队、取消状态和单文件删除门禁。

## 执行与提交

从仓库根执行 T1–T7。文件数包含专门核对和 RUNBOOK，不含工具间接读入的依赖或 fixture 自动生成的 SQLite sidecar。每步 PASS 后移除已完成步骤，将后续前置改为可检查的已提交产物或验证事实，保留后续编号，按步将产物、必要的公开清单条目和 RUNBOOK 清理一起本地提交。T7 同次提交删除本文。STOP 时保留现场、未完成步骤和持久状态，报告最后 PASS 的提交、触发点、复现命令及脱敏结果。Fixture 退出后只清理其自建临时资源。无事件、outbox、旧部署迁移或新清理框架。

## 机械步骤

### T6：单文件删除确认与反馈

前置状态：HEAD 已包含空间 DELETE 端点、删除阶段持久化、sweep 恢复和浏览器只读 deleting 状态。workspace-api 与 Web typecheck、space-files.test.ts 两个 fixture 已通过。

允许修改：`apps/workspace/web/src/space-api.ts`、`apps/workspace/web/src/space.tsx`、`apps/workspace/web/e2e/space-preview.spec.ts` 及本文。另核对 `apps/workspace/web/playwright.config.ts`。共 5 个文件。

禁止修改：项目级删除、任务历史、原下载、上传及取消。

执行：

1. 新增 `deleteSpaceFile(id:string): Promise<'deleting'|'deleted'>`，复用 `request` 同源 DELETE，15 秒超时，202 映射 deleting，204 映射 deleted。其他响应走现有失败提示。 `spaceQuery` 仅在当前数据含 deleting 时每 2 秒回读。
2. 在 `CloudProject` 的 saved 行加「删除文件」，先显示原路径和影响「将删除这个原文件，清理完成后释放额度。已有任务与补丁仍可查看」。确认前保留下载，取消确认零请求。确认只发一次同 ID DELETE，关闭同文件预览并刷新空间和项目，202 依服务端状态显示清理中，204 移除该行，额度只由 GET 更新。409 显示服务器原因，503/网络超时提示「暂未确认删除结果，请刷新后重试」，不自动发起 DELETE；再次确认沿用同 fileId。正在删除行仅展示状态。
3. 在现有 Chromium fixture 追加单文件删除用例。验证取消确认零写入、409 保留下载、随后确认得到 202 时下载消失且额度未变、后台状态推进后同一行消失并释放正确字节。已有预览用例仍通过。

验证：

```bash
pnpm --filter @bento/web typecheck
pnpm --filter @bento/web test:e2e space-preview.spec.ts
```

PASS：两条退出 0，现有预览和删除交互 fixture 全部通过。

STOP：出现提前扣减、取消也发请求、跳过确认或误删历史的行为。

### T7：同步接口、设计和验证证据

前置状态：T1–T6 的源码和 fixture 已提交，所有列明的聚焦命令通过。用已提交步骤的验证输出确认，不重复读取代码或运行测试。

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
