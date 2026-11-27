import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type {
    Task,
    TaskCheck,
    TaskEvent,
    TaskResult,
    TaskRun,
} from '@workspace-web/api.ts';
import {
    privateCanary,
    startTerminalResultsFixture,
} from './terminal-results-fixture.ts';

let fixture: Awaited<ReturnType<typeof startTerminalResultsFixture>>;
test.beforeAll(async () => {
    fixture = await startTerminalResultsFixture();
});
test.afterAll(async () => {
    await fixture?.close();
});

async function get<T>(page: Page, path: string): Promise<T> {
    const response = await page.request.get(path);
    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(privateCanary);
    return JSON.parse(text) as T;
}

async function createTask(page: Page, name: string) {
    await page.goto('/');
    await page.getByLabel('任务名称').fill(name);
    const accepting = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === '/api/tasks' &&
            response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '创建空白任务' }).click();
    const response = await accepting;
    expect(response.status()).toBe(202);
    const { task } = (await response.json()) as { task: Task };
    await expect(page.getByLabel('任务要求')).toBeEnabled();
    const root = '/api/tasks/' + task.id;
    expect((await get<{ task: Task }>(page, root)).task.status).toBe('ready');
    return { id: task.id, root };
}

async function submit(page: Page, root: string, prompt: string) {
    await page.getByLabel('任务要求').fill(prompt);
    const accepting = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === root + '/runs' &&
            response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '发送要求' }).click();
    const response = await accepting;
    expect(response.status()).toBe(202);
    const { run } = (await response.json()) as { run: TaskRun };
    return root + '/runs/' + run.id;
}

async function verifyPatch(page: Page, path: string, empty: boolean) {
    await expect(page.getByRole('link', { name: '下载 diff' })).toBeVisible();
    const { result } = await get<{ result: TaskResult }>(
        page,
        path + '/results',
    );
    expect(result.runId).toBe(path.split('/').at(-1));
    expect(result.version).toBe(1);
    for (const view of ['cumulative', 'incremental'] as const) {
        await page.getByLabel('补丁范围').selectOption(view);
        const previewURL = path + '/results/1/diff?view=' + view;
        const download = page.getByRole('link', { name: '下载 diff' });
        await expect(download).toHaveAttribute(
            'href',
            previewURL + '&download=1',
        );
        const response = await page.request.get(previewURL);
        expect(response.status()).toBe(200);
        const bytes = await response.body();
        expect(bytes.length === 0).toBe(empty);
        expect(bytes.toString()).not.toContain(privateCanary);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(
            result[`${view}Sha256`],
        );
        if (empty)
            await expect(
                page.getByText('这次任务没有文件变更。'),
            ).toBeVisible();
        else
            await expect(page.getByLabel('逐行变更')).toHaveText(
                bytes.toString(),
            );
        const receiving = page.waitForEvent('download');
        await download.click();
        const file = await receiving;
        expect(file.suggestedFilename()).toBe('changes.patch');
        expect(await readFile(await file.path())).toEqual(bytes);
        await expect(
            page.getByText('结果尚不可用。', { exact: true }),
        ).toHaveCount(0);
    }
    return result;
}

async function verifyUnavailable(page: Page, path: string) {
    await expect(
        page.getByText('结果尚不可用。', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: '下载 diff' })).toHaveCount(0);
    await expect(page.getByText('这次任务没有文件变更。')).toHaveCount(0);
    for (const suffix of [
        '/results',
        '/results/1/diff?view=cumulative',
        '/results/1/diff?view=incremental&download=1',
    ]) {
        const response = await page.request.get(path + suffix);
        expect(response.status()).toBe(409);
        const text = await response.text();
        expect(text).not.toContain(privateCanary);
        expect(JSON.parse(text).error.code).toBe('diff_unavailable');
    }
}

