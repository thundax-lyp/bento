import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { Task, TaskRun } from '../src/api.ts';
import { startTaskSubmissionFixture } from './task-submission-fixture.ts';

let fixture: Awaited<ReturnType<typeof startTaskSubmissionFixture>>;
test.beforeEach(async () => {
    fixture = await startTaskSubmissionFixture();
});
test.afterEach(async () => {
    await fixture?.close();
});

async function login(page: Page) {
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
}
async function get<T>(page: Page, path: string): Promise<T> {
    const response = await page.request.get(path);
    expect(response.status()).toBe(200);
    return response.json() as Promise<T>;
}
const headers = (key: string) => ({
    'Idempotency-Key': key,
    Origin: 'http://127.0.0.1:4344',
});

async function dropReceipt<T>(page: Page, path: string) {
    const receipts: { status: number; key: string; body: string; value: T }[] =
        [];
    let resolveLost: () => void;
    const lost = new Promise<void>((resolve) => {
        resolveLost = resolve;
    });
    await page.route(
        (url) => url.pathname === path,
        async (route) => {
            if (route.request().method() !== 'POST') return route.continue();
            const upstream = await route.fetch();
            const receipt = {
                status: upstream.status(),
                key: route.request().headers()['idempotency-key']!,
                body: route.request().postData()!,
                value: (await upstream.json()) as T,
            };
            receipts.push(receipt);
            if (receipts.length === 1) {
                expect(upstream.status()).toBe(202);
                await route.abort('failed');
                resolveLost();
            } else await route.fulfill({ response: upstream });
        },
    );
    return { receipts, lost };
}
async function createBlank(page: Page) {
    await page.goto('/');
    await page.getByLabel('任务名称').fill('Submission task');
    const accepting = page.waitForResponse(
        (r) =>
            new URL(r.url()).pathname === '/api/tasks' &&
            r.request().method() === 'POST',
    );
    await page
        .getByRole('button', { name: '创建空白任务', exact: true })
        .click();
    const response = await accepting;
    expect(response.status()).toBe(202);
    const { task } = (await response.json()) as { task: Task };
    await expect(page.getByLabel('任务要求')).toBeEnabled();
    return task;
}
async function waitSucceeded(page: Page, taskId: string, runId: string) {
    await expect
        .poll(
            async () =>
                (
                    await get<{ run: TaskRun }>(
                        page,
                        `/api/tasks/${taskId}/runs/${runId}`,
                    )
                ).run.status,
        )
        .toBe('succeeded');
}
async function send(page: Page, taskId: string, prompt = 'noop') {
    await page.getByLabel('任务要求').fill(prompt);
    const accepting = page.waitForResponse(
        (r) =>
            new URL(r.url()).pathname === `/api/tasks/${taskId}/runs` &&
            r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '发送要求', exact: true }).click();
    const response = await accepting;
    expect(response.status()).toBe(202);
    const { run } = (await response.json()) as { run: TaskRun };
    return run;
}
async function counts(taskId: string, sourceReads = 0) {
    await expect
        .poll(() => fixture.observe(taskId))
        .toEqual({
            prepare: 1,
            execute: 1,
            runs: 1,
            userMessages: 1,
            creationReceipts: 1,
            sourceReads,
        });
    console.log('submission counts', await fixture.observe(taskId));
}

for (const kind of ['blank', 'snapshot'] as const) {
    test(`${kind} create receipt: production accepts before the response is discarded`, async ({
        page,
    }) => {
        await login(page);
        const source = kind === 'snapshot' ? await fixture.seedSource() : null;
        if (source) {
            await page.goto('/space/' + source.spaceId);
            await page.getByRole('checkbox', { name: 'input.txt' }).check();
        } else await page.getByLabel('任务名称').fill('Lost creation');
        const dropped = await dropReceipt<{ task: Task }>(page, '/api/tasks');
        const button = page.getByRole('button', {
            name: source ? '从所选文件新建任务' : '创建空白任务',
            exact: true,
        });
        await button.click();
        await dropped.lost;
        const first = dropped.receipts[0]!;
        if (source) fixture.setSourceText('next\n');
        await expect(button).toBeEnabled();
        await button.click();
        await expect.poll(() => dropped.receipts.length).toBe(2);
        const replay = dropped.receipts[1]!;
        expect(replay.status).toBe(200);
        expect(replay.key).toBe(first.key);
        expect(replay.body).toBe(first.body);
        expect(replay.value.task.id).toBe(first.value.task.id);
        expect(replay.value.task.inputDigest).toBe(
            first.value.task.inputDigest,
        );
        expect(replay.value.task.environmentVersion).toBe(
            first.value.task.environmentVersion,
        );
        expect(replay.value.task.inputs).toEqual(first.value.task.inputs);
        if (source)
            expect(JSON.parse(first.body)).toEqual({
                name: source.name,
                source: {
                    kind: 'space_snapshot',
                    spaceId: source.spaceId,
                    fileIds: [source.fileId],
                },
            });
        await expect(page.getByLabel('任务要求')).toBeEnabled();
        const run = await send(page, first.value.task.id);
        await waitSucceeded(page, first.value.task.id, run.id);
        await counts(first.value.task.id, source ? 1 : 0);
        const before = await fixture.observe(first.value.task.id);
        const conflict = await page.request.post('/api/tasks', {
            headers: headers(first.key),
            data: { ...JSON.parse(first.body), name: 'Different' },
        });
        expect(conflict.status()).toBe(409);
        expect((await conflict.json()).error.code).toBe('idempotency_conflict');
        expect(await fixture.observe(first.value.task.id)).toEqual(before);
    });
}

