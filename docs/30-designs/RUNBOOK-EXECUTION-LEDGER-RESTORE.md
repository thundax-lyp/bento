# 单节点业务执行账本备份还原演练

状态：草稿，待独立审核。建立日期：2026-11-13（Asia/Shanghai）。工作区：`/Volumes/storage/workspace/bento-b`。基线：`656fdc26cddd1cf1db9c9056230fd2d9599fe517`。审核通过后使用 `codex/execution-ledger-restore`。

## 执行者契约

当前只允许调查、起草及作者校验。收到 MASTER 对当前草稿 Git blob 的 `Executable` 审核结论后，按 T0 建立执行分支并单独提交该 RUNBOOK。收到同一审核提交的 WORKER 执行派发后，依序执行 T1、T2。每步全部命令、断言和文件清单符合要求才 PASS，随步骤产物提交 RUNBOOK 中该步的删除。发生 STOP 时保留当前步骤和用户文件，报告最后通过的步骤及提交、相关 symbol、复现命令、脱敏结果、继续所需决定。Git 提交失败保留当步待提交内容并按 WORKER 规则重试。

任务命令从仓库根目录以 Bash 逐条运行，遇到不符合 PASS 的结果立即停止。运行管道命令前设置 `set -o pipefail`。仅使用当前 checkout 的已装依赖、系统临时目录和测试进程的动态回环端口。禁止 Docker、远端运行环境、共享栈、A 的账号或 S3、`debug-workspace`、真实执行数据、项目配置和私有环境文件。PR 交付阶段的 GitHub 操作遵循单独派发的授权和 [PR Rules](../00-governance/PR-RULES.md)。

## 目标与断点

