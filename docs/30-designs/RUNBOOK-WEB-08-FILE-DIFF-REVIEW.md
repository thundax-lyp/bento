# RUNBOOK · WEB-08 单轮文件变更审阅

- 状态：待实施，作者自审后可交叉审核。
- 建立日期：2026-11-12。当前 checkout 为 `codex/web-08-file-diff-review`，基线 `88979d0`。
- 目标：用户打开现有 Run，在「文件变更」看到新增、修改和删除的文件，点选查看该文件的原补丁块，也能切回完整原文并使用原下载链接。现有 `DiffPreview` 只渲染完整补丁。
- 范围以 [WEB-08](../10-requirements/WEB-REQUIREMENTS.md#web-08-结果审阅与交付) 的单轮文件审阅和 [WEB-06](../10-requirements/WEB-REQUIREMENTS.md#web-06-任务提交与结果) 的同源交付为准。检查结果、累计补丁、接口和共享 Docker 验收不在本轮。
- 从仓库根执行。作者或维护者前置检查通过后按步骤执行，每步 PASS 才继续。发现契约或文件不符，或命令失败，保留现场并报告最后通过步骤、文件、命令和脱敏结果。按原边界修复本轮故障，不调整断言。暂不提交或推送。

## 作者或维护者前置检查

此节不编号，也不计入机械步骤。核对任务分支、基线和干净工作树，确认本文件按现有规则忽略。Node 22、锁定 pnpm 和本地 Web 依赖可用。基线已有 Web 检查和 3 项 Chromium 通过的证据。缺依赖或起点不符时先交作者处理。此次无需配置、凭据、Docker 或浏览器进程。

```bash
git branch --show-current
git rev-parse --short HEAD
git status --short
git check-ignore -- docs/30-designs/RUNBOOK-WEB-08-FILE-DIFF-REVIEW.md
```

## 数据和显示规则

[现有 Web 接口](../20-interfaces/WEB-INTERFACE.md#任务与补丁--现有) 的 diff GET 返回 UTF-8 文本。Orchestrator 继续持有已发布的单轮补丁，`apps/workspace/web/src/api.ts` 的 `diffQuery` 按账号、项目、Run 读取字符串，`downloadUrl` 指向相同项目和 Run 的原附件。 `apps/workspace/web/src/pages.tsx` 的 `RunDetails` 继续按现有状态启用查询和显示下载。浏览器选择只存在于当前组件内存。无新增 DTO、请求、持久化、事件、幂等键或恢复逻辑。

新增纯函数 `splitFileDiff(text: string): FileChange[] | null`。 `FileChange = { path: string; status: 'added' | 'modified' | 'deleted'; text: string }`，三个字段必填，`text` 是原块，含其原换行。结果保持补丁顺序。零字节直接由现有 UI 显示无变更。非空补丁任何块识别失败返回 `null`，页面只显示完整原文及「无法按文件显示此补丁」。支持以下两种现有文本输入：

1. `apps/orchestrator/execution-service/diff.ts` 的 `unifiedDiff` 输出 Git 块。用行首 `diff --git ` 划分 Git 块。每块读取普通 `index` 和可选 `new file mode 100644` / `deleted file mode 100644`，随后识别一对文件头及 hunk。无 hunk 只支持空文件增删（模式行加空 blob 的 `e69de29` 前缀索引）。此时从 Git 块头读取路径。块头未加引号时按两侧等长定位分隔空格，核对旧侧 `a/` 与新侧 `b/` 后的路径相同。两侧均加引号时解析两个完整的 JSON 字符串 token，保留其中的 Unicode 和引号。常规块的路径也须与文件头一致。
2. `apps/workspace/api/mock.ts` 的 `patch` 和已有 Chromium fixture 使用简式统一 diff。按 `--- `、`+++ ` 和 hunk 顺序消费。hunk 头的旧、新 count 缺省为 1。正文空格扣两侧各一行，`-` 扣旧侧，`+` 扣新侧。精确的无末尾换行 marker 跟在正文行后，不扣计数。计数归零后才读取下一 hunk 或文件头。这也适用于 Git 块正文，避免把正文的 `--- ` 或 `+++ ` 误认为文件头。截断或未知结构整份回退。
3. 文件头先去标记及一个末尾 TAB，带双引号的路径用 `JSON.parse` 解码。旧侧读 `a/`，新侧读 `b/`。`/dev/null` 表示缺失侧。缺旧侧为新增，缺新侧为删除，两侧同路径为修改。两侧皆缺、路径不一致、空路径或重复路径均回退。路径不 trim、不正则化。重命名、复制、二进制、未知 Git 扩展或混合两种块的补丁回退。用 LF 查边界，按原字符串切块，保留 CR、空格、TAB 和换行。

## 机械步骤

### T1：实现文件列表和原文切换

前置状态：作者或维护者检查通过。

允许修改：`apps/workspace/web/tsconfig.json`、`apps/workspace/web/src/ui.tsx`、`apps/workspace/web/src/pages.tsx`、`apps/workspace/web/src/ui.test.tsx`。新增 `apps/workspace/web/src/file-diff.ts`。

文件清单（8）：以上五项，另专门核对 `apps/orchestrator/execution-service/diff.ts`、`apps/workspace/api/mock.ts`、`apps/workspace/web/src/api.ts`。

禁止修改：查询和下载接口、补丁生成器、mock、页面其他功能、依赖。

执行：

1. 在 Web tsconfig 的 `compilerOptions` 增加 `allowImportingTsExtensions: true`。新增仓库内导入使用显式扩展名。按上节实现 `splitFileDiff`，仅供 `DiffPreview` 使用。
2. 在 `DiffPreview` 对可识别补丁显示 `ul aria-label="变更文件"`。每文件一个按钮，名字为「新增/修改/删除」加空格和路径，另提供「完整补丁」按钮。选择用路径保存，初始或路径不在当前列表时展示完整补丁。点击文件后仅显示对应块，点击「完整补丁」回到完整原文。用 `aria-pressed` 标记选中项，复用现有 `pre aria-label="逐行变更"` 的文本渲染与高亮。未识别的非空补丁显示说明和完整原文，空补丁保留现有说明。React 仅渲染文本。
3. `RunDetails` 的现有 `DiffPreview` 调用加 `key={JSON.stringify([account, project, runId])}`，切换 Run 时重置选择。保留现有下载入口和状态分支。
4. 在现有 `ui.test.tsx` 保留零字节和 HTML 字面文本断言，增加一个聚焦用例。用与现有生成器形状相同的三块 fixture：修改 `edit.txt`（`-before`、`+after`）、删除 `gone.txt`（`-gone`）、新增 `new.txt`（`+new`）。断言三种按钮按补丁顺序、初始展示三块、逐个点选只显示所选块、点「完整补丁」恢复三块。将非空未知格式用于原有文本安全用例，断言无文件列表，正文仍可读。再用现有 mock 形状 `--- "a/edit.txt"\n+++ "b/edit.txt"\n@@ -1 +1 @@\n-before\n+after\n` 回归修改项可切换。

验证：

```bash
pnpm --filter @bento/web test src/ui.test.tsx
```

PASS：命令退出 0，上述断言通过。原附件链接和生成路径保持现有行为。

STOP：无法复用现有组件、fixture 与当前生成格式不符，或聚焦断言失败。只修本步允许文件，不引入 API 或依赖。

### T2：同步说明并收口

前置状态：T1 PASS。

允许修改：`docs/30-designs/WEB-DESIGN.md`、`docs/40-readiness/CURRENT-READINESS.md` 的 WEB-08 行，全部检查通过后删除本 RUNBOOK。

文件清单（9）：以上三个文件、T1 的五个改动文件和 `docs/10-requirements/WEB-REQUIREMENTS.md`（核对 WEB-08 原链接）。

禁止修改：其他需求、接口、部署、公开清单。

执行：

1. 在 [Web 设计](WEB-DESIGN.md#提交与交付) 更新 `DiffPreview` 组件标注和单轮预览行为。WEB-08 保持「部分实现」，写入实际的聚焦 fixture 证据，注明真实部署、多轮、累计补丁、检查结果未覆盖。沿用现有 WEB-08 链接。
2. 检查空白、范围和残留引用。新增或修改文件只允许 T1 五项及本步两个长期文档。残留引用搜索只查本次可新增引用的七个改动文件。退出 1 且无输出才表示无引用。全部 PASS 后删除本 RUNBOOK，再确认路径不存在。

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

作者自审覆盖文件清单、现有生产入口、固定命令、相对链接和 Git 空白检查。本轮仅修订计划。
