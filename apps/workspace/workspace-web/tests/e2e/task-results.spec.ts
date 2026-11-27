import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

test('Task routes retain idempotency, history, and versioned results across browsers', async ({
    page,
    context,
    browser,
    baseURL,
}) => {
    type TaskFixture = import('@workspace-web/api.ts').Task;
    type RunFixture = import('@workspace-web/api.ts').TaskRun;
    type EventFixture = import('@workspace-web/api.ts').TaskEvent;
    const createdAt = new Date().toISOString();
    const sourceId = randomUUID();
    const fileId = randomUUID();
    const digest = 'a'.repeat(64);
    const tasks = new Map<string, TaskFixture>();
    const runs = new Map<string, RunFixture[]>();
    const events = new Map<string, EventFixture[]>();
    const receipts = new Map<string, TaskFixture>();
    const createKeys: string[] = [];
    const eventCursors: number[] = [];
    let lostReceipt = true;
    const taskRoute = async (route: import('@playwright/test').Route) => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();
        const path = url.pathname;
        const send = (json: unknown, status = 200) =>
            route.fulfill({ status, json });
        if (path === '/api/session') return send({ account: 'task-fixture' });
        if (path === '/api/projects') return send({ projects: [] });
        if (path === '/api/space')
            return send({
                projects: [{ id: sourceId, name: '资料项目' }],
                uploads: [
                    {
                        id: fileId,
                        project: sourceId,
                        path: '原始.txt',
                        size: 3,
                        state: 'saved',
                    },
                ],
                quota: 1024,
                fileLimit: 1024,
                partSize: 1024,
                saved: 3,
                reserved: 0,
            });
        if (path === '/api/space/projects/' + sourceId)
            return send({
                name: '资料项目',
                files: [{ id: fileId, path: '原始.txt', size: 3 }],
                execution: { state: 'uninitialized' },
            });
        if (path === '/api/tasks' && method === 'GET')
            return send({ items: [...tasks.values()] });
        if (path === '/api/tasks' && method === 'POST') {
            const { name, source } = request.postDataJSON();
            const key = request.headers()['idempotency-key']!;
            createKeys.push(key);
            const previous = receipts.get(key);
            if (previous) return send({ task: previous });
            const snapshot = source.kind === 'space_snapshot';
            if (snapshot) expect(source.fileIds).toEqual([fileId]);
            const task: TaskFixture = {
                id: randomUUID(),
                name,
                sourceSpaceId: snapshot ? source.spaceId : null,
                inputDigest: digest,
                environmentVersion: 'sha256:' + digest,
                status: snapshot ? 'failed' : 'ready',
                prepareError: snapshot ? 'preparation_failed' : null,
                closedReason: null,
                reconciliation: null,
                createdAt,
                updatedAt: createdAt,
                inputs: snapshot
                    ? [{ fileId, path: '原始.txt', bytes: 3, sha256: digest }]
                    : [],
            };
            tasks.set(task.id, task);
            receipts.set(key, task);
            runs.set(task.id, []);
            events.set(task.id, []);
            if (!snapshot && lostReceipt) {
                lostReceipt = false;
                return send(
                    {
                        error: {
                            code: 'backend_error',
                            message: '回执暂不可用',
                        },
                    },
                    502,
                );
            }
            return send({ task }, 202);
        }
        const match = /^\/api\/tasks\/([^/]+)(?:\/(.*))?$/.exec(path);
        if (!match || !tasks.has(match[1]!)) return route.fallback();
        const task = tasks.get(match[1]!)!;
        const rows = runs.get(task.id)!;
        const history = events.get(task.id)!;
        const tail = match[2];
        if (!tail) return send({ task });
        if (tail === 'prepare') {
            task.status = 'ready';
            task.prepareError = null;
            return send({ task });
        }
        if (tail === 'events') {
            eventCursors.push(Number(url.searchParams.get('after')));
            return send({ items: history });
        }
        function appendRun(prompt: string, retryOf: string | null = null) {
            const failed = !retryOf && prompt === '失败样例';
            const unknown = prompt === '未知样例';
            const run: RunFixture = {
                id: randomUUID(),
                taskId: task.id,
                sequence: rows.length + 1,
                prompt,
                status: unknown
                    ? 'needs_review'
                    : failed
                      ? 'failed'
                      : 'succeeded',
                retryOf,
                canContinue: !failed && !unknown,
                canCancel: false,
                retryReason: unknown
                    ? 'needs_review'
                    : failed
                      ? null
                      : 'not_terminal',
                resultVersion: unknown || failed ? null : 1,
                summary: unknown
                    ? '需要可信侧核对。'
                    : failed
                      ? '执行发生明确错误。'
                      : '本轮已完成',
                createdAt,
                updatedAt: createdAt,
            };
            rows.push(run);
            if (!retryOf) {
                history.push({
                    id: run.id + ':user',
                    sequence: history.length + 1,
                    runId: run.id,
                    at: createdAt,
                    kind: 'user_message',
                    text: prompt,
                    check: null,
                });
            }
            return run;
        }
        if (tail === 'runs')
            return method === 'GET'
                ? send({ items: rows })
                : send({ run: appendRun(request.postDataJSON().prompt) }, 202);
        const [, runId, action] = tail.split('/');
        const run = rows.find((item) => item.id === runId)!;
        if (action === 'retry') {
            expect(run.retryReason).toBeNull();
            const next = appendRun(run.prompt, run.id);
            return send(
                {
                    retry: {
                        id: randomUUID(),
                        runId: next.id,
                        state: 'queued',
                    },
                },
                202,
            );
        }
        if (tail.endsWith('/results'))
            return send({
                result: {
                    runId,
                    version: 1,
                    summary: '本轮已完成',
                    checks: [
                        { name: '格式检查', status: 'passed', output: 'ok' },
                    ],
                    incrementalSha256: digest,
                    cumulativeSha256: digest,
                    createdAt,
                },
            });
        if (tail.endsWith('/diff')) {
            const view = url.searchParams.get('view');
            const body = `--- a/readme.txt\n+++ b/readme.txt\n@@ -0,0 +1 @@\n+第${run.sequence}轮${view === 'cumulative' ? '累计' : '增量'}\n`;
            return route.fulfill({
                status: 200,
                body,
                contentType: 'text/plain',
                ...(url.searchParams.has('download')
                    ? {
                          headers: {
                              'content-disposition':
                                  'attachment; filename="changes.patch"',
                          },
                      }
                    : {}),
            });
        }
        return send({ run });
    };
    await context.route('**/api/**', taskRoute);
    await page.goto('/');
    await page.getByLabel('任务名称').fill('空白工作');
    await page.getByRole('button', { name: '创建空白任务' }).click();
    await expect(page.getByText('回执暂不可用')).toBeVisible();
    await page.getByRole('button', { name: '创建空白任务' }).click();
    await expect(page.getByRole('heading', { name: '空白工作' })).toBeVisible();
    expect(createKeys[0]).toBe(createKeys[1]);
    expect(tasks.size).toBe(1);
    const task = [...tasks.values()][0]!;
    const detail = '/tasks/' + task.id;

    await page.getByLabel('任务要求').fill('第一轮要求');
    await page.getByRole('button', { name: '发送要求' }).click();
    await expect(page.getByText('第1轮累计')).toBeVisible();
    const firstUrl = page.url();
    await expect(page.getByRole('link', { name: '下载 diff' })).toHaveAttribute(
        'href',
        /\/results\/1\/diff\?view=cumulative&download=1$/,
    );

    if (!baseURL) throw new Error('Missing Playwright base URL');
    const other = await browser.newContext({ baseURL });
    try {
        await other.route('**/api/**', taskRoute);
        const secondPage = await other.newPage();
        await secondPage.goto(detail);
        await expect(secondPage.getByText('第一轮要求')).toHaveCount(1);
        await other.setOffline(true);
        await expect(
            secondPage.getByText('连接中断，正在等待重新连接。'),
        ).toBeVisible();
        await page.getByLabel('后续要求').fill('第二轮要求');
        await page.getByRole('button', { name: '发送要求' }).click();
        await expect(page.getByText('第2轮累计')).toBeVisible();
        await page.getByLabel('补丁范围').selectOption('incremental');
        await expect(page.getByText('第2轮增量')).toBeVisible();
        await other.setOffline(false);
        await expect(secondPage.getByText('第二轮要求')).toHaveCount(1);
        await expect(secondPage.getByText('第一轮要求')).toHaveCount(1);
        expect(eventCursors.some((cursor) => cursor > 0)).toBe(true);
    } finally {
        await other.close();
    }
    await page.goto(firstUrl);
    await expect(page.getByText('第1轮累计')).toBeVisible();
    const downloading = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载 diff' }).click();
    const download = await downloading;
    expect(await readFile((await download.path())!, 'utf8')).toContain(
        '+第1轮累计',
    );

    await page.getByLabel('后续要求').fill('失败样例');
    await page.getByRole('button', { name: '发送要求' }).click();
    await page.getByRole('button', { name: '安全重试' }).click();
    await expect(
        page.getByText('重试将丢弃本轮未完成的工作区变更，并保留原执行记录。'),
    ).toBeVisible();
    await page.getByRole('button', { name: '确认重试' }).click();
    await expect(page.getByText('第4轮累计')).toBeVisible();
    await page.getByLabel('后续要求').fill('未知样例');
    await page.getByRole('button', { name: '发送要求' }).click();
    await expect(page.getByLabel('后续要求')).toBeDisabled();
    await expect(page.getByRole('button', { name: '安全重试' })).toHaveCount(0);
    await expect(
        page.getByText('上一次操作结果未确认。').first(),
    ).toBeVisible();

    task.reconciliation = {
        attemptId: randomUUID(),
        state: 'blocked',
        reason: 'restore_conflict',
    };
    await expect(
        page.getByText('恢复证据不一致，等待可信侧核对。'),
    ).toBeVisible();
    await expect(page.getByLabel('后续要求')).toBeDisabled();

    await page.goto('/space/' + sourceId);
    await page.getByLabel('原始.txt').check();
    await page.getByRole('button', { name: '从所选文件新建任务' }).click();
    await expect(page.getByRole('heading', { name: '资料项目' })).toBeVisible();
    await expect(page).toHaveURL(/\/tasks\/[^/?]+$/);
    const snapshot = new URL(page.url()).origin + new URL(page.url()).pathname;
    const reopened = await context.newPage();
    await reopened.goto(snapshot);
    const createAnother = reopened.getByRole('button', {
        name: '更换输入或环境，另建任务',
    });
    const confirmAnother = reopened.getByRole('link', { name: '确认另建' });
    await createAnother.click();
    await expect(
        reopened.getByText(
            '另建任务将使用重新选择的输入和当前运行环境，原任务及失败记录会保留。',
        ),
    ).toBeVisible();
    await expect(confirmAnother).toBeVisible();
    await reopened.getByRole('button', { name: '返回', exact: true }).click();
    await expect(confirmAnother).toBeHidden();
    await expect(reopened).toHaveURL(snapshot);
    await expect(reopened.getByText('任务准备失败。')).toBeVisible();
    expect(tasks.size).toBe(2);
    await createAnother.click();
    await expect(confirmAnother).toHaveAttribute('href', '/space/' + sourceId);
    await reopened.getByRole('button', { name: '按原输入重新准备' }).click();
    await expect(reopened.getByLabel('任务要求')).toBeEnabled();
    expect(reopened.url()).toBe(snapshot);
    expect(tasks.size).toBe(2);
});

