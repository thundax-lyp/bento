import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

async function register(
    page: import('@playwright/test').Page,
    account: string,
    password: string,
) {
    await page.getByRole('link', { name: '使用邀请码注册' }).click();
    const form = page.locator('form').filter({
        has: page.getByRole('heading', { name: '受邀注册', exact: true }),
    });
    await expect(form).toBeVisible();
    await form.getByLabel('账号').fill(account);
    await form.getByLabel('邀请码').fill('demo-invite');
    await form.getByLabel('新密码').fill(password);
    await form.getByRole('button', { name: '注册', exact: true }).click();
    await expect(page).toHaveURL(/\/login(?:\?|$)/);
}

test('登录、导入文本、提交任务、刷新找回并下载修改', async ({
    page,
    request,
    baseURL,
}) => {
    const guestPassword = randomUUID();
    const guest = await request.post('/api/register', {
        headers: { origin: new URL(baseURL!).origin },
        data: {
            account: 'guest',
            invite: 'demo-invite',
            password: guestPassword,
        },
    });
    expect(guest.status()).toBe(201);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    const demoPassword = randomUUID();
    await register(page, 'demo', demoPassword);
    await page.getByLabel('账号').fill('demo');
    await page.getByLabel('密码', { exact: true }).fill(demoPassword);
    await page.getByRole('button', { name: '登录', exact: true }).click();

    await page.getByRole('link', { name: 'Workspace', exact: true }).click();
    await page.getByLabel('项目名称').fill('产品手册');
    await page.getByLabel('项目文件').setInputFiles({
        name: 'README.md',
        mimeType: 'text/plain',
        buffer: Buffer.from('# 手册\n'),
    });
    await page.getByRole('button', { name: '导入项目' }).click();
    await page.getByRole('link', { name: '在对话中使用' }).click();
    await expect(
        page.getByLabel('执行项目').locator('option:checked'),
    ).toHaveText('产品手册');
    await page.getByLabel('任务要求').fill('请补充 README 安装说明。');
    await page.getByRole('button', { name: '发送任务' }).click();

    await expect(page).toHaveURL(/\/runs\/[^?]+\?project=/);
    const url = page.url();
    await page.reload();
    await expect(page).toHaveURL(url);
    await expect(page.getByLabel('逐行变更')).toContainText(
        '+Bento 模拟任务已完成。',
    );
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载 diff' }).click();
    const patch = await download;
    expect(patch.suggestedFilename()).toBe('bento.diff');
    const path = await patch.path();
    expect(path).not.toBeNull();
    expect(await readFile(path!, 'utf8')).toContain('+Bento 模拟任务已完成。');

    await page.getByRole('button', { name: '退出登录' }).click();
    await page.goto(url);
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.getByLabel('账号').fill('guest');
    await page.getByLabel('密码', { exact: true }).fill(guestPassword);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading')).toHaveText(
        '找不到这个页面或任务。',
    );
    await expect(page.getByRole('link', { name: '下载 diff' })).toHaveCount(0);
});

test('任务详情在可信核对结束后自动显示 diff', async ({ page }) => {
    const runPath = '/api/projects/review-project/runs/review-run';
    let status = 'needs_review';
    await page.route('**/api/session', (route) =>
        route.fulfill({ json: { account: 'reviewer-demo' } }),
    );
    await page.route('**/api/projects', (route) =>
        route.fulfill({
            json: {
                projects: [
                    { id: 'review-project', name: '手册', status: 'ready' },
                ],
            },
        }),
    );
    await page.route('**' + runPath, (route) =>
        route.fulfill({
            json: {
                id: 'review-run',
                projectId: 'review-project',
                status,
                updatedAt: '2026-11-10T00:00:00Z',
            },
        }),
    );
    await page.route('**' + runPath + '/diff', (route) =>
        route.fulfill({
            contentType: 'text/plain',
            body: '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-待核对\n+已核对的修改\n',
        }),
    );

    await page.goto('/runs/review-run?project=review-project');
    await expect(
        page.getByText('手册 · 待核对', { exact: true }),
    ).toBeVisible();
    const download = page.getByRole('link', { name: '下载 diff' });
    await expect(download).toHaveCount(0);
    status = 'succeeded';
    await expect(page.getByLabel('逐行变更')).toContainText('+已核对的修改');
    await expect(download).toHaveAttribute(
        'href',
        runPath + '/diff?download=1',
    );
});

