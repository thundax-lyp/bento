# RUNBOOK · WEB-08 单轮文件变更审阅

执行分支 `codex/web-08-file-diff-review-exec` 从已审核 RUNBOOK 提交 `ec997ce74bf41c2908d6aa258da1b8a689058682` 开始。单轮预览和原文切换已通过聚焦测试。剩余步骤完成后将两个长期文档和本 RUNBOOK 的删除一起本地提交。

## 机械步骤

### T2：同步说明并收口

前置状态：执行分支 HEAD 的父提交为 `ec997ce74bf41c2908d6aa258da1b8a689058682`。HEAD 的提交标题是 `Feat(task-entry): 支持单轮补丁逐文件审阅`，其改动限五个实现文件和本 RUNBOOK。工作树与暂存区均为空。2026-11-12 在此执行工作树运行 `pnpm --filter @bento/web test src/ui.test.tsx`，2 项通过。

允许修改：`docs/30-designs/WEB-DESIGN.md`、`docs/40-readiness/CURRENT-READINESS.md` 的 WEB-08 行，全部检查通过后删除本 RUNBOOK。

文件清单（9）：以上三个文件、`apps/workspace/web/tsconfig.json`、`apps/workspace/web/src/file-diff.ts`、`apps/workspace/web/src/ui.tsx`、`apps/workspace/web/src/pages.tsx`、`apps/workspace/web/src/ui.test.tsx`和 `docs/10-requirements/WEB-REQUIREMENTS.md`（核对 WEB-08 原链接）。

禁止修改：其他需求、接口、部署、公开清单。

执行：

1. 在 [Web 设计](WEB-DESIGN.md#提交与交付) 更新 `DiffPreview` 组件标注和单轮预览行为。WEB-08 保持「部分实现」，写入实际的聚焦 fixture 证据，注明真实部署、多轮、累计补丁、检查结果未覆盖。沿用现有 WEB-08 链接。
2. 检查空白、范围和残留引用。相对当前 HEAD，检查工作树只改两个长期文档。残留引用搜索只查本次可新增引用的七个改动文件。退出 1 且无输出才表示无引用。全部 PASS 后删除本 RUNBOOK，再确认路径不存在。

验证：

```bash
git diff --check
git status --short
rg -n '^### WEB-08 结果审阅与交付$' docs/10-requirements/WEB-REQUIREMENTS.md
rg -nF 'RUNBOOK-WEB-08-FILE-DIFF-REVIEW' \
    docs/30-designs/WEB-DESIGN.md docs/40-readiness/CURRENT-READINESS.md \
    apps/workspace/web/tsconfig.json apps/workspace/web/src/file-diff.ts \
    apps/workspace/web/src/ui.tsx apps/workspace/web/src/pages.tsx \
    apps/workspace/web/src/ui.test.tsx
```

PASS：前三条退出 0、变更路径符合清单、最后一条退出 1 且无输出。之后执行 `rm -- docs/30-designs/RUNBOOK-WEB-08-FILE-DIFF-REVIEW.md && test ! -e docs/30-designs/RUNBOOK-WEB-08-FILE-DIFF-REVIEW.md`。

STOP：命令失败、发现残留、超出范围或实际证据不足时保留 RUNBOOK，报告触发项。