test('completed Run receipt: a lost response replays the original Run once', async ({
    page,
}) => {
    await login(page);
    const task = await createBlank(page);
    const dropped = await dropReceipt<{ run: TaskRun }>(
        page,
        `/api/tasks/${task.id}/runs`,
    );
    await page.getByLabel('任务要求').fill('noop');
    await page.getByRole('button', { name: '发送要求', exact: true }).click();
    await dropped.lost;
    const first = dropped.receipts[0]!;
    await waitSucceeded(page, task.id, first.value.run.id);
    await expect(
        page.getByRole('button', { name: '发送要求', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: '重试提交', exact: true }).click();
    await expect.poll(() => dropped.receipts.length).toBe(2);
    expect(dropped.receipts[1]!.status).toBe(200);
    expect(dropped.receipts[1]!.key).toBe(first.key);
    expect(dropped.receipts[1]!.body).toBe(first.body);
    expect(dropped.receipts[1]!.value.run.id).toBe(first.value.run.id);
    await expect(
        page.getByRole('button', { name: '重试提交', exact: true }),
    ).toHaveCount(0);
    await counts(task.id);
});

test('reopen receipt: original Task and Run remain discoverable in the same persistent deployment', async ({
    page,
}) => {
    await login(page);
    await page.getByLabel('任务名称').fill('Reopen task');
    const dropped = await dropReceipt<{ task: Task }>(page, '/api/tasks');
    await page
        .getByRole('button', { name: '创建空白任务', exact: true })
        .click();
    await dropped.lost;
    const first = dropped.receipts[0]!;
    const stored = await page.evaluate(() =>
        Object.entries(sessionStorage).filter(([key]) =>
            key.includes('bento:task-mutation'),
        ),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]![1]).toBe(first.key);
    await page.reload();
    expect(
        await page.evaluate(() =>
            Object.entries(sessionStorage).filter(([key]) =>
                key.includes('bento:task-mutation'),
            ),
        ),
    ).toEqual(stored);
    const task = first.value.task;
    await page.goto('/tasks/' + task.id);
    await expect(page.getByLabel('任务要求')).toBeEnabled();
    let runKey = '';
    page.on('request', (r) => {
        if (
            r.method() === 'POST' &&
            new URL(r.url()).pathname === `/api/tasks/${task.id}/runs`
        )
            runKey = r.headers()['idempotency-key']!;
    });
    const run = await send(page, task.id);
    await waitSucceeded(page, task.id, run.id);
    await counts(task.id);
    await fixture.reopen();
    const created = await page.request.post('/api/tasks', {
        headers: headers(first.key),
        data: JSON.parse(first.body),
    });
    expect(created.status()).toBe(200);
    const reopened = (await created.json()).task as Task;
    expect(reopened.id).toBe(task.id);
    expect(reopened.inputDigest).toBe(task.inputDigest);
    expect(reopened.environmentVersion).toBe(task.environmentVersion);
    const replay = await page.request.post(`/api/tasks/${task.id}/runs`, {
        headers: headers(runKey),
        data: { prompt: 'noop' },
    });
    expect(replay.status()).toBe(200);
    expect((await replay.json()).run.id).toBe(run.id);
    await counts(task.id);
});