test('Task terminal result states distinguish empty patches, failures and four check labels', async ({
    page,
    context,
}) => {
    const taskId = randomUUID();
    const at = new Date().toISOString();
    const runs: import('@workspace-web/api.ts').TaskRun[] = [
        'succeeded',
        'succeeded',
        'failed',
        'running',
    ].map((status, index) => ({
        id: randomUUID(),
        taskId,
        sequence: index + 1,
        prompt: '终态样例' + index,
        status: status as import('@workspace-web/api.ts').TaskRun['status'],
        retryOf: null,
        canContinue: false,
        canCancel: false,
        retryReason: 'stop_unconfirmed',
        resultVersion: index < 2 ? 1 : null,
        summary: index === 2 ? 'Run stopped before completion.' : null,
        createdAt: at,
        updatedAt: at,
    }));
    const checks: import('@workspace-web/api.ts').TaskCheck[] = [
        { name: '匹配', status: 'passed', output: '安全通过摘要' },
        { name: '不匹配', status: 'failed', output: '安全失败摘要' },
        { name: '跳过', status: 'not_run', output: null },
        { name: '读取失败', status: 'unavailable', output: '安全不可用摘要' },
    ];
    const patch = '--- a/file.txt\n+++ b/file.txt\n@@ -0,0 +1 @@\n+公开内容\n';
    const requested: string[] = [];
    await context.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        const path = url.pathname;
        const send = (json: unknown) => route.fulfill({ json });
        if (path === '/api/session')
            return send({ account: 'terminal-fixture' });
        if (path === '/api/tasks/' + taskId)
            return send({
                task: {
                    id: taskId,
                    name: '终态查询',
                    sourceSpaceId: null,
                    inputDigest: 'a'.repeat(64),
                    environmentVersion: 'sha256:' + 'b'.repeat(64),
                    status: 'ready',
                    prepareError: null,
                    closedReason: null,
                    reconciliation: null,
                    inputs: [],
                    createdAt: at,
                    updatedAt: at,
                },
            });
        if (path.endsWith('/events')) return send({ items: [] });
        if (path.endsWith('/runs')) return send({ items: runs });
        const run = runs.find((item) => path.includes(item.id));
        if (!run) return route.fulfill({ status: 404, json: {} });
        if (path.endsWith('/results'))
            return send({
                result: {
                    runId: run.id,
                    version: 1,
                    summary: '公开结论',
                    checks,
                    incrementalSha256: 'a'.repeat(64),
                    cumulativeSha256: 'a'.repeat(64),
                    createdAt: at,
                },
            });
        if (path.endsWith('/diff')) {
            expect(run.resultVersion).toBe(1);
            expect(path).toContain('/results/1/diff');
            requested.push(run.id + ':' + url.searchParams.get('view'));
            return route.fulfill({
                contentType: 'text/plain',
                body: run.id === runs[0]!.id ? patch : '',
                ...(url.searchParams.has('download')
                    ? {
                          headers: {
                              'content-disposition':
                                  'attachment; filename="changes.patch"',
                          },
                      }
                    : {}),
            });
        }
        return send({ run });
    });
    await page.goto('/tasks/' + taskId + '?run=' + runs[0]!.id);
    const download = page.getByRole('link', { name: '下载 diff' });
    for (const [index, run] of runs.entries()) {
        if (index) await page.getByLabel('执行轮次').selectOption(run.id);
        if (index >= 2) {
            await expect(
                page.getByText('结果尚不可用。', { exact: true }),
            ).toBeVisible();
            await expect(download).toHaveCount(0);
            await expect(page.getByText('这次任务没有文件变更。')).toHaveCount(
                0,
            );
            if (index === 2)
                await expect(
                    page.getByText('Run stopped before completion.', {
                        exact: true,
                    }),
                ).toBeVisible();
            continue;
        }
        await expect(download).toBeVisible();
        await expect(
            page.getByText('结果尚不可用。', { exact: true }),
        ).toHaveCount(0);
        for (const [name, label] of [
            ['匹配', '通过'],
            ['不匹配', '失败'],
            ['跳过', '未运行'],
            ['读取失败', '无法运行'],
        ])
            await expect(
                page
                    .getByRole('listitem')
                    .filter({ hasText: name + ' · ' + label }),
            ).toHaveCount(1);
        for (const check of checks)
            if (check.output)
                await expect(
                    page.getByText(check.output, { exact: true }),
                ).toBeVisible();
        for (const view of ['cumulative', 'incremental']) {
            await page.getByLabel('补丁范围').selectOption(view);
            await expect(download).toHaveAttribute(
                'href',
                new RegExp(
                    '/' +
                        run.id +
                        '/results/1/diff\\?view=' +
                        view +
                        '&download=1$',
                ),
            );
            if (index === 0)
                await expect(page.getByLabel('逐行变更')).toHaveText(patch);
            else
                await expect(
                    page.getByText('这次任务没有文件变更。'),
                ).toBeVisible();
            const pending = page.waitForEvent('download');
            await download.click();
            const file = await pending;
            expect(await readFile(await file.path())).toEqual(
                Buffer.from(index === 0 ? patch : ''),
            );
            expect(requested).toContain(run.id + ':' + view);
        }
    }
});
