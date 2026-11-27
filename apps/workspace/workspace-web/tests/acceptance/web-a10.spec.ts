import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
    expect,
    test,
    type Page,
    type Response,
    type Browser,
} from '@playwright/test';
import type {
    Session,
    Task,
    TaskEvent,
    TaskRun,
} from '@/apps/workspace/workspace-web/src/api.ts';
import { callA10Hook } from './web-a10-hook.ts';

type Login = { account: string; username: string; password: string };
type Run = { id: string; taskId: string; path: string; page: Page };
type TenantPages = [Page, Page, Page];
const file = 'web-a10.txt';
const executionTimeout = 120_000;
const exitObservationTimeout = 10_000;
const reviewTimeout = 30_000;
const observationRequestTimeout = 2_000;
const nextStep = '上一次操作结果未确认。请等待可信侧核对。';

function posted(path: string) {
    return (response: Response) =>
        new URL(response.url()).pathname === path &&
        response.request().method() === 'POST';
}

async function login(page: Page, identity: Login, origin: string) {
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
    await expect(page).toHaveURL(origin + '/');
    const session = await page.request.get('/api/session');
    expect(session.status()).toBe(200);
    expect(
        ((await session.json()) as Session).account === identity.account,
    ).toBe(true);
}

async function sourceTask(page: Page) {
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
    return selectTask(page);
}

async function selectTask(page: Page) {
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
): Promise<Run & { key: string }> {
    const path = '/api/tasks/' + encodeURIComponent(task.id) + '/runs';
    await page.getByLabel('任务要求').fill('WEB-A10 ' + role + ' ' + marker);
    const response = page.waitForResponse(posted(path));
    await page.getByRole('button', { name: '发送要求' }).click();
    const accepted = await response;
    expect(accepted.status()).toBe(202);
    const { run } = (await accepted.json()) as { run: TaskRun };
    expect(run.taskId).toBe(task.id);
    const key = (await accepted.request().allHeaders())['idempotency-key'];
    if (!key) throw new Error('Missing Run submission idempotency key');
    expect(key).toMatch(/^[a-f0-9-]{36}$/);
    return {
        key,
        id: run.id,
        taskId: task.id,
        path: path + '/' + encodeURIComponent(run.id),
        page,
    };
}

async function current(run: Run, timeout?: number) {
    const response = await run.page.request.get(
        run.path,
        timeout === undefined ? {} : { timeout },
    );
    expect(response.status()).toBe(200);
    const { run: value } = (await response.json()) as { run: TaskRun };
    expect(value.id).toBe(run.id);
    return value;
}

function waitStatus(
    run: Run,
    status: TaskRun['status'],
    timeout = executionTimeout,
    requestTimeout?: number,
) {
    return expect
        .poll(async () => (await current(run, requestTimeout)).status, {
            timeout,
            message: `Run ${run.id} did not reach ${status}`,
        })
        .toBe(status);
}

async function waitReview(run: Run, afterObservedExit = false) {
    await waitStatus(
        run,
        'needs_review',
        afterObservedExit ? reviewTimeout : executionTimeout,
        afterObservedExit ? observationRequestTimeout : undefined,
    );
    await expect(run.page.getByText(nextStep, { exact: true })).toBeVisible();
    expect((await run.page.request.get(run.path + '/results')).status()).toBe(
        409,
    );
    expect(
        (
            await run.page.request.get(
                run.path + '/results/1/diff?view=cumulative',
            )
        ).status(),
    ).toBe(409);
}

async function freeze(run: Run, marker: string) {
    const markerSha256 = createHash('sha256').update(marker).digest('hex');
    expect(
        await callA10Hook('armWriteFreeze', { runId: run.id, markerSha256 }),
    ).toMatchObject({ armed: true });
}

