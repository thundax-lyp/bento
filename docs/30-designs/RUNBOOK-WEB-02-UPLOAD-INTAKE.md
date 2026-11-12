# RUNBOOK · WEB-02 上传前清单

状态 `Executable`，待交叉审核。建立于 2026-11-12。任务分支 `codex/web-02-upload-intake`，基线 `88979d0`。实施授权后从仓库根目录按 T1–T3 执行。每步最多涉及 10 个修改、新增、删除或专门核对的文件。前置或验证失败时停下，报告步骤、路径、复现命令和实际结果，保留改动供核对。

现有 `CloudProject.send` 从两个 picker 读文件后直接上传。本轮在该入口增加文件拖放和确认清单。文件夹仍通过原 picker 选择并保留相对路径。已开始上传的取消、服务端、存储协议和真实 S3 验收沿用原范围。产品与 API 依据见 [WEB-02](../10-requirements/WEB-REQUIREMENTS.md#web-02-上传与续传)、[空间接口](../20-interfaces/WEB-INTERFACE.md#我的空间--web-02--web-03)、[上传与续传设计](WEB-DESIGN.md#上传与续传)。服务端继续按账号、项目、路径、摘要和实时额度受理。浏览器清单只是当前快照，确认前没有写请求。

## 执行前检查（作者或维护者）

核对任务分支、基线、工作区和 Node 22、锁定 pnpm 及本地 Chromium。运行 `git status --short --branch`、`git rev-parse --short HEAD` 和 `git check-ignore -- dev.env docs/30-designs/RUNBOOK-WEB-02-UPLOAD-INTAKE.md`。确认 4319/4320 可用于现有 Playwright mock。依赖缺失时使用仓库锁文件准备依赖，Chromium 使用仓库 Playwright 版本。真实配置和 Docker 无需参与。此检查不编号、不计入机械步骤。

## 机械步骤

### T1 · 采集、清单与确认

前置状态：执行前检查通过。

文件清单：4 个。只修改 `apps/workspace/web/src/space.tsx`，核对 `apps/workspace/web/src/space-api.ts` 的 `Space` 和 `transferFile`、`apps/workspace/api/space.ts` 的 `reserve`，专门回归 `apps/workspace/web/src/space-api.test.ts`。

禁止修改：上传传输函数、HTTP 契约、后端、已有取消及执行文件选择。

执行：

1. 在 `space.tsx` 的 `CloudProject` 增加文件来源和目录来源两组输入。行结构为 `{ path: string; file: File | null }`，null 只用于拖入的目录或无法读取项。文件 picker 替换文件组，目录 picker 替换目录组，文件 drop 替换文件组。两组可同时进入同一清单，先文件组后目录组。picker 立即拷贝 FileList，清空 input 以便重选，路径取 `webkitRelativePath || name`。空 picker 选择保留当前清单。
2. 在原上传区接收含 `Files` 的 dragover/drop 并阻止默认打开。同步读 file 类型的 `DataTransferItem`。用一次 `webkitGetAsEntry()` 区分目录和普通文件。普通文件取 `getAsFile()` 与 `file.name`，目录形成 null 行并提示「请用文件夹选择入口」。缺少 entry API、返回 null 或取文件失败时提示「无法读取拖入项，请使用选择入口」。不遍历目录。上传期间忽略文件 drop，禁用两个 picker 和确认按钮。
3. 在原上传区显示目标项目 `project.data.name`、逐行路径与字节、总字节和可用额度 `quota - saved - reserved`。在 `space.tsx` 内以小函数从选项和现有 `Space` 计算清单。顺序为不可读取、无效路径、单文件超限、清单内重复或文件/目录前缀冲突、与项目有效记录冲突、余额不足。路径规则照 `reserve`，分隔符为 `/`，拒绝空段、点段、反斜杠、控制字符、孤立 surrogate 及超过 1024 UTF-16 码元。冲突按路径相等或加 `/` 的前缀判断，重复或前缀冲突的可读合法候选双方拒收。既有同路径 `preparing/uploading/completing` 且大小相同可续传，使用原 ID 和预占。大小不同提示重选原文件，`saved/cleaning` 及其他有效记录的前缀冲突提示路径占用。已取消、过期或失败记录不占路径。按清单顺序从余额扣除新文件大小，放不下的行拒收，已预占的续传行不扣。拒收只影响本行。
4. 把原提交改为「确认上传」及「放弃本次选择」。放弃只清本地两组。无可提交行时确认禁用。确认将可提交行的文件、路径、已有续传 ID 和当前 Space 快照交给现有 mutation，按行依次调用原 `transferFile`。保留现有 sessionStorage 键和先记录 ID 再传输的顺序。缓存 ID 只有在快照已明确该 ID 终态时才换新，未确认失败保留原 ID。收到保存结果后尝试清缓存，缓存删除失败不改变已保存结果。逐行显示已保存或原上传错误提示；单行失败后继续下一行，异常为 Error 且 status 为 401 时停止余项并提示重新登录。批次完成后沿用 `refresh`，清除已提交选择并保留逐行结果，供用户重选未完成的原文件。重复确认在 mutation 进行时禁用。

验证：

```bash
pnpm --filter @bento/web typecheck
pnpm --filter @bento/web test src/space-api.test.ts
```

PASS：两条命令退出 0，原续传仍只发缺块请求。
STOP：需要扩大到传输函数、后端、取消或浏览器兼容层，或现有续传检查失败。

### T2 · 验证现有上传入口

前置状态：T1 PASS。

文件清单：4 个。新增 `apps/workspace/web/e2e/upload-intake.spec.ts`，核对 `apps/workspace/web/src/space.tsx` 与 `apps/workspace/web/playwright.config.ts`，临时新建和删除 fixture `root/nested.txt`。

禁止修改：生产逻辑与 mock 服务。

执行：用一个 Playwright 用例，复用现有 Chromium/Vite 配置，在 `page.route` 固定会话、项目、空间和上传接口。用模拟 drop 提供两个文件项和一个目录项。一个文件为项目已保存的同名路径，另一个为 0 字节的新文件。通过 entry fixture 明确区分文件与目录。断言项目名、清单、可用额度、同名冲突和目录 picker 提示。放弃时零写入，重拖后确认时只有新文件发送注册和完成，注册摘要为空且无需分块。同一用例先用 `mkdtemp` 建立 1 字节的 `root/nested.txt`，目录 picker 选 root，断言清单出现 `root/nested.txt` 后放弃，finally 删除该临时目录。

验证：

```bash
pnpm --filter @bento/web test:e2e upload-intake.spec.ts
git diff --check
```

PASS：退出 0，确认之前无写入，确认后两个拒收项均无写入，新文件保存。
STOP：任一断言不符，返回 T1 修复对应行为后重跑。真实 S3 和原生目录拖放不计入本轮验证。

### T3 · 同步已验证范围并收口

前置状态：T1 和 T2 PASS。

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

作者自检核对了 [RUNBOOK 规则](../00-governance/RUNBOOK-RULES.md)、[文档规则](../00-governance/DOCUMENT-RULES.md)、[平台架构](../00-governance/ARCHITECTURE.md)、现有页面及 API 入口。当前交付为最小实施计划。
