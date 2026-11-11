import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

async function register(
    page: import('@playwright/test').Page,
    account: string,
    password: string,
) {
    await page.getByRole('link', { name: '使用邀请码注册' }).click();
    await page.getByLabel('账号').fill(account);
    await page.getByLabel('邀请码').fill('demo-invite');
    await page.getByLabel('新密码').fill(password);
    await page.getByRole('button', { name: '注册', exact: true }).click();
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