test('受邀注册后用密码登录，注销后该账号无法再登录', async ({ page }) => {
    const password = randomUUID();
    await page.goto('/register');
    await page.getByLabel('账号').fill('registration-demo');
    await page.getByLabel('邀请码').fill('demo-invite');
    await page.getByLabel('新密码').fill(password);
    await page.getByRole('button', { name: '注册', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel('账号').fill('registration-demo');
    await page.getByLabel('密码').fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('link', { name: '账号设置' }).click();
    await page.getByLabel('密码').fill(password);
    await page.getByRole('checkbox', { name: '我已了解注销后果' }).check();
    await page.getByRole('button', { name: '确认注销账号' }).click();
    await expect(page).toHaveURL(/\/login\?closed=1/);
    await expect(page.getByRole('status')).toContainText('账号已关闭');

    await page.getByLabel('账号').fill('registration-demo');
    await page.getByLabel('密码').fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login\?closed=1/);
});

test('任务详情回读取消状态', async ({ page }) => {
    const root = '/api/projects/cancel-project/runs/';
    const states = { 'queued-run': 'queued', 'running-run': 'running' };
    const requests: string[] = [];
    await page.route('**/api/session', (route) =>
        route.fulfill({ json: { account: 'cancel-fixture' } }),
    );
    await page.route('**/api/projects', (route) =>
        route.fulfill({
            json: {
                projects: [
                    { id: 'cancel-project', name: '手册', status: 'ready' },
                ],
            },
        }),
    );
    for (const id of ['queued-run', 'running-run'] as const) {
        const detail = () => ({
            id,
            projectId: 'cancel-project',
            status: states[id],
            updatedAt: '2026-11-12T00:00:00Z',
        });
        await page.route('**' + root + id, (route) =>
            route.fulfill({ json: detail() }),
        );
        await page.route('**' + root + id + '/cancel', (route) => {
            expect(route.request().method()).toBe('POST');
            expect(route.request().postData()).toBeNull();
            expect(new URL(route.request().url()).pathname).toBe(
                root + id + '/cancel',
            );
            requests.push(id);
            states[id] = id === 'queued-run' ? 'cancelled' : 'cancelling';
            return route.fulfill({ json: detail() });
        });
    }

    await page.goto('/runs/queued-run?project=cancel-project');
    await page.getByRole('button', { name: '取消排队' }).click();
    await expect(
        page.getByText('手册 · 已取消', { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
        page.getByText('手册 · 已取消', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '取消排队' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '下载 diff' })).toHaveCount(0);

    await page.goto('/runs/running-run?project=cancel-project');
    await page.getByRole('button', { name: '请求停止' }).click();
    await expect(
        page.getByText('手册 · 取消中', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '请求停止' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '下载 diff' })).toHaveCount(0);
    states['running-run'] = 'needs_review';
    await expect(
        page.getByText('手册 · 待核对', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '请求停止' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '下载 diff' })).toHaveCount(0);
    expect(requests).toEqual(['queued-run', 'running-run']);
});

test('任务列表找回原项目和 Run', async ({ page }) => {
    const paths: string[] = [];
    const writes: string[] = [];
    const createdAt = '2026-11-12T00:00:00Z';
    const first = { id: 'first', name: '第一项目', status: 'ready', createdAt };
    const second = {
        id: 'second',
        name: '第二项目',
        status: 'ready',
        createdAt,
    };
    const run = { projectId: second.id, sessionId: 'session', createdAt };
    const later = '2026-11-13T00:00:00Z';
    const records = [
        {
            ...run,
            id: 'task-z',
            status: 'failed',
            summary: 'Readme review',
            updatedAt: later,
        },
        {
            ...run,
            id: 'task-old',
            status: 'failed',
            summary: 'Readme setup',
            updatedAt: createdAt,
        },
        { ...run, id: 'task-a', status: 'succeeded', updatedAt: later },
    ];
    page.on('request', (request) => {
        if (request.method() === 'POST') writes.push(request.url());
    });
    await page.route('**/api/session', (route) =>
        route.fulfill({ json: { account: 'task-list' } }),
    );
    await page.route('**/api/projects', (route) =>
        route.fulfill({ json: { projects: [first, second] } }),
    );
    await page.route('**/api/projects/*/runs**', (route) => {
        const path = new URL(route.request().url()).pathname;
        paths.push(path);
        if (path.endsWith('/task-z'))
            return route.fulfill({ json: records[0] });
        return route.fulfill({
            json: { runs: path.includes('/second/') ? records : [] },
        });
    });
    await page.goto('/');
    await page.getByRole('link', { name: '任务', exact: true }).click();
    await expect(page.getByText('这个项目还没有任务。')).toBeVisible();
    await page.getByLabel('执行项目').selectOption(second.id);
    const list = page.getByRole('list', { name: '任务列表' });
    await expect(list.getByRole('link')).toHaveText([
        /task-a/,
        /Readme review/,
        /Readme setup/,
    ]);
    await expect(
        list.getByRole('link', { name: /Readme setup/ }).locator('time'),
    ).toHaveAttribute('datetime', createdAt);
    await page.getByLabel('任务状态').selectOption('failed');
    await page.getByLabel('搜索任务').fill('  rEAdMe ReVIew  ');
    await expect(list.getByRole('link')).toHaveText([/Readme review/]);
    await page.getByLabel('搜索任务').fill('不存在');
    await expect(page.getByText('没有符合条件的任务。')).toBeVisible();
    await page.getByLabel('搜索任务').fill(' TASK-Z ');
    await expect(list.getByRole('link')).toHaveCount(1);
    expect(paths).toEqual([
        '/api/projects/first/runs',
        '/api/projects/second/runs',
    ]);
    await list.getByRole('link').click();
    await expect(page).toHaveURL(/\/runs\/task-z\?project=second$/);
    await expect(page.getByRole('heading', { name: '任务详情' })).toBeVisible();
    expect(paths.at(-1)).toBe('/api/projects/second/runs/task-z');
    expect(writes).toEqual([]);
});

