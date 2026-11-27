import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import {
    recoveryRoot,
    recoveryPatch,
    recoveryRun,
    recoveryRoutes,
} from './task-test-fixtures.ts';

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

test('单轮交付恢复保持逐文件、完整下载和空补丁对应原 Run', async ({ page }) => {
    const result = recoveryRun('result', 'succeeded');
    const empty = { ...recoveryRun('empty', 'succeeded'), summary: '只读结论' };
    const bytes = [
        recoveryPatch,
        '--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1 @@\n+added line\n',
        '--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted line\n',
    ].join('');
    await recoveryRoutes(page, [result, empty]);
    await page.route('**' + recoveryRoot + '/result', (route) =>
        route.fulfill({ json: result }),
    );
    await page.route('**' + recoveryRoot + '/empty', (route) =>
        route.fulfill({ json: empty }),
    );
    let published = false;
    let previewResponse: Buffer | undefined;
    page.on('response', async (response) => {
        if (response.url().endsWith('/result/diff') && response.ok()) {
            previewResponse = await response.body();
        }
    });
    await page.route('**' + recoveryRoot + '/*/diff**', (route) => {
        const url = new URL(route.request().url());
        const isResult = url.pathname.endsWith('/result/diff');
        if (isResult && !published) {
            return route.fulfill({
                status: 409,
                json: {
                    error: { code: 'conflict', message: '成果尚未可用。' },
                },
            });
        }
        return route.fulfill({
            contentType: 'text/plain; charset=utf-8',
            headers: url.searchParams.has('download')
                ? { 'content-disposition': 'attachment; filename="bento.diff"' }
                : {},
            body: isResult ? bytes : '',
        });
    });
    const download = page.getByRole('link', { name: '下载 diff' });
    const preview = page.getByLabel('逐行变更');
    await page.goto('/runs/result?project=recovery');
    await expect(page.getByText('结果尚未可用。')).toBeVisible();
    await expect(download).toHaveCount(0);
    await expect(preview).toHaveCount(0);
    published = true;
    await page.getByRole('button', { name: '重新读取补丁' }).click();
    for (const [label, line, other] of [
        ['修改 README.md', '+new', '+added line'],
        ['新增 added.txt', '+added line', '-deleted line'],
        ['删除 deleted.txt', '-deleted line', '+new'],
    ] as const) {
        await page.getByRole('button', { name: label }).click();
        await expect(preview).toContainText(line);
        await expect(preview).not.toContainText(other);
    }
    await page.getByRole('button', { name: '完整补丁' }).click();
    expect(await preview.textContent()).toBe(bytes);
    await expect(download).toHaveAttribute(
        'href',
        recoveryRoot + '/result/diff?download=1',
    );
    const pending = page.waitForEvent('download');
    await download.click();
    expect(await readFile(await (await pending).path())).toEqual(
        previewResponse,
    );
    await page.getByRole('link', { name: '任务', exact: true }).click();
    await page.getByRole('link', { name: /只读结论/ }).click();
    await expect(page.getByText('只读结论', { exact: true })).toBeVisible();
    await expect(page.getByText('这次任务没有文件变更。')).toBeVisible();
    await expect(page.getByText('原要求 result')).toHaveCount(0);
    await expect(
        page.getByRole('button', { name: '修改 README.md' }),
    ).toHaveCount(0);
    await expect(download).toHaveAttribute(
        'href',
        recoveryRoot + '/empty/diff?download=1',
    );
    const pendingEmpty = page.waitForEvent('download');
    await download.click();
    expect((await readFile(await (await pendingEmpty).path())).byteLength).toBe(
        0,
    );
});
