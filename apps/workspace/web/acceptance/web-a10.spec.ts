import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Response } from '@playwright/test';
import type { Session, Task, TaskRun } from '../src/api.ts';
import { callA10Hook } from './web-a10-hook.ts';

type Login = { account: string; username: string; password: string };
type Run = { id: string; taskId: string; path: string; page: Page };
type TenantPages = [Page, Page, Page];
const file = 'web-a10.txt';
const nextStep = '上一次操作结果未确认。请等待可信侧核对。';

function posted(path: string) {
    return (response: Response) =>
        new URL(response.url()).pathname === path &&
        response.request().method() === 'POST';
}

async function login(page: Page, identity: Login) {
    await page.goto('/auth');
    await page.getByRole('link', { name: '受邀用户登录' }).click();
    try {
        await page.locator('#username').fill(identity.username);
        const password = page.locator('#password');
        if (!(await password.isVisible()))
            await page.locator('#kc-login').click();
        await password.fill(identity.password);
        await page.locator('#kc-login').click();
    } catch {
        throw new Error('WEB-A10 could not submit the invited login');
    }
    await expect(page).toHaveURL(/127\.0\.0\.1:28080\/$/);
    const session = await page.request.get('/api/session');
    expect(session.status()).toBe(200);
    expect(
        ((await session.json()) as Session).account === identity.account,
    ).toBe(true);
}

async function createTask(page: Page) {
    await page.goto('/workspaces');
    await page.getByLabel('空间项目名称').fill('WEB-A10 ' + randomUUID());
    await page.getByRole('button', { name: '新建空间项目' }).click();
    await expect(page).toHaveURL(/\/space\/[^/?]+$/);
    await page.getByLabel('文件', { exact: true }).setInputFiles({
        name: file,
        mimeType: 'text/plain',
        buffer: Buffer.from('original\n'),
    });
    await page.getByRole('button', { name: '确认上传' }).click();
    const input = page.getByRole('checkbox', { name: file, exact: true });
    await expect(input).toBeEnabled({ timeout: 60_000 });
    await input.check();
    const response = page.waitForResponse(posted('/api/tasks'));
    await page.getByRole('button', { name: '从所选文件新建任务' }).click();
    const created = await response;
    expect(created.status()).toBe(202);
    const { task } = (await created.json()) as { task: Task };
    await expect(page.getByLabel('任务要求')).toBeEnabled({ timeout: 180_000 });
    return task;
}

async function send(
    page: Page,
    task: Task,
    role: string,
    marker: string,
): Promise<Run> {
    const path = '/api/tasks/' + encodeURIComponent(task.id) + '/runs';
    await page.getByLabel('任务要求').fill('WEB-A10 ' + role + ' ' + marker);
    const response = page.waitForResponse(posted(path));
    await page.getByRole('button', { name: '发送要求' }).click();
    const accepted = await response;
    expect(accepted.status()).toBe(202);
    const { run } = (await accepted.json()) as { run: TaskRun };
    expect(run.taskId).toBe(task.id);
    return {
        id: run.id,
        taskId: task.id,
        path: path + '/' + encodeURIComponent(run.id),
        page,
    };
}

async function current(run: Run) {
    const response = await run.page.request.get(run.path);
    expect(response.status()).toBe(200);
    const { run: value } = (await response.json()) as { run: TaskRun };
    expect(value.id).toBe(run.id);
    return value;
}

function waitStatus(run: Run, status: TaskRun['status']) {
    return expect
        .poll(async () => (await current(run)).status, { timeout: 120_000 })
        .toBe(status);
}

async function waitReview(run: Run) {
    await waitStatus(run, 'needs_review');
    await expect(run.page.getByText(nextStep, { exact: true })).toBeVisible();
    expect((await run.page.request.get(run.path + '/results')).ok()).toBe(
        false,
    );
}

async function freeze(run: Run, marker: string) {
    const markerSha256 = createHash('sha256').update(marker).digest('hex');
    expect(
        await callA10Hook('armWriteFreeze', { runId: run.id, markerSha256 }),
    ).toMatchObject({ armed: true });
}

async function killFrozen(run: Run) {
    await expect
        .poll(
            async () => {
                try {
                    return (
                        await callA10Hook('lookupSdkUnknown', { runId: run.id })
                    ).operationId;
                } catch {
                    return null;
                }
            },
            { timeout: 120_000 },
        )
        .toMatch(/^sdk:[a-f0-9-]{36}$/);
    expect(
        await callA10Hook('killFrozenWorker', { runId: run.id }),
    ).toMatchObject({ killed: true });
}