test('active Run receipt: the page can retry only the unknown original submission', async ({
    page,
    context,
}) => {
    await login(page);
    const task = await createBlank(page);
    const path = `/api/tasks/${task.id}/runs`;
    const dropped = await dropReceipt<{ run: TaskRun }>(page, path);
    await page.getByLabel('任务要求').fill('hold-submission');
    await page.getByRole('button', { name: '发送要求', exact: true }).click();
    await dropped.lost;
    const first = dropped.receipts[0]!;
    await expect
        .poll(
            async () =>
                (
                    await get<{ run: TaskRun }>(
                        page,
                        path + '/' + first.value.run.id,
                    )
                ).run.status,
        )
        .toBe('running');
    await counts(task.id);
    const retry = page.getByRole('button', { name: '重试提交', exact: true });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect.poll(() => dropped.receipts.length).toBe(2);
    expect(dropped.receipts[1]!.status).toBe(200);
    expect(dropped.receipts[1]!.key).toBe(first.key);
    expect(dropped.receipts[1]!.body).toBe(first.body);
    expect(dropped.receipts[1]!.value.run.id).toBe(first.value.run.id);
    const other = await context.newPage();
    await other.goto('/tasks/' + task.id);
    await expect(
        other.getByRole('button', { name: '发送要求', exact: true }),
    ).toBeDisabled();
    await expect(
        other.getByText('任务已有执行，请等待完成或取消。', { exact: true }),
    ).toBeVisible();
    await expect(retry).toHaveCount(0);
    const before = await fixture.observe(task.id);
    for (const [key, prompt, code] of [
        [randomUUID(), 'New requirement', 'task_busy'],
        [first.key, 'Different', 'idempotency_conflict'],
    ]) {
        const response = await other.request.post(path, {
            headers: headers(key!),
            data: { prompt },
        });
        expect(response.status()).toBe(409);
        expect((await response.json()).error.code).toBe(code);
        expect(await fixture.observe(task.id)).toEqual(before);
    }
    expect(
        (await get<{ run: TaskRun }>(page, path + '/' + first.value.run.id)).run
            .status,
    ).toBe('running');
    fixture.releaseRun(task.id);
    await waitSucceeded(page, task.id, first.value.run.id);
    await counts(task.id);
    await other.close();
});

test('unknown receipt UI: 5xx retains the exact submission and definite 4xx clears its temporary entry', async ({
    page,
}) => {
    await login(page);
    const task = await createBlank(page);
    const path = `/api/tasks/${task.id}/runs`;
    const dropped = await dropReceipt<{ run: TaskRun }>(page, path);
    await page.getByLabel('任务要求').fill('hold-submission');
    await page.getByRole('button', { name: '发送要求', exact: true }).click();
    await dropped.lost;
    const first = dropped.receipts[0]!;
    await counts(task.id);
    const retry = page.getByRole('button', { name: '重试提交', exact: true });
    await expect(retry).toBeEnabled();
    await expect(page.getByRole('textbox')).toBeDisabled();
    let releaseResponse: () => void = () => {};
    const waitingResponse = new Promise<void>((resolve) => {
        releaseResponse = resolve;
    });
    const requests: { key: string; body: string }[] = [];
    // Only these synthetic error responses test UI cleanup. Acceptance was real above.
    await page.route(
        (url) => url.pathname === path,
        async (route) => {
            if (route.request().method() !== 'POST') return route.continue();
            requests.push({
                key: route.request().headers()['idempotency-key']!,
                body: route.request().postData()!,
            });
            if (requests.length === 1) await waitingResponse;
            await route.fulfill({
                status: requests.length === 1 ? 502 : 409,
                json: {
                    error: {
                        code:
                            requests.length === 1
                                ? 'backend_error'
                                : 'task_busy',
                        message: 'Synthetic UI rejection',
                    },
                },
            });
        },
    );
    await retry.click();
    await expect.poll(() => requests.length).toBe(1);
    await expect(retry).toBeDisabled();
    await expect(
        page.getByRole('button', { name: '发送要求', exact: true }),
    ).toBeDisabled();
    releaseResponse();
    await expect(retry).toBeEnabled();
    expect(await page.evaluate(() => Object.values(sessionStorage))).toContain(
        first.key,
    );
    expect(requests).toEqual([{ key: first.key, body: first.body }]);
    await retry.click();
    await expect(retry).toHaveCount(0);
    expect(requests).toEqual([
        { key: first.key, body: first.body },
        { key: first.key, body: first.body },
    ]);
    expect(
        await page.evaluate(() => Object.values(sessionStorage)),
    ).not.toContain(first.key);
    await expect(
        page.getByRole('button', { name: '发送要求', exact: true }),
    ).toBeDisabled();
    await expect(
        page.getByText('任务已有执行，请等待完成或取消。', { exact: true }),
    ).toBeVisible();
    await counts(task.id);
    fixture.releaseRun(task.id);
    await waitSucceeded(page, task.id, first.value.run.id);
    await counts(task.id);
});
