# RUNBOOK · WEB-02 上传前清单

状态 `Executable`。建立于 2026-11-12。执行分支 `codex/web-02-upload-intake-exec`，起点 `9a3afb9`。从仓库根目录按剩余步骤执行。每步最多涉及 10 个修改、新增、删除或专门核对的文件。前置或验证失败时停下，报告步骤、路径、复现命令和实际结果，保留改动供核对。

现有 `CloudProject.send` 从两个 picker 读文件后直接上传。本轮在该入口增加文件拖放和确认清单。文件夹仍通过原 picker 选择并保留相对路径。已开始上传的取消、服务端、存储协议和真实 S3 验收沿用原范围。产品与 API 依据见 [WEB-02](../10-requirements/WEB-REQUIREMENTS.md#web-02-上传与续传)、[空间接口](../20-interfaces/WEB-INTERFACE.md#我的空间--web-02--web-03)、[上传与续传设计](WEB-DESIGN.md#上传与续传)。服务端继续按账号、项目、路径、摘要和实时额度受理。浏览器清单只是当前快照，确认前没有写请求。

## 执行前检查（作者或维护者）

作者已在独立 worktree 核对干净起点、Node 22、锁定 pnpm、本地 Chromium、mock 端口和 dev.env 忽略规则。该检查不计入机械步骤。

## 机械步骤

### T3 · 同步已验证范围并收口

前置状态：HEAD 含 `apps/workspace/web/src/space.tsx` 的上传确认逻辑和 `apps/workspace/web/e2e/upload-intake.spec.ts` 的浏览器用例，两个路径无待提交改动。Web typecheck、`test src/space-api.test.ts` 与 `test:e2e upload-intake.spec.ts` 均已退出 0。

文件清单：3 个。修改 `docs/30-designs/WEB-DESIGN.md`、`docs/40-readiness/CURRENT-READINESS.md` 的 WEB-02 描述，最后删除本 RUNBOOK。

禁止修改：需求、接口、发布清单和部署流程。

执行：设计记录文件 drop、目录 picker、清单、显式确认及原上传链路。Readiness 记录实际日期和基线、聚焦测试结果，明确目录拖放、真实 S3 边界和取消增强未覆盖。保留 WEB-02「部分实现」。没有新增链接。先检查再删除本文。

验证：

```bash
git diff --check
pnpm exec prettier --check docs/30-designs/WEB-DESIGN.md docs/40-readiness/CURRENT-READINESS.md
if rg -n -F 'RUNBOOK-WEB-02-UPLOAD-INTAKE' docs/30-designs/WEB-DESIGN.md docs/40-readiness/CURRENT-READINESS.md; then
    exit 1
else
    test "$?" -eq 1
fi
```

PASS：两条检查通过，rg 退出 1 表示无引用。此后运行 `rm docs/30-designs/RUNBOOK-WEB-02-UPLOAD-INTAKE.md` 和 `test ! -e docs/30-designs/RUNBOOK-WEB-02-UPLOAD-INTAKE.md`，两条均退出 0。
STOP：证据未落档、rg 命中或搜索出错时保留本文。

作者自检核对了 [RUNBOOK 规则](../00-governance/RUNBOOK-RULES.md)、[文档规则](../00-governance/DOCUMENT-RULES.md)、[平台架构](../00-governance/ARCHITECTURE.md)、现有页面及 API 入口。