async function readInterrupted(run: Run) {
    await waitReview(run);
    expect(
        await callA10Hook('readRunEvidence', { runId: run.id }),
    ).toMatchObject({
        independentlyExited: true,
        markerCount: 1,
        oldGenerationWriteDenied: true,
        receipt: 0,
    });
    await expect
        .poll(
            async () =>
                (await callA10Hook('readNotifications', { runId: run.id }))
                    .received,
        )
        .toBe(true);
}

async function expectPatch(run: Run, marker: string) {
    const result = await run.page.request.get(run.path + '/results');
    expect(result.status()).toBe(200);
    expect(await result.json()).toMatchObject({ result: { runId: run.id } });
    const pending = run.page.waitForEvent('download', { timeout: 30_000 });
    await run.page
        .getByRole('link', { name: '下载 diff', exact: true })
        .click();
    const download = await pending;
    try {
        expect(await readFile(await download.path(), 'utf8')).toContain(marker);
    } finally {
        await download.delete();
    }
}

async function interruptedCase([a, b, c]: TenantPages) {
    const [taskA, taskB, taskC] = await Promise.all([
        createTask(a),
        createTask(b),
        createTask(c),
    ]);
    const caseId = randomUUID();
    const marker = randomUUID();
    const markerB = randomUUID();
    const digest = (value: string) =>
        createHash('sha256').update(value).digest('hex');
    expect(
        await callA10Hook('armQueueBarrier', {
            caseId,
            aMarkerSha256: digest(marker),
            bMarkerSha256: digest(markerB),
        }),
    ).toMatchObject({ armed: true });
    const [runA, runB] = await Promise.all([
        send(a, taskA, 'A-write', marker),
        send(b, taskB, 'B', markerB),
    ]);
    const both = await callA10Hook('awaitQueueBarrier', {
        caseId,
        aRunId: runA.id,
        bRunId: runB.id,
    });
    expect(both).toMatchObject({ occupied: true });
    expect(both.aIdentitySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(both.bIdentitySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(both.aIdentitySha256).not.toEqual(both.bIdentitySha256);
    const runC = await send(c, taskC, 'C', randomUUID());
    expect(
        await callA10Hook('proveQueued', { caseId, cRunId: runC.id }),
    ).toMatchObject({ queued: true, noAdmission: true });
    await waitStatus(runC, 'queued');
    await freeze(runA, marker);
    expect(
        await callA10Hook('releaseQueueBarrier', { caseId, role: 'A' }),
    ).toMatchObject({ released: true });
    await killFrozen(runA);
    expect(
        await callA10Hook('releaseQueueBarrier', { caseId, role: 'B' }),
    ).toMatchObject({ released: true });
    await waitStatus(runB, 'succeeded');
    expect(
        await callA10Hook('readRunEvidence', { runId: runB.id }),
    ).toMatchObject({
        workerIdentitySha256: both.bIdentitySha256,
    });
    await expectPatch(runB, markerB);
    await waitStatus(runC, 'succeeded');
    await readInterrupted(runA);

    return { run: runA, marker, task: taskA };
}

async function verifySafeRetry(page: Page) {
    const task = await createTask(page);
    const original = await send(page, task, 'A-cancel', randomUUID());
    await waitStatus(original, 'running');
    await page.getByRole('button', { name: '请求停止', exact: true }).click();
    await waitReview(original);
    expect(
        await callA10Hook('releaseRetryObservation', { runId: original.id }),
    ).toMatchObject({ released: true });
    expect(
        await callA10Hook('confirmFailed', { runId: original.id }),
    ).toMatchObject({ closed: true });
    await waitStatus(original, 'failed');
    await expect(
        page.getByText('可信核对确认执行失败。', { exact: true }),
    ).toBeVisible();
    const retry = page.waitForResponse(posted(original.path + '/retry'));
    await page.getByRole('button', { name: '安全重试', exact: true }).click();
    await page.getByRole('button', { name: '确认重试', exact: true }).click();
    const response = await retry;
    expect(response.status()).toBe(202);
    const { retry: approved } = (await response.json()) as {
        retry: { id: string; runId: string };
    };
    expect(approved.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(approved.runId).not.toBe(original.id);
    const replacement = {
        ...original,
        id: approved.runId,
        path: original.path.slice(0, -original.id.length) + approved.runId,
    };
    await waitStatus(replacement, 'succeeded');
    expect(await current(replacement)).toMatchObject({
        taskId: task.id,
        retryOf: original.id,
    });
    expect(await current(original)).toMatchObject({
        taskId: task.id,
        status: 'failed',
    });
}

async function closeUnconfirmed(run: Run) {
    expect(
        await callA10Hook('closeUnconfirmed', { runId: run.id }),
    ).toMatchObject({ closed: true });
    await waitStatus(run, 'failed');
    await expect(
        run.page.getByText(/该任务已结案，执行结果无法确认/),
    ).toBeVisible();
    await expect(
        run.page.getByRole('link', { name: '下载 diff', exact: true }),
    ).toHaveCount(0);
    await expect(
        run.page.getByRole('button', { name: '发送要求' }),
    ).toHaveCount(0);
    expect((await run.page.request.get(run.path + '/results')).ok()).toBe(
        false,
    );
    expect(await callA10Hook('readClosure', { runId: run.id })).toMatchObject({
        closed: true,
    });
}

test('WEB-A10 preserves other tenants and reconciles the original Run', async ({
    browser,
    baseURL,
}) => {
    test.setTimeout(900_000);
    const input = process.env.BENTO_WEB_A10_LOGIN_FILE;
    if (!input || !baseURL)
        throw new Error('WEB-A10 requires the isolated login fixture');
    const identities = JSON.parse(await readFile(input, 'utf8')) as Login[];
    expect(identities.length).toBe(3);
    expect(new Set(identities.map((identity) => identity.account)).size).toBe(
        3,
    );
    const contexts = await Promise.all(
        identities.map(() => browser.newContext({ baseURL })),
    );
    try {
        const [a, b, c] = await Promise.all(
            contexts.map(async (context, index) => {
                const page = await context.newPage();
                await login(page, identities[index]!);
                return page;
            }),
        );
        if (!a || !b || !c)
            throw new Error('WEB-A10 requires three browser contexts');
        const confirmed = await interruptedCase([a, b, c]);
        expect(
            await callA10Hook('confirmSuccess', { runId: confirmed.run.id }),
        ).toMatchObject({ confirmed: true });
        await waitStatus(confirmed.run, 'succeeded');
        await expectPatch(confirmed.run, confirmed.marker);

        const failed = await interruptedCase([a, b, c]);
        expect(
            await callA10Hook('confirmFailed', { runId: failed.run.id }),
        ).toMatchObject({ closed: true });
        await waitStatus(failed.run, 'failed');
        await expect(
            a.getByText('可信核对确认执行失败。', { exact: true }),
        ).toBeVisible();
        await expect(
            a.getByRole('button', { name: '安全重试', exact: true }),
        ).toHaveCount(0);
        expect((await a.request.get(failed.run.path + '/results')).ok()).toBe(
            false,
        );
        const unsafe = await a.request.post(failed.run.path + '/retry', {
            headers: { 'Idempotency-Key': randomUUID() },
        });
        expect(unsafe.ok()).toBe(false);

        await verifySafeRetry(a);

        const closing = await interruptedCase([a, b, c]);
        await closeUnconfirmed(closing.run);
        const independent = await createTask(a);
        expect(independent.id).not.toBe(closing.task.id);
        const fresh = await send(a, independent, 'C', randomUUID());
        await waitStatus(fresh, 'succeeded');
        expect(closing.task.sourceSpaceId).toBeTruthy();
        await a.goto(
            '/space/' + encodeURIComponent(closing.task.sourceSpaceId!),
        );
        await a.getByRole('button', { name: '删除项目', exact: true }).click();
        const deletion = a.getByRole('region', { name: '确认删除项目' });
        await expect(
            deletion.getByRole('button', { name: '确认删除' }),
        ).toBeEnabled();
        await deletion.getByRole('button', { name: '确认删除' }).click();
        await expect(a).toHaveURL(/\/workspaces$/);
        expect(
            await callA10Hook('readClosure', { runId: closing.run.id }),
        ).toMatchObject({ closed: true });

        const closingAccount = await interruptedCase([b, a, c]);
        await closeUnconfirmed(closingAccount.run);
        await b.goto('/auth');
        await b
            .getByRole('checkbox', { name: '确认注销 Bento 账号并清理项目' })
            .check();
        const close = b.waitForResponse(posted('/api/oidc/close'));
        await b.getByRole('button', { name: '重新认证并注销账号' }).click();
        const authorization = await close;
        expect(authorization.status()).toBe(303);
        const target = new URL(
            (await authorization.headerValue('location')) ?? '',
        );
        expect(target.origin).toBe('http://127.0.0.1:28080');
        expect(target.searchParams.get('prompt')).toBe('login');
        expect(target.searchParams.get('max_age')).toBe('0');
        try {
            const username = b.locator('#username');
            if ((await username.isVisible()) && (await username.isEditable()))
                await username.fill(identities[1]!.username);
            await b.locator('#password').fill(identities[1]!.password);
            await b.locator('#kc-login').click();
        } catch {
            throw new Error(
                'WEB-A10 could not submit account closure reauthentication',
            );
        }
        await expect
            .poll(async () => (await b.request.get('/api/session')).status())
            .toBe(401);
        expect(
            await callA10Hook('readClosure', { runId: closingAccount.run.id }),
        ).toMatchObject({ closed: true });
    } finally {
        await Promise.all(contexts.map((context) => context.close()));
    }
});