test('WEB-06-02 / WEB-08-04 production HTTP, persisted results and Chromium with synthetic Worker', async ({
    page,
}) => {
    const password = randomUUID();
    await page.goto('/login');
    await page.getByRole('link', { name: '使用邀请码注册' }).click();
    const registration = page.locator('form').filter({
        has: page.getByRole('heading', { name: '受邀注册', exact: true }),
    });
    await registration.getByLabel('账号').fill('demo');
    await registration.getByLabel('邀请码').fill('demo-invite');
    await registration.getByLabel('新密码').fill(password);
    await registration
        .getByRole('button', { name: '注册', exact: true })
        .click();
    await expect(page).toHaveURL(/\/login(?:\?|$)/);
    await page.getByLabel('账号').fill('demo');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByLabel('任务名称')).toBeVisible();

    const changed = await createTask(page, '非空补丁');
    const changedPath = await submit(page, changed.root, 'terminal-nonempty');
    await verifyPatch(page, changedPath, false);
    expect((await get<{ run: TaskRun }>(page, changedPath)).run.status).toBe(
        'succeeded',
    );

    const empty = await createTask(page, '空补丁');
    const emptyPath = await submit(page, empty.root, 'noop');
    await verifyPatch(page, emptyPath, true);
    await expect(
        page.getByText('公开结论', { exact: true }).first(),
    ).toBeVisible();

    const checksTask = await createTask(page, '四种检查');
    const checksPath = await submit(page, checksTask.root, 'terminal-checks');
    const result = await verifyPatch(page, checksPath, true);
    const expected: TaskCheck[] = [
        { name: '工作区内容检查', status: 'passed', output: '内容与预期一致' },
        { name: '工作区内容检查', status: 'failed', output: '内容与预期不同' },
        { name: '工作区内容检查', status: 'not_run', output: null },
        {
            name: '工作区内容检查',
            status: 'unavailable',
            output: '无法读取检查目标',
        },
    ];
    expect(result.checks).toEqual(expected);
    const { items } = await get<{ items: TaskEvent[] }>(
        page,
        checksTask.root + '/events?after=0',
    );
    expect(
        items
            .filter((event) => event.kind === 'check')
            .map((event) => event.check),
    ).toEqual(expected);
    const results = page.locator('div.space-y-3').filter({
        has: page.getByRole('heading', { name: '检查结果', exact: true }),
    });
    for (const [index, label] of [
        '通过',
        '失败',
        '未运行',
        '无法运行',
    ].entries()) {
        const item = results.getByRole('listitem').nth(index);
        await expect(item).toContainText('工作区内容检查 · ' + label);
        const output = expected[index]!.output;
        if (output) await expect(item.locator('pre')).toHaveText(output);
        else await expect(item.locator('pre')).toHaveCount(0);
        if (index) await expect(item).not.toContainText('通过');
    }

    const failed = await createTask(page, '明确失败');
    const failedId = await fixture.seedFailure(failed.id);
    const failedPath = failed.root + '/runs/' + failedId;
    await page.goto('/tasks/' + failed.id + '?run=' + failedId);
    const { run } = await get<{ run: TaskRun }>(page, failedPath);
    expect(run.status).toBe('failed');
    expect(run.summary).toBe('Run stopped before completion.');
    expect(run.resultVersion).toBeNull();
    await expect(
        page.getByText('Run stopped before completion.', { exact: true }),
    ).toBeVisible();
    await verifyUnavailable(page, failedPath);

    const pending = await createTask(page, '尚不可用');
    const pendingPath = await submit(
        page,
        pending.root,
        'terminal-unavailable',
    );
    await expect
        .poll(
            async () =>
                (await get<{ run: TaskRun }>(page, pendingPath)).run.status,
        )
        .toBe('running');
    expect(
        (await get<{ run: TaskRun }>(page, pendingPath)).run.resultVersion,
    ).toBeNull();
    await verifyUnavailable(page, pendingPath);
    expect(await page.locator('body').innerText()).not.toContain(privateCanary);
});