async function interruptFrozenAttempt(run: Run) {
    let operationId: unknown;
    await expect
        .poll(
            async () => {
                try {
                    operationId = (
                        await callA10Hook('lookupSdkUnknown', { runId: run.id })
                    ).operationId;
                    return operationId;
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
    return operationId;
}

async function observeInterruptedExit(run: Run, workerIdentity: unknown) {
    expect(workerIdentity).toMatch(/^[a-f0-9]{64}$/);
    await expect
        .poll(
            async () => {
                try {
                    return await callA10Hook(
                        'readRunEvidence',
                        { runId: run.id },
                        observationRequestTimeout,
                    );
                } catch {
                    return { observation: 'unavailable' };
                }
            },
            {
                timeout: exitObservationTimeout,
                message: `Run ${run.id}: no independent exit evidence for Worker ${workerIdentity}`,
            },
        )
        .toMatchObject({
            independentlyExited: true,
            workerIdentitySha256: workerIdentity,
        });
}

async function readInterrupted(run: Run, afterObservedExit = true) {
    await waitReview(run, afterObservedExit);
    const evidence = await callA10Hook('readRunEvidence', { runId: run.id });
    expect(evidence).toMatchObject({
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
    return evidence;
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

async function interruptedCase([a, b, c]: TenantPages, faultOnly = false) {
    const [taskA, taskB, taskC] = await Promise.all([
        sourceTask(a),
        sourceTask(b),
        sourceTask(c),
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
    const unknownOperationId = await interruptFrozenAttempt(runA);
    expect(
        await callA10Hook('releaseQueueBarrier', { caseId, role: 'B' }),
    ).toMatchObject({ released: true });
    if (!faultOnly) {
        await observeInterruptedExit(runA, both.aIdentitySha256);
        await readInterrupted(runA);
    }
    await waitStatus(runB, 'succeeded');
    expect(
        await callA10Hook('readRunEvidence', { runId: runB.id }),
    ).toMatchObject({
        workerIdentitySha256: both.bIdentitySha256,
    });
    await expectPatch(runB, markerB);
    await waitStatus(runC, 'succeeded');
    expect(
        (await callA10Hook('readRunEvidence', { runId: runC.id }))
            .workerIdentitySha256,
    ).toMatch(/^[a-f0-9]{64}$/);

    const faultEvidence = faultOnly
        ? await readInterrupted(runA, false)
        : undefined;
    return {
        run: runA,
        marker,
        task: taskA,
        unknownOperationId,
        faultEvidence,
    };
}

async function verifySafeRetry(page: Page) {
    const task = await sourceTask(page);
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

async function closeUnconfirmed(run: Run, origin: string) {
    expect(
        await callA10Hook('closeUnconfirmed', { runId: run.id }),
    ).toMatchObject({ closed: true });
    await waitStatus(run, 'failed');
    await expect(
        run.page.getByText(
            '该任务已结案，执行结果无法确认。历史交付仍可查看。',
            { exact: true },
        ),
    ).toBeVisible();
    await expect(
        run.page.getByRole('link', { name: '下载 diff', exact: true }),
    ).toHaveCount(0);
    await expect(
        run.page.getByLabel('后续要求', { exact: true }),
    ).toBeDisabled();
    await expect(
        run.page.getByRole('button', { name: '发送要求', exact: true }),
    ).toBeDisabled();
    const collection = '/api/tasks/' + encodeURIComponent(run.taskId) + '/runs';
    const denied = await run.page.request.post(collection, {
        headers: { 'Idempotency-Key': randomUUID(), Origin: origin },
        data: { prompt: 'WEB-A10 C ' + randomUUID() },
    });
    expect(denied.status()).toBe(409);
    expect(await denied.json()).toMatchObject({
        error: { code: 'task_not_ready' },
    });
    const runs = await run.page.request.get(collection);
    expect(runs.status()).toBe(200);
    expect((await runs.json()).items.map((row: TaskRun) => row.id)).toEqual([
        run.id,
    ]);
    expect((await run.page.request.get(run.path + '/results')).status()).toBe(
        409,
    );
    expect(
        (
            await run.page.request.get(
                run.path + '/results/1/diff?view=cumulative',
            )
        ).status(),
    ).toBe(409);
    expect(await callA10Hook('readClosure', { runId: run.id })).toMatchObject({
        closed: true,
    });
}

async function saveIdentities(rows: object) {
    const evidence = process.env.BENTO_WEB_A10_OBSERVATION_INPUT;
    if (!evidence)
        throw new Error('WEB-A10 requires a private observation input file');
    await writeFile(evidence, JSON.stringify(rows) + '\n', {
        mode: 0o600,
        flag: 'wx',
    });
}

async function verifyContinuation(
    browser: Browser,
    baseURL: string,
    identity: Login,
    original: { run: Run; task: Task; marker: string },
) {
    const { run, task, marker } = original;
    const eventPath = '/api/tasks/' + task.id + '/events?after=0';
    const readEvents = async (page: Page) => {
        const raw = await page.request.get(eventPath);
        expect(raw.status()).toBe(200);
        return ((await raw.json()) as { items: TaskEvent[] }).items;
    };
    const version = (await current(run)).resultVersion;
    expect(version).not.toBeNull();
    const baselineDiff =
        run.path + '/results/' + version + '/diff?view=cumulative';
    const originalBytes = await (
        await run.page.request.get(baselineDiff)
    ).body();
    const events = await readEvents(run.page);
    expect(
        events.some((event) => event.kind === 'step' && event.runId === run.id),
    ).toBe(true);
    expect(new Set(events.map((event) => event.sequence)).size).toBe(
        events.length,
    );
    expect(events.map((event) => event.sequence)).toEqual(
        events.map((event) => event.sequence).sort((a, b) => a - b),
    );
    const context = await browser.newContext({ baseURL });
    try {
        const second = await context.newPage();
        await login(second, identity, new URL(baseURL).origin);
        await second.goto('/tasks/' + task.id + '?run=' + run.id);
        await context.setOffline(true);
        await context.setOffline(false);
        await second.reload();
        expect(await readEvents(second)).toEqual(events);
        expect(await (await second.request.get(baselineDiff)).body()).toEqual(
            originalBytes,
        );
    } finally {
        await context.close();
    }
    const newMarker = randomUUID();
    const next = await send(run.page, task, 'C', newMarker);
    await waitStatus(next, 'succeeded');
    const replay = await run.page.request.post(
        '/api/tasks/' + task.id + '/runs',
        {
            headers: {
                'Idempotency-Key': next.key,
                Origin: new URL(baseURL).origin,
            },
            data: { prompt: 'WEB-A10 C ' + newMarker },
        },
    );
    expect(replay.status()).toBe(200);
    expect((await replay.json()).run.id).toBe(next.id);
    const currentVersion = (await current(next)).resultVersion;
    const combinedResponse = await run.page.request.get(
        next.path + '/results/' + currentVersion + '/diff?view=cumulative',
    );
    expect(combinedResponse.status()).toBe(200);
    const combined = await combinedResponse.text();
    expect(combined).toContain(marker);
    expect(combined).toContain(newMarker);
    expect(await (await run.page.request.get(baselineDiff)).body()).toEqual(
        originalBytes,
    );
    expect((await readEvents(run.page)).slice(0, events.length)).toEqual(
        events,
    );
    expect(task.sourceSpaceId).toBeTruthy();
    await run.page.goto('/space/' + task.sourceSpaceId);
    const independent = await selectTask(run.page);
    const independentMarker = randomUUID();
    const fresh = await send(run.page, independent, 'C', independentMarker);
    await waitStatus(fresh, 'succeeded');
    const freshVersion = (await current(fresh)).resultVersion;
    const independentResponse = await run.page.request.get(
        fresh.path + '/results/' + freshVersion + '/diff?view=cumulative',
    );
    expect(independentResponse.status()).toBe(200);
    const freshDiff = await independentResponse.text();
    expect(freshDiff).toContain(independentMarker);
    expect(freshDiff).not.toContain(marker);
    expect(freshDiff).not.toContain(newMarker);
    await saveIdentities({
        original: { taskId: task.id, runId: run.id },
        continuation: { taskId: task.id, runId: next.id },
        independent: { taskId: independent.id, runId: fresh.id },
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
    const origin = new URL(baseURL).origin;
    const identities = JSON.parse(await readFile(input, 'utf8')) as Login[];
    const smokeOnly = process.env.BENTO_WEB_A10_SMOKE_ONLY === '1';
    if (smokeOnly) {
        const probe = identities[0];
        expect(identities.length).toBe(1);
        const context = await browser.newContext({ baseURL });
        try {
            const page = await context.newPage();
            await login(page, probe!, origin);
            const task = await sourceTask(page);
            const marker = process.env.BENTO_WEB_A10_PREPARE_MARKER;
            if (
                !marker ||
                !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(marker)
            )
                throw new Error('WEB-A10 requires its assigned smoke marker');
            const run = await send(page, task, 'C', marker);
            await waitStatus(run, 'succeeded');
            await expectPatch(run, marker);
            await saveIdentities({ probe: { taskId: task.id, runId: run.id } });
        } finally {
            await context.close();
        }
        return;
    }
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
                await login(page, identities[index]!, origin);
                return page;
            }),
        );
        if (!a || !b || !c)
            throw new Error('WEB-A10 requires three browser contexts');
        const faultOnly = process.env.BENTO_A5_03_FAULT_ONLY === '1';
        const confirmed = await interruptedCase([a, b, c], faultOnly);
        if (faultOnly) {
            await saveIdentities({
                fault: {
                    runId: confirmed.run.id,
                    taskId: confirmed.task.id,
                    unknownOperationId: confirmed.unknownOperationId,
                    oldGenerationWriteDenied:
                        confirmed.faultEvidence?.oldGenerationWriteDenied,
                    markerSha256: createHash('sha256')
                        .update(confirmed.marker)
                        .digest('hex'),
                },
            });
            return;
        }
        expect(
            await callA10Hook('confirmSuccess', { runId: confirmed.run.id }),
        ).toMatchObject({ confirmed: true });
        await waitStatus(confirmed.run, 'succeeded');
        await expectPatch(confirmed.run, confirmed.marker);
        await verifyContinuation(browser, baseURL, identities[0]!, confirmed);

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
        expect(
            (await a.request.get(failed.run.path + '/results')).status(),
        ).toBe(409);
        const unsafe = await a.request.post(failed.run.path + '/retry', {
            headers: { 'Idempotency-Key': randomUUID(), Origin: origin },
        });
        expect(unsafe.status()).toBe(409);
        expect((await current(failed.run)).retryReason).toBeTruthy();
        const attempts = await a.request.get(
            '/api/tasks/' + failed.task.id + '/runs',
        );
        expect(
            (await attempts.json()).items.map((run: TaskRun) => run.id),
        ).toEqual([failed.run.id]);

        await verifySafeRetry(a);

        const closing = await interruptedCase([a, b, c]);
        await closeUnconfirmed(closing.run, origin);
        const independent = await sourceTask(a);
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
        const checkDeletion = a.getByRole('button', {
            name: '查询删除进度',
            exact: true,
        });
        await expect
            .poll(
                async () => {
                    if (new URL(a.url()).pathname === '/workspaces')
                        return true;
                    if (
                        (await checkDeletion.isVisible()) &&
                        (await checkDeletion.isEnabled())
                    )
                        await checkDeletion.click();
                    return false;
                },
                { timeout: 30_000 },
            )
            .toBe(true);
        expect(
            await callA10Hook('readClosure', { runId: closing.run.id }),
        ).toMatchObject({ closed: true });

        const closingAccount = await interruptedCase([b, a, c]);
        await closeUnconfirmed(closingAccount.run, origin);
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
        expect(target.origin).toBe(origin);
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