[需求 A7、A8](../10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md#执行链验收门槛)要求单节点备份还原演练及可重复证据。[实施设计](APPLICATION-BOUNDARIES-DESIGN.md#执行链实施设计)包含单执行宿主备份还原，[架构的当前接线](../00-governance/ARCHITECTURE.md#当前实现接线)区分实际 TS 执行账本与目标 Go Orchestrator。现有 [部署手册](../../deploy/README.md#启动与检查)只说明保留命名卷以重启。现有 `service.test.ts` 的 `private HTTP, three-account FIFO, next generation and immutable diff across restart` 复用原状态目录。缺口是从独立备份在全新位置恢复后，以正常业务入口读取并重放已完成 Run。

交付链路为本地合成项目 → 真实执行服务生成已完成 Run → 优雅停服 → SQLite backup API 生成独立文件 → 核对完整性与 SHA-256 → 仅将该文件复制到全新状态目录 → 同一服务入口读取项目、Run、diff、幂等重放 → 清理 → 部署手册与 Readiness。

范围仅包括当前 Compose Orchestrator 的 `business.sqlite` 和其中已结束 Run 的证据。未覆盖 `authority.sqlite`、`history.sqlite`、控制器锁的恢复、其他数据卷、OpenShell Workspace、MySQL、Keycloak/PostgreSQL、Temporal 历史、S3、运行中 Run 的接管、生产备份编排、生产灾难恢复、回滚、RPO/RTO 和多节点。各步骤均不修改产品实现、协议、Schema、镜像或 CI。

## 依据与不变量

- [Compose](../../deploy/compose.yaml) 的 `orchestrator` 将 `bento-execution-data` 挂载至 `/data`，以 `BENTO_STATE_DIR=/data` 调用 [start.ts](../../apps/orchestrator/execution-service/start.ts)。其入口调用 [service.ts](../../apps/orchestrator/execution-service/service.ts) 的 `serveExecution`，后者获得控制器锁，打开 `Store(join(dir, 'business.sqlite'))` 并绑定 `executionHttp`。演练复用 `serveExecution` 的正常启动、扫描和 HTTP 路径，由既有测试 `start(state, host)` 提供本地适配器及动态端口。
- [store.ts](../../apps/orchestrator/execution-service/store.ts) 的 `Store` 使用 WAL、FULL 和外键。备份源在 `serveExecution.close()` 完成后以只读 SQLite 打开，通过 `node:sqlite` 的 `backup` 生成一致的单库文件，禁止复制活跃的主库或从原状态目录带入 WAL/SHM、其他数据库和本地卷。完整性检查独立只读打开备份。摘要只比对备份与启动前还原副本，服务重开后可能写入 SQLite 元数据。
- `projects` 中 `id,owner,name,status,createdAt,sessionId,sandbox,volume` 均为必填 TEXT，`source` 为可空 TEXT。HTTP 项目创建接受 `name: string` 和 `files: {path: string; text: string}[]`，owner 来自经 bearer 验证的 `x-bento-owner-id`。服务生成项目/Session UUID、沙盒/卷标识与 ISO 时间。项目 GET 投影 `id,name,status,createdAt`。
- `runs` 中 `id,projectId,sessionId,key,prompt,status,createdAt,updatedAt` 为必填 TEXT，`summary,baseline,diff` 为可空 TEXT，`receipt,reconciled,cancelWorkerClosed` 为 INTEGER 默认 0，`cancelGeneration` 为可空 INTEGER。`Store.addRun` 在 `BEGIN IMMEDIATE` 中按 `(projectId,key)` 查找及入队。调用方提供 `Idempotency-Key` 和 `prompt: string`， [runInput](../../apps/orchestrator/execution-service/input.ts) 对 prompt 做 trim，直接与落库 prompt 比较，无请求哈希。服务生成 Run UUID 和 ISO 时间。worker 完成后 `Store.received` 写 `receipt=1`，`serveExecution.finish` 通过 `Store.status` 保存 diff 并标记 `succeeded`。
- [http.ts](../../apps/orchestrator/execution-service/http.ts) 的 `executionHttp` 对新提交返回 202，同键同输入返回 200 和当下的 `runView`，同键异输入返回 409 和 `error.code=idempotency_conflict`。幂等回执是原 Run 的投影。其字段为 `id,projectId,sessionId,status,createdAt,updatedAt` 和非空时的 `summary`。详情 GET 额外给出 `prompt`。列表 GET 返回 `{runs: runView[]}`，diff GET 返回纯文本，错误 owner 的详情 GET 返回 404。数据库 `receipt` 与 HTTP 重放回执分别断言。新增事件、outbox、Archive、Schema 和权限规则均不适用。
- 仅合成 fixture 允许备份与启动。备份、源、还原目录互为不同位置，由同一个权限受限的 `mkdtemp` 创建。还原文件独占创建，启动前验证内容，启动还原实例后仅读取或重放原请求。任何失败关闭 SQLite 连接和服务，清除本次临时目录。测试只有全部断言和清理成功才打印摘要。

## 机械步骤

### T0：核对基线、运行环境与审核交接

前置状态：调查阶段在指定 checkout 的 `main` 上。基线、草稿和当前任务授权可读。

允许修改：`docs/30-designs/RUNBOOK-EXECUTION-LEDGER-RESTORE.md`。专门核对 `apps/orchestrator/execution-service/service.test.ts`。允许的既有忽略草稿为 `RUNBOOK-ADMIN-AUTH-BUILD.md`、`RUNBOOK-WEB-A03-REAL-STORAGE.md`。

禁止修改：两个既有草稿及所有实现文件；独立审核前禁止暂存、提交、建分支。

执行：

1. 执行下面的验证。作者记录实际命令结果。校验本草稿相对链接和 Markdown 格式。
2. 记录 `git hash-object docs/30-designs/RUNBOOK-EXECUTION-LEDGER-RESTORE.md`。收到该 blob 的 `Executable` 后复核基线、工作区及 blob；执行 `git switch -c codex/execution-ledger-restore`，用 `git add -f -- docs/30-designs/RUNBOOK-EXECUTION-LEDGER-RESTORE.md` 仅暂存该临时文件。核对 `git diff --cached --name-only` 只有该路径且 `git diff --cached --check` 退出 0。提交 `Docs(execution-service): 固定账本备份还原演练步骤`，用 `git show --format= --name-only HEAD` 核对只有该路径，用 `git rev-parse HEAD:docs/30-designs/RUNBOOK-EXECUTION-LEDGER-RESTORE.md` 核对 blob 未变。此提交保留 T0 作为审核交接记录，T1 PASS 时删除。

验证：

```bash
test "$(pwd -P)" = /Volumes/storage/workspace/bento-b
test "$(git branch --show-current)" = main
test "$(git rev-parse HEAD)" = 656fdc26cddd1cf1db9c9056230fd2d9599fe517
test -z "$(git status --porcelain=v1 --untracked-files=all)"
git diff --check
node -e 'const a=require("node:assert/strict"); a.equal(process.versions.node.split(".")[0],"22"); a.equal(typeof require("node:sqlite").backup,"function")'
test "$(pnpm --version)" = 12.15.0
pnpm --filter @bento/orchestrator test
pnpm exec prettier --check docs/30-designs/RUNBOOK-EXECUTION-LEDGER-RESTORE.md
```

PASS：退出码均为 0，Orchestrator 基线 27 个测试通过、零失败及跳过。起草完成与审核通过分别记录；分支和提交动作须等同一 blob 获审。

STOP：基线或授权改变、依赖/SQLite 能力缺失、规定测试失败、审批版本不匹配或已存在同名分支。报告失败证据并保留工作区。

### T1：交付已完成 Run 的账本备份还原演练

前置状态：分支名为 `codex/execution-ledger-restore`，HEAD 为审核确认的 RUNBOOK 提交，工作区无其他待提交修改，收到执行派发。

允许修改：`apps/orchestrator/execution-service/service.test.ts`、`deploy/README.md`、本 RUNBOOK（3 个）。专门核对 `public-files.json` 的 TypeScript glob 与部署手册条目，以及 `package.json` 的 npm 包文件范围（合计 5 个）。

禁止修改：产品 TypeScript、Go、发布清单、镜像、Compose、依赖和其他测试。

执行：

1. 在 `service.test.ts` 现有 Node import 中增加 `createHash`、`constants`、`copyFile`、`mkdir` 和 `backup`，分别复用现有 crypto、fs、fs/promises 和 sqlite 导入行。将以下测试完整插入 `a completed Run retries capture after restart without rerunning its worker` 测试之前，同属现有测试执行分支。复用文件内 `start`、`client`、`project`、`until`、`localHost`。

```ts
test('restores the completed Run business ledger from an isolated backup', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'bento-ledger-restore-'));
    const original = join(root, 'source');
    const restored = join(root, 'restore');
    const source = join(original, 'business.sqlite');
    const archive = join(root, 'backup.sqlite');
    const target = join(restored, 'business.sqlite');
    const prompt = 'ledger restore fixture';
    const key = 'ledger-restore-key';
    let service: Awaited<ReturnType<typeof start>> | undefined;
    let restoreCalls = 0;
    let digest: string;
    try {
        service = await start(original, localHost(join(original, 'volume')));
        const api = client(service.url);
        const projectPath = await project(api);
        const projectView = await api(projectPath);
        assert.equal(projectView.status, 200);
        assert.equal(projectView.json().status, 'ready');
        const runsPath = projectPath + '/runs';
        const accepted = await api(runsPath, 'POST', { prompt }, key);
        assert.equal(accepted.status, 202);
        const runId = accepted.json().id;
        assert(runId);
        assert(accepted.json().sessionId);
        const runPath = runsPath + '/' + runId;
        const before = await until(
            () => api(runPath),
            (r) => r.json().status === 'succeeded',
            'ledger fixture Run succeeded',
        );
        assert.equal(before.status, 200);
        assert.equal(before.json().sessionId, accepted.json().sessionId);
        const diff = await api(runPath + '/diff');
        assert.equal(diff.status, 200);
        assert.match(diff.text, /\+ledger restore fixture/);
        const replay = await api(runsPath, 'POST', { prompt }, key);
        assert.equal(replay.status, 200);
        assert.equal(replay.json().id, runId);
        assert.equal(replay.json().status, 'succeeded');

        await service.close();
        service = undefined;
        const sourceDb = new DatabaseSync(source, { readOnly: true });
        try {
            await backup(sourceDb, archive);
        } finally {
            sourceDb.close();
        }
        const archiveDb = new DatabaseSync(archive, { readOnly: true });
        try {
            assert.equal(
                archiveDb.prepare('PRAGMA integrity_check').get()?.integrity_check,
                'ok',
            );
            assert.deepEqual(archiveDb.prepare('PRAGMA foreign_key_check').all(), []);
            const row = archiveDb
                .prepare('SELECT status, receipt, key, prompt, sessionId, diff FROM runs WHERE id = ?')
                .get(runId);
            assert(row);
            assert.deepEqual({ ...row }, {
                status: 'succeeded',
                receipt: 1,
                key,
                prompt,
                sessionId: accepted.json().sessionId,
                diff: diff.text,
            });
        } finally {
            archiveDb.close();
        }

        await mkdir(restored, { mode: 0o700 });
        await copyFile(archive, target, constants.COPYFILE_EXCL);
        const sha256 = async (path: string) =>
            createHash('sha256').update(await readFile(path)).digest('hex');
        digest = await sha256(archive);
        assert.equal(await sha256(target), digest);

        const fixture = localHost(join(restored, 'volume'));
        const unexpected = async (): Promise<never> => {
            restoreCalls++;
            throw new Error('Terminal ledger restore must not touch the fixture host');
        };
        service = await start(restored, {
            ...fixture,
            provision: unexpected,
            snapshot: unexpected,
            start: unexpected,
            stop: unexpected,
            running: unexpected,
            stopped: unexpected,
            worker: unexpected,
        });
        const restoredApi = client(service.url);
        const restoredProject = await restoredApi(projectPath);
        assert.equal(restoredProject.status, 200);
        assert.deepEqual(restoredProject.json(), projectView.json());
        const restoredRun = await restoredApi(runPath);
        assert.equal(restoredRun.status, 200);
        assert.deepEqual(restoredRun.json(), before.json());
        const restoredDiff = await restoredApi(runPath + '/diff');
        assert.equal(restoredDiff.status, 200);
        assert.equal(restoredDiff.text, diff.text);
        assert.equal(
            (await client(service.url, 'account-b')(runPath)).status,
            404,
        );
        const restoredReplay = await restoredApi(runsPath, 'POST', { prompt }, key);
        assert.equal(restoredReplay.status, 200);
        assert.deepEqual(restoredReplay.json(), replay.json());
        const conflict = await restoredApi(
            runsPath,
            'POST',
            { prompt: 'different fixture input' },
            key,
        );
        assert.equal(conflict.status, 409);
        assert.equal(JSON.parse(conflict.text).error.code, 'idempotency_conflict');
        const list = await restoredApi(runsPath);
        assert.equal(list.status, 200);
        assert.deepEqual(JSON.parse(list.text), { runs: [replay.json()] });

        await service.close();
        service = undefined;
        assert.equal(restoreCalls, 0);
        assert.equal(await sha256(archive), digest);
    } finally {
        try {
            await service?.close();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }
    t.diagnostic('business.sqlite SHA-256 ' + digest);
});
```

2. 在 `deploy/README.md` 的「启动与检查」后、OpenShell 段前插入以下正文。命令、成功判据、失败处理和边界随该测试一起提交。

> ## 单节点业务执行账本备份还原演练
>
> 从仓库根目录使用已安装锁定依赖的 Node.js 22 和 pnpm 12.15.0。确认当前 Node 22 提供 `node:sqlite.backup`。命令使用测试进程的动态回环端口和私有临时目录。
>
> ```bash
> node --import ./register-paths.mjs --experimental-strip-types --test --test-name-pattern='^restores the completed Run business ledger from an isolated backup$' apps/orchestrator/execution-service/service.test.ts
> ```
>
> 演练生成合成项目及成功 Run，等执行服务关闭后，以 SQLite backup API 读取 `business.sqlite` 并生成单库备份。备份通过完整性、外键和已提交回执检查，才复制到一个全新目录。启动前核对备份与还原文件的 SHA-256，再用同一个执行服务入口启动还原实例。SQLite 使用 WAL，运行中直接复制主库文件可能遗漏已提交事务。其他数据库、WAL/SHM、锁文件和本地 fixture 卷均不随该备份复制。
>
> PASS 时只通过一个匹配测试，报告备份 SHA-256。项目、Run、diff、同键同输入的原 Run 回执均一致，同键异输入返回冲突，其他 owner 读不到该 Run，列表只有原 Run，且没有调用还原侧 fixture 的执行入口。摘要来自合成数据，每次运行可变化。命令失败时使用测试输出定位失败断言，测试会关闭服务并清理本次临时目录。修复前置条件后重新执行，下一次使用全新目录。测试进程被强杀后，先核实进程已退出，再清理仅属于该次运行的 `bento-ledger-restore-*` 临时目录。
>
> Compose 当前的 TS 执行服务持有该业务账本。演练覆盖其中已结束 Run 的读取和幂等重放。生产恢复还需单独验证授权账本、会话历史、外部 Workspace、Temporal、账号与身份数据、S3 及部署级回滚。演练产物只用于本地校验，禁止覆盖已运行或曾运行的状态目录。

3. 仅对两个交付文件运行 Prettier 写入，运行验证。PASS 后从 RUNBOOK 删除 T0、T1 段，并保留 T2 和上方范围。核对暂存 diff 及 README 新命令指向的测试路径。提交三个路径，标题为 `Test(execution-service): 演练单节点业务账本备份还原`。回读提交 SHA 和文件清单。

验证：

```bash
pnpm exec prettier --write apps/orchestrator/execution-service/service.test.ts deploy/README.md
node --import ./register-paths.mjs --experimental-strip-types --test --test-name-pattern='^restores the completed Run business ledger from an isolated backup$' apps/orchestrator/execution-service/service.test.ts
pnpm --filter @bento/orchestrator test
npm pack --dry-run --json | node -e 'const f=JSON.parse(require("node:fs").readFileSync(0,"utf8"))[0].files.map(x=>x.path); const a=require("node:assert/strict"); a(f.includes("deploy/README.md")); a(f.includes("apps/orchestrator/execution-service/service.test.ts")); a(!f.includes("docs/30-designs/RUNBOOK-EXECUTION-LEDGER-RESTORE.md"))'
git diff --check
```

PASS：focused 测试 1/1，输出 64 位小写十六进制摘要，全部 HTTP、SQLite 和清理断言通过；Orchestrator TS 测试 28/28，无失败及跳过；npm 清单命中两份既有发布文件且排除临时 RUNBOOK；diff 检查成功。

STOP：缺任何输出、断言失败、依赖变化、需要外部资源或预计文件范围变化。测试失败不保留数据库、fixture 卷或回环服务。提交失败保留本步文件与证据。

### T2：登记 Readiness 并收口

前置状态：T1 已提交，提交中有两份交付文件，当前 RUNBOOK 只剩 T2。T1 PASS 证据记录了实际 Node 版本、命令、SHA-256 及通过数。

允许修改：`docs/40-readiness/CURRENT-READINESS.md` 与本 RUNBOOK。专门核对 `deploy/README.md` 的新小节、`apps/orchestrator/execution-service/service.test.ts` 的测试名和 `public-files.json` 中两份文档的条目（合计 5 个）。

禁止修改：A8 状态、其他验收项、永久手册与产品行为。测试范围不得扩大到外部服务。

执行：

1. 仅替换应用与编排表中 A7 行的说明列，保留「部分实现」。写入本次实际验证日期（Asia/Shanghai）、T1 的完整提交 SHA、Node 版本以及如下证据：`business.sqlite` 合成项目及终态 Run 在停服后备份，新隔离目录还原，正常 HTTP 读取、diff、同键同输入回执一致，异输入冲突，零重复 Run。链接 `../../deploy/README.md#单节点业务执行账本备份还原演练` 作为命令入口。列明未覆盖授权账本、会话历史、Workspace 卷、其他部署数据库和存储、Temporal、生产恢复、部署回滚及 RPO/RTO。A8 的可重复证据由 A7 的链接和版本提供，A8 整体门槛继续按原行记录。
2. 删除本 RUNBOOK。仅格式化 Readiness。核对没有跟踪文件引用被删除的 RUNBOOK。执行下面的验证，核对实际输出后暂存仅 Readiness 和 RUNBOOK 删除，提交 `Docs(execution-service): 记录单节点账本还原证据`。回读 SHA、文件清单及 `git status`，随后按 WORKER 派发与仓库 PR 规则交付。

验证：

```bash
pnpm exec prettier --write docs/40-readiness/CURRENT-READINESS.md
test ! -e docs/30-designs/RUNBOOK-EXECUTION-LEDGER-RESTORE.md
git grep -nF 'RUNBOOK-EXECUTION-LEDGER-RESTORE.md'
rg -n '^## 单节点业务执行账本备份还原演练$' deploy/README.md
rg -n 'deploy/README\.md#单节点业务执行账本备份还原演练' docs/40-readiness/CURRENT-READINESS.md
git diff --check
pnpm check
```

PASS：`git grep` 退出 1 且无输出，其余命令退出 0。完整检查覆盖现有 TS、Go、lint 和格式入口。复核 A7 仍为「部分实现」，且 A8 行和其他验收行的内容一致。Readiness 链接锚点在部署文档中存在。全产品浏览器 E2E 及真实外部运行不属本地演练验证；实际远端必需检查按 PR 门禁执行。

STOP：存在残留引用、实际证据不足、任何检查失败或需要改动文件范围之外的内容。失败时先还原本步骤删除的 RUNBOOK（仅从 T1 提交恢复该文件），保留 Readiness 草稿和失败证据，留在 T2。
