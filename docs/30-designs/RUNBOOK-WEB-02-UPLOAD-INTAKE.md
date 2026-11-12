# RUNBOOK · WEB-02 上传前清单

状态 `Executable`。建立于 2026-11-12。执行分支 `codex/web-02-upload-intake-exec`，起点 `9a3afb9`。从仓库根目录按剩余步骤执行。每步最多涉及 10 个修改、新增、删除或专门核对的文件。前置或验证失败时停下，报告步骤、路径、复现命令和实际结果，保留改动供核对。

现有 `CloudProject.send` 从两个 picker 读文件后直接上传。本轮在该入口增加文件拖放和确认清单。文件夹仍通过原 picker 选择并保留相对路径。已开始上传的取消、服务端、存储协议和真实 S3 验收沿用原范围。产品与 API 依据见 [WEB-02](../10-requirements/WEB-REQUIREMENTS.md#web-02-上传与续传)、[空间接口](../20-interfaces/WEB-INTERFACE.md#我的空间--web-02--web-03)、[上传与续传设计](WEB-DESIGN.md#上传与续传)。服务端继续按账号、项目、路径、摘要和实时额度受理。浏览器清单只是当前快照，确认前没有写请求。

## 执行前检查（作者或维护者）

作者已在独立 worktree 核对干净起点、Node 22、锁定 pnpm、本地 Chromium、mock 端口和 dev.env 忽略规则。该检查不计入机械步骤。

## 机械步骤

### T2 · 验证现有上传入口

前置状态：`git diff --quiet -- apps/workspace/web/src/space.tsx` 通过，HEAD 中的 `CloudProject` 已包含文件 drop、上传前清单与「确认上传」。Web typecheck 和 `src/space-api.test.ts` 已通过。

文件清单：5 个。新增 `apps/workspace/web/e2e/upload-intake.spec.ts`，核对 `apps/workspace/web/src/space.tsx` 与 `apps/workspace/web/playwright.config.ts`，临时新建和删除 fixture `root/nested.txt`，PASS 后从本 RUNBOOK 移除此步。

禁止修改：生产逻辑与 mock 服务。

执行：用一个 Playwright 用例，复用现有 Chromium/Vite 配置，在 `page.route` 固定会话、项目、空间和上传接口。用模拟 drop 提供两个文件项和一个目录项。一个文件为项目已保存的同名路径，另一个为 0 字节的新文件。通过 entry fixture 明确区分文件与目录。断言项目名、清单、可用额度、同名冲突和目录 picker 提示。放弃时零写入，重拖后确认时只有新文件发送注册和完成，注册摘要为空且无需分块。同一用例先用 `mkdtemp` 建立 1 字节的 `root/nested.txt`，目录 picker 选 root，断言清单出现 `root/nested.txt` 后放弃，finally 删除该临时目录。

验证：

```bash
pnpm --filter @bento/web test:e2e upload-intake.spec.ts
git diff --check
```

PASS：退出 0，确认之前无写入，确认后两个拒收项均无写入，新文件保存。
STOP：任一断言不符，报告失败断言及对应的页面行为。真实 S3 和原生目录拖放不计入本轮验证。

### T3 · 同步已验证范围并收口

前置状态：页面实现已提交，现有续传单测和本 RUNBOOK 指定的 Chromium 用例均通过。

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
