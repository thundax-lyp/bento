import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('登录、导入文本、提交任务、刷新找回并下载修改', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel('账号').fill('demo');
    await page.getByLabel('邀请码').fill('demo-invite');
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
    await page.getByLabel('邀请码').fill('demo-invite');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading')).toHaveText(
        '找不到这个页面或任务。',
    );
    await expect(page.getByRole('link', { name: '下载 diff' })).toHaveCount(0);
});