test('任务列表找回可重读且空项目不发起 Run 请求', async ({ page }) => {
    let projects = false;
    let available = false;
    let reads = 0;
    await page.route('**/api/session', (route) =>
        route.fulfill({ json: { account: 'empty-list' } }),
    );
    await page.route('**/api/projects', (route) =>
        route.fulfill({
            json: {
                projects: projects
                    ? [
                          {
                              id: 'retry',
                              name: '项目',
                              status: 'ready',
                              createdAt: '2026-11-12T00:00:00Z',
                          },
                      ]
                    : [],
            },
        }),
    );
    await page.route('**/api/projects/*/runs', (route) => {
        reads++;
        return available
            ? route.fulfill({ json: { runs: [] } })
            : route.fulfill({ status: 503 });
    });
    await page.goto('/runs');
    await expect(page.getByText('还没有执行项目。')).toBeVisible();
    await expect(page.getByLabel('执行项目')).toBeDisabled();
    expect(reads).toBe(0);
    projects = true;
    await page.reload();
    const retry = page.getByRole('button', { name: '重新读取任务' });
    await expect(retry).toBeVisible();
    available = true;
    await retry.click();
    await expect(page.getByText('这个项目还没有任务。')).toBeVisible();
    await expect(retry).toHaveCount(0);
    await expect(page).toHaveURL(/\/runs$/);
});

const recoveryProject = {
    id: 'recovery',
    name: '恢复项目',
    status: 'ready',
    createdAt: '2026-11-12T00:00:00Z',
};
const recoveryRoot = '/api/projects/recovery/runs';
const recoveryPatch =
    '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n';

function recoveryRun(id: string, status: string) {
    return {
        id,
        projectId: recoveryProject.id,
        sessionId: 'recovery-session',
        createdAt: recoveryProject.createdAt,
        updatedAt: recoveryProject.createdAt,
        status,
        summary: '摘要 ' + id,
        prompt: '原要求 ' + id,
    };
}

async function recoveryRoutes(
    target:
        | import('@playwright/test').Page
        | import('@playwright/test').BrowserContext,
    runs: ReturnType<typeof recoveryRun>[] = [],
) {
    await target.route('**/api/session', (route) =>
        route.fulfill({ json: { account: 'recovery-fixture' } }),
    );
    await target.route('**/api/projects', (route) =>
        route.fulfill({ json: { projects: [recoveryProject] } }),
    );
    await target.route('**' + recoveryRoot, (route) =>
        route.fulfill({ json: { runs } }),
    );
}

test('原详情恢复允许在首次 503 后原地重读', async ({ page }) => {
    let available = false;
    let diffs = 0;
    await recoveryRoutes(page);
    await page.route('**' + recoveryRoot + '/cold', (route) =>
        available
            ? route.fulfill({ json: recoveryRun('cold', 'recovering') })
            : route.fulfill({ status: 503 }),
    );
    await page.route('**' + recoveryRoot + '/cold/diff', (route) => {
        diffs++;
        return route.fulfill({ body: recoveryPatch });
    });
    const url = '/runs/cold?project=recovery';
    await page.goto(url);
    const retry = page.getByRole('button', { name: '重新读取任务' });
    await expect(retry).toBeVisible();
    available = true;
    await retry.click();
    await expect(page.getByText('原要求 cold')).toBeVisible();
    await expect(page.getByText('恢复项目 · 恢复中')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(url.replace('?', '\\?') + '$'));
    await expect(retry).toHaveCount(0);
    expect(diffs).toBe(0);
});

test('原详情恢复让两个浏览器重连后读取同一 Run', async ({
    browser,
    baseURL,
}) => {
    const left = await browser.newContext({ baseURL: baseURL! });
    const right = await browser.newContext({ baseURL: baseURL! });
    let offline = false;
    let status = 'running';
    let missing = false;
    const unexpected: string[] = [];
    try {
        for (const context of [left, right]) {
            await recoveryRoutes(context);
            context.on('request', (request) => {
                if (
                    request.method() === 'POST' ||
                    request.url().endsWith('/diff')
                ) {
                    unexpected.push(request.url());
                }
            });
            await context.route('**' + recoveryRoot + '/shared', (route) => {
                if (context === left && offline)
                    return route.abort('internetdisconnected');
                return missing
                    ? route.fulfill({ status: 404 })
                    : route.fulfill({ json: recoveryRun('shared', status) });
            });
        }
        const first = await left.newPage();
        const second = await right.newPage();
        const url = '/runs/shared?project=recovery';
        await Promise.all([first.goto(url), second.goto(url)]);
        await expect(first.getByText('原要求 shared')).toBeVisible();
        offline = true;
        await left.setOffline(true);
        await expect(
            first.getByText('连接中断，正在等待重新连接。'),
        ).toBeVisible();
        await expect(first.getByText('原要求 shared')).toHaveCount(1);
        status = 'recovering';
        await expect(second.getByText('恢复项目 · 恢复中')).toBeVisible();
        status = 'needs_review';
        offline = false;
        await left.setOffline(false);
        for (const page of [first, second]) {
            await expect(page.getByText('上一次操作结果未确认')).toHaveCount(1);
            await expect(page.getByText('原要求 shared')).toHaveCount(1);
            await expect(page.getByText('摘要 shared')).toHaveCount(1);
            await expect(
                page.getByRole('link', { name: '下载 diff' }),
            ).toHaveCount(0);
        }
        missing = true;
        for (const page of [first, second]) {
            await expect(
                page.getByRole('heading', { name: '找不到这个页面或任务。' }),
            ).toBeVisible();
            await expect(page.getByText('原要求 shared')).toHaveCount(0);
            await expect(page.getByText('摘要 shared')).toHaveCount(0);
            await expect(
                page.getByRole('button', { name: '请求停止' }),
            ).toHaveCount(0);
        }
        expect(unexpected).toEqual([]);
    } finally {
        await Promise.all([left.close(), right.close()]);
    }
});

test('原详情恢复等待缓存 Run 的最新授权状态', async ({ page }) => {
    const complete = recoveryRun('complete', 'succeeded');
    const running = recoveryRun('active', 'running');
    await recoveryRoutes(page, [complete, running]);
    let gated = false;
    let release: ((status: number) => void) | undefined;
    let diffReads = 0;
    await page.route('**' + recoveryRoot + '/*', async (route) => {
        const item = route.request().url().endsWith('/complete')
            ? complete
            : running;
        const status = gated
            ? await new Promise<number>((resolve) => {
                  release = resolve;
              })
            : 200;
        await route.fulfill({ status, json: status === 200 ? item : {} });
    });
    await page.route('**' + recoveryRoot + '/complete/diff', (route) => {
        diffReads++;
        return route.fulfill({ body: recoveryPatch });
    });
    const taskLink = (id: string) =>
        page.getByRole('link', { name: new RegExp('摘要 ' + id) });
    const download = page.getByRole('link', { name: '下载 diff' });
    const preview = page.getByLabel('逐行变更');
    const cancel = page.getByRole('button', { name: '请求停止' });
    await page.goto('/runs/complete?project=recovery');
    await expect(download).toBeVisible();
    await expect(preview).toContainText('+new');
    const initialDiffReads = diffReads;

    for (const status of [404, 200]) {
        await page.getByRole('link', { name: '任务', exact: true }).click();
        gated = true;
        release = undefined;
        await taskLink('complete').click();
        await expect.poll(() => Boolean(release)).toBe(true);
        await expect(page).toHaveURL(/\/runs\/complete\?project=recovery$/);
        await expect(download).toHaveCount(0);
        await expect(preview).toHaveCount(0);
        expect(diffReads).toBe(initialDiffReads);
        gated = false;
        release!(status);
        if (status === 404) {
            await expect(
                page.getByRole('heading', { name: '找不到这个页面或任务。' }),
            ).toBeVisible();
            await expect(download).toHaveCount(0);
            await expect(preview).toHaveCount(0);
            expect(diffReads).toBe(initialDiffReads);
        } else {
            await expect(download).toBeVisible();
            await expect(preview).toContainText('+new');
        }
    }
    await page.getByRole('link', { name: '任务', exact: true }).click();
    await taskLink('active').click();
    await expect(cancel).toBeVisible();
    await page.getByRole('link', { name: '任务', exact: true }).click();
    gated = true;
    release = undefined;
    await taskLink('active').click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await expect(cancel).toHaveCount(0);
    gated = false;
    release!(200);
    await expect(cancel).toBeVisible();
});
