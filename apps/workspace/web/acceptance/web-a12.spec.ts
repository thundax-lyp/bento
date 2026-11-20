import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
    callA12Hook as hook,
    recordA12BrowserEvidence,
    type A12Writes,
} from './web-a12-hook.ts';
import { expect, test, type Page } from '@playwright/test';

const digest = (value: Buffer) =>
    createHash('sha256').update(value).digest('hex');

type EvidenceKind = 'results' | 'events' | 'run-state' | 'mutation';
async function record(
    kind: EvidenceKind,
    taskId: string,
    runId: string | null,
    observation: Record<string, unknown>,
) {
    const entry = process.env.BENTO_WEB_A12_BROWSER_HOOK;
    const lease = process.env.BENTO_WEB_A12_LEASE_FILE;
    if (
        !entry ||
        !lease ||
        !isAbsolute(entry) ||
        !isAbsolute(lease) ||
        !entry.endsWith('/archive/debug-workspace/web-a12/hook.mjs')
    )
        throw new Error('A12_EVIDENCE_COLLECTOR_REQUIRED');
    await recordA12BrowserEvidence({ kind, taskId, runId, observation });
}
function routeIds(path: string) {
    const match =
        /^\/api\/tasks\/([a-f0-9-]+)(?:\/runs(?:\/([a-f0-9-]+))?)?/.exec(path);
    if (!match) throw new Error('A12_EVIDENCE_ROUTE_REJECTED');
    return { taskId: match[1]!, runId: match[2] ?? null };
}
async function recordMutation(
    path: string,
    status: number,
    body: {
        task?: { id?: string };
        run?: { id?: string };
        retry?: { id?: string; runId?: string; state?: string };
    },
    key: string | null,
) {
    const target =
        path === '/api/tasks'
            ? { taskId: body.task?.id ?? '', runId: null }
            : routeIds(path);
    const operation =
        path === '/api/tasks'
            ? 'task.create'
            : path.endsWith('/retry')
              ? 'retry'
              : path.endsWith('/cancel')
                ? 'cancel'
                : path.endsWith('/continue')
                  ? 'continue'
                  : 'run.create';
    await record('mutation', target.taskId, target.runId, {
        operation,
        status,
        keySha256: key ? digest(Buffer.from(key)) : null,
        attemptId: body.retry?.id ?? null,
        newRunId: body.retry?.runId ?? body.run?.id ?? null,
        retryState: body.retry?.state ?? null,
    });
}

async function get(page: Page, path: string) {
    const reply = await page.evaluate(async (path) => {
        const response = await fetch(path, { redirect: 'error' });
        return { status: response.status, body: await response.text() };
    }, path);
    expect(reply.status).toBe(200);
    return {
        json: async () => JSON.parse(reply.body),
        body: async () => Buffer.from(reply.body),
    };
}

async function login(page: Page, origin: string) {
    try {
        const path = process.env.BENTO_WEB_A12_LOGIN_FILE;
        if (!path || !isAbsolute(path)) throw new Error();
        const file = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        let account;
        try {
            const st = await file.stat();
            if (
                !st.isFile() ||
                st.mode % 0o1000 !== 0o600 ||
                st.uid !== process.getuid?.() ||
                st.nlink !== 1 ||
                st.size > 4096
            )
                throw new Error();
            account = JSON.parse(await file.readFile('utf8'));
        } finally {
            await file.close();
        }
        if (
            account.origin !== origin ||
            ![account.login, account.password, account.owner].every(
                (v) => typeof v === 'string' && v,
            )
        )
            throw new Error();
        await page.goto('/auth');
        await page.getByRole('link', { name: '受邀用户登录' }).click();
        if (new URL(page.url()).origin !== origin) throw new Error();
        await page.locator('#username').fill(account.login);
        await page.locator('#kc-login').click();
        if (new URL(page.url()).origin !== origin) throw new Error();
        await page.locator('#password').fill(account.password);
        await page.locator('#kc-login').click();
        await page.waitForURL(
            (url) =>
                url.origin === origin &&
                !url.pathname.startsWith('/identity') &&
                !url.pathname.startsWith('/api/'),
        );
        const session = await (await get(page, '/api/session')).json();
        if (
            session.account !== account.login ||
            !/^[a-f0-9]{48}$/.test(account.owner)
        )
            throw new Error();
    } catch {
        throw new Error('A12_INVITED_LOGIN_REJECTED');
    }
}

test.beforeEach(async ({ page, baseURL }) => {
    if (!baseURL) throw new Error('A12_ORIGIN_REQUIRED');
    await login(page, baseURL);
});

async function fixture(page: Page) {
    await page.goto('/');
    await page.getByLabel('任务名称').fill('WEB07 A ' + randomUUID());
    const accepted = await post(page, '/api/tasks', '创建空白任务');
    const taskPath = '/tasks/' + encodeURIComponent(accepted.task.id);
    await expect(page).toHaveURL(new URL(taskPath, page.url()).href);
    await expect(page.getByLabel('任务要求')).toBeEnabled({ timeout: 180_000 });
    const { task } = await (await get(page, '/api' + taskPath)).json();
    expect(task.status).toBe('ready');
    expect(task.inputs).toEqual([]);
    return taskPath;
}

async function post(page: Page, path: string, button: string) {
    const pending = page.waitForResponse(
        (reply) =>
            new URL(reply.url()).pathname === path &&
            reply.request().method() === 'POST',
    );
    await page.getByRole('button', { name: button, exact: true }).click();
    const reply = await pending;
    expect(reply.status()).toBe(202);
    const body = await reply.json();
    await recordMutation(
        path,
        reply.status(),
        body,
        await reply.request().headerValue('idempotency-key'),
    );
    return body;
}

async function send(
    page: Page,
    taskPath: string,
    prompt: string,
    sequence: number,
) {
    await page
        .getByLabel(sequence === 1 ? '任务要求' : '后续要求')
        .fill(prompt);
    const path = '/api' + taskPath + '/runs';
    const { run } = await post(page, path, '发送要求');
    expect(run.sequence).toBe(sequence);
    return path + '/' + encodeURIComponent(run.id);
}

async function state(page: Page, runPath: string, status: string) {
    let observed = '';
    await expect
        .poll(
            async () => {
                observed = (await (await get(page, runPath)).json()).run.status;
                return observed;
            },
            { intervals: [1000], timeout: 90_000 },
        )
        .toBe(status);
    const target = routeIds(runPath);
    await record('run-state', target.taskId, target.runId, {
        status: observed,
    });
}

async function resultHash(page: Page, runPath: string) {
    const root = runPath + '/results';
    const hashes = await Promise.all(
        [
            root,
            root + '/1/diff?view=incremental',
            root + '/1/diff?view=cumulative',
        ].map(async (path) => digest(await (await get(page, path)).body())),
    );
    const target = routeIds(runPath);
    await record('results', target.taskId, target.runId, {
        indexSha256: hashes[0],
        incrementalSha256: hashes[1],
        cumulativeSha256: hashes[2],
    });
    return hashes;
}

test('WEB-07-04 safe retry preserves prior results and both original checkpoints', async ({
    page,
    browser,
    baseURL,
}) => {
    if (!baseURL) throw new Error('A12_ORIGIN_REQUIRED');
    const taskPath = await fixture(page);
    const prior = await send(page, taskPath, 'WEB07 prior', 1);
    await state(page, prior, 'succeeded');
    const original = await resultHash(page, prior);
    const priorEvents = await events(page, taskPath);
    const failed = await send(page, taskPath, 'WEB07 fail', 2);
    await state(page, failed, 'failed');
    await provePartial(taskPath, failed);
    const reopened = await browser.newContext({ baseURL });
    try {
        const active = await reopened.newPage();
        await login(active, baseURL!);
        await active.goto(taskPath);
        await active
            .getByLabel('执行轮次')
            .selectOption(decodeURIComponent(failed.split('/').at(-1)!));
        await active
            .getByRole('button', { name: '安全重试', exact: true })
            .click();
        const accepting = active.waitForResponse(
            (reply) =>
                new URL(reply.url()).pathname === failed + '/retry' &&
                reply.request().method() === 'POST',
        );
        await expect(
            active.getByText(
                '重试将丢弃本轮未完成的工作区变更，并保留原执行记录。',
                { exact: true },
            ),
        ).toBeVisible();
        await active.getByRole('button', { name: '确认重试' }).click();
        const submitted = await accepting;
        expect(submitted.status()).toBe(202);
        const { retry } = await submitted.json();
        const key = await submitted.request().headerValue('idempotency-key');
        expect(Boolean(key)).toBe(true);
        await recordMutation(
            failed + '/retry',
            submitted.status(),
            { retry },
            key,
        );
        const replay = await postFromPage(active, failed + '/retry', key!);
        expect(replay.status).toBe(200);
        const receipt = replay.body.retry;
        expect([receipt.id, receipt.runId]).toEqual([retry.id, retry.runId]);
        const before = await hook('inspectBeforeAdmit', {
            ...ids(taskPath, failed),
            retryRunId: retry.runId,
        });
        expect(
            before.workspaceMatches &&
                before.historyMatches &&
                before.priorPreserved &&
                before.partialRemoved &&
                before.historyPrefixPreserved &&
                before.historySuffixRemoved &&
                before.admitWasHeld,
        ).toBe(true);
        expect(before.workspaceCheckpointSha256).toBe(
            before.workspaceActualSha256,
        );
        expect(before.historyCheckpointSha256).toBe(before.historyActualSha256);
        expect(before.attemptId).toBe(retry.id);
        console.log(
            'A12_CHECKPOINT_READBACK',
            JSON.stringify({
                attemptId: retry.id,
                runId: retry.runId,
                workspace: before.workspaceActualSha256,
                history: before.historyActualSha256,
            }),
        );
        await state(
            active,
            '/api' + taskPath + '/runs/' + encodeURIComponent(retry.runId),
            'succeeded',
        );
        expect(await resultHash(active, prior)).toEqual(original);
        const allEvents = await events(active, taskPath);
        expect(allEvents.slice(0, priorEvents.length)).toEqual(priorEvents);
        expect(new Set(allEvents.map((event) => event.id)).size).toBe(
            allEvents.length,
        );
        await state(active, failed, 'failed');
        await active
            .getByLabel('执行轮次')
            .selectOption(ids(taskPath, prior).runId);
        await expect(
            active.getByRole('link', { name: '下载 diff', exact: true }),
        ).toBeVisible();
    } finally {
        await reopened.close();
    }
});

function ids(
    taskPath: string,
    runPath: string,
): { taskId: string; runId: string };
function ids(taskPath: string): { taskId: string };
function ids(taskPath: string, runPath?: string) {
    const leaf = (path: string) => decodeURIComponent(path.split('/').at(-1)!);
    return {
        taskId: leaf(taskPath),
        ...(runPath ? { runId: leaf(runPath) } : {}),
    };
}

async function provePartial(taskPath: string, runPath: string) {
    const observed = await hook('provePartial', ids(taskPath, runPath));
    expect(observed.workspaceFsynced && observed.historyCommitted).toBe(true);
}

const eventBaselines = new Map<string, number>();
async function events(page: Page, taskPath: string) {
    const { items } = await (
        await get(page, '/api' + taskPath + '/events?after=0')
    ).json();
    const taskId = ids(taskPath).taskId;
    const baselineCount = eventBaselines.get(taskId) ?? items.length;
    eventBaselines.set(taskId, baselineCount);
    await record('events', taskId, null, {
        count: items.length,
        sha256: digest(Buffer.from(JSON.stringify(items))),
        baselineCount,
        baselinePrefixSha256: digest(
            Buffer.from(JSON.stringify(items.slice(0, baselineCount))),
        ),
    });
    return items as { id: string; sequence: number }[];
}

async function postFromPage(
    page: Page,
    path: string,
    key: string,
    prompt?: string,
) {
    const reply = await page.evaluate(
        async ({ path, key, prompt }) => {
            if (!path.startsWith('/api/tasks/'))
                throw new Error('invalid acceptance route');
            const response = await fetch(path, {
                method: 'POST',
                redirect: 'error',
                headers: {
                    'Idempotency-Key': key,
                    ...(prompt === undefined
                        ? {}
                        : { 'Content-Type': 'application/json' }),
                },
                ...(prompt === undefined
                    ? {}
                    : { body: JSON.stringify({ prompt }) }),
            });
            return { status: response.status, body: await response.json() };
        },
        { path, key, prompt },
    );
    await recordMutation(path, reply.status, reply.body, key);
    return reply;
}

async function rejectRetry(page: Page, runPath: string, reason: string) {
    const response = await postFromPage(page, runPath + '/retry', randomUUID());
    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({
        code: 'run_not_retryable',
        reason,
    });
    expect((await (await get(page, runPath)).json()).run.retryReason).toBe(
        reason,
    );
    await page.getByLabel('执行轮次').selectOption(ids('', runPath).runId!);
    await expect(
        page.getByRole('button', { name: '安全重试', exact: true }),
    ).toHaveCount(0);
}

test('WEB-07-05 queued cancellation and WEB-07-06 running cancellation retain the slot until verified exit', async ({
    page,
    context,
}) => {
    const queuedPage = await context.newPage();
    const followingPage = await context.newPage();
    const queuedTask = await fixture(queuedPage);
    const followingTask = await fixture(followingPage);
    const task = await fixture(page);
    const prior = await send(page, task, 'WEB07 prior', 1);
    await state(page, prior, 'succeeded');
    expect((await hook('holdExit', ids(task))).held).toBe(true);
    const running = await send(page, task, 'WEB07 cancel', 2);
    await state(page, running, 'running');
    await provePartial(task, running);
    const queued = await send(queuedPage, queuedTask, 'WEB07 prior', 1);
    const following = await send(
        followingPage,
        followingTask,
        'WEB07 prior',
        1,
    );
    await page.getByLabel('执行轮次').selectOption(ids('', running).runId!);
    await page.getByRole('button', { name: '请求停止', exact: true }).click();
    await state(page, running, 'cancelling');
    await expect(
        page.getByLabel('执行轮次').locator('option:checked'),
    ).toContainText('取消中');
    await state(queuedPage, queued, 'queued');
    await state(followingPage, following, 'queued');
    await queuedPage
        .getByLabel('执行轮次')
        .selectOption(ids('', queued).runId!);
    await queuedPage
        .getByRole('button', { name: '取消排队', exact: true })
        .click();
    await state(queuedPage, queued, 'cancelled');
    await expect(
        queuedPage.getByLabel('执行轮次').locator('option:checked'),
    ).toContainText('已取消');
    const cancelledBefore = await hook(
        'inspectWrites',
        ids(queuedTask, queued),
    );
    expect(cancelledBefore.workerCreations).toBe(0);
    expect(cancelledBefore.admissions).toBe(0);
    const release = await hook('releaseExit', ids(task, running));
    expect(
        release.verifiedExit &&
            release.revoked &&
            release.sdkWriteDenied &&
            release.sessionWriteDenied,
    ).toBe(true);
    await state(page, running, 'cancelled');
    await state(followingPage, following, 'succeeded');
    await state(queuedPage, queued, 'cancelled');
    await expect(
        queuedPage.getByLabel('执行轮次').locator('option:checked'),
    ).toContainText('已取消');
    const cancelledAfter = await hook('inspectWrites', ids(queuedTask, queued));
    expect(cancelledAfter.workerCreations).toBe(0);
    expect(cancelledAfter.admissions).toBe(0);
    expect(
        (await (await get(queuedPage, '/api' + queuedTask + '/runs')).json())
            .items,
    ).toHaveLength(1);
});

function unchangedExecution(before: A12Writes, after: A12Writes) {
    expect(after.volumeSha256).toBe(before.volumeSha256);
    expect(after.historySha256).toBe(before.historySha256);
    expect(after.restoreWrites).toBe(before.restoreWrites);
    expect(after.admissions).toBe(before.admissions);
    expect(after.workerCreations).toBe(before.workerCreations);
}

async function failedTask(page: Page) {
    const task = await fixture(page);
    const prior = await send(page, task, 'WEB07 prior', 1);
    await state(page, prior, 'succeeded');
    const original = await resultHash(page, prior);
    const failed = await send(page, task, 'WEB07 fail', 2);
    await state(page, failed, 'failed');
    await provePartial(task, failed);
    const input = ids(task, failed);
    const originalCheckpoints = await hook('inspectWrites', input);
    expect(originalCheckpoints.workspaceCheckpointValid).toBe(true);
    expect(originalCheckpoints.historyCheckpointValid).toBe(true);
    expect(originalCheckpoints.attempts).toBe(0);
    return { task, prior, original, failed, input, originalCheckpoints };
}

for (const checkpoint of ['workspace', 'history'] as const) {
    for (const fault of ['missing', 'corrupt'] as const) {
        test(`${checkpoint === 'workspace' ? 'WEB-07-08 workspace' : 'WEB-07-09 history'} ${fault} refuses retry without changing either live baseline`, async ({
            page,
        }) => {
            const f = await failedTask(page);
            const invalidated = await hook('invalidateCheckpoint', {
                ...f.input,
                checkpoint,
                fault,
                attemptId: null,
            });
            expect(invalidated.rows).toBe(1);
            expect(invalidated.stopProof).toBe(true);
            const before = await hook('inspectWrites', f.input);
            unchangedExecution(f.originalCheckpoints, before);
            expect(
                checkpoint === 'workspace'
                    ? before.historyCheckpointValid
                    : before.workspaceCheckpointValid,
            ).toBe(true);
            await page.reload();
            await rejectRetry(page, f.failed, 'checkpoint_unavailable');
            await expect(
                page.getByText('缺少完整检查点，无法安全重试。', {
                    exact: true,
                }),
            ).toBeVisible();
            const after = await hook('inspectWrites', f.input);
            unchangedExecution(before, after);
            expect(after.attempts).toBe(0);
            expect(
                (await (await get(page, '/api' + f.task + '/runs')).json())
                    .items,
            ).toHaveLength(2);
            expect(await resultHash(page, f.prior)).toEqual(f.original);
            await state(page, f.failed, 'failed');
        });
    }
}

for (const checkpoint of ['workspace', 'history'] as const) {
    for (const fault of ['missing', 'corrupt'] as const) {
        test(`WEB-07-10 accepted invalidation ${checkpoint} ${fault} blocks before any restore and replays the original receipt`, async ({
            page,
        }) => {
            const f = await failedTask(page);
            expect((await hook('armRestore', f.input)).armed).toBe(true);
            await page.getByLabel('执行轮次').selectOption(f.input.runId);
            await page
                .getByRole('button', { name: '安全重试', exact: true })
                .click();
            await expect(
                page.getByText(
                    '重试将丢弃本轮未完成的工作区变更，并保留原执行记录。',
                    { exact: true },
                ),
            ).toBeVisible();
            const waiting = page.waitForResponse(
                (reply) =>
                    new URL(reply.url()).pathname === f.failed + '/retry' &&
                    reply.request().method() === 'POST',
            );
            await page
                .getByRole('button', { name: '确认重试', exact: true })
                .click();
            const accepted = await waiting;
            expect(accepted.status()).toBe(202);
            const { retry } = await accepted.json();
            const key = await accepted.request().headerValue('idempotency-key');
            expect(Boolean(key)).toBe(true);
            await recordMutation(
                f.failed + '/retry',
                accepted.status(),
                { retry },
                key,
            );
            const held = await hook('waitRestore', f.input);
            expect(held.attemptId).toBe(retry.id);
            expect(held.newRunId).toBe(retry.runId);
            const before = await hook('inspectWrites', f.input);
            unchangedExecution(f.originalCheckpoints, before);
            expect(before.phase).toBe('preparing');
            expect(before.attempts).toBe(1);
            expect(before.lastConfirmedPhase).toBe('preparing');
            expect(
                (
                    await hook('invalidateCheckpoint', {
                        ...f.input,
                        checkpoint,
                        fault,
                        attemptId: retry.id,
                    })
                ).rows,
            ).toBe(1);
            expect((await hook('releaseRestore', f.input)).attemptId).toBe(
                retry.id,
            );
            await expect
                .poll(
                    async () =>
                        (await postFromPage(page, f.failed + '/retry', key!))
                            .body.retry.state,
                    { timeout: 30_000, intervals: [200] },
                )
                .toBe('blocked');
            const replay = await postFromPage(page, f.failed + '/retry', key!);
            expect(replay.status).toBe(200);
            expect(replay.body.retry).toEqual({ ...retry, state: 'blocked' });
            const after = await hook('inspectWrites', f.input);
            unchangedExecution(before, after);
            expect(after.attempts).toBe(1);
            expect(after.phase).toBe('blocked');
            expect(after.lastConfirmedPhase).toBe('preparing');
            const unavailable = await page.evaluate(
                async (path) => {
                    const r = await fetch(path, { redirect: 'error' });
                    await r.body?.cancel();
                    return r.status;
                },
                '/api' + f.task + '/runs/' + encodeURIComponent(retry.runId),
            );
            expect(unavailable).toBe(404);
            expect(
                (await (await get(page, '/api' + f.task + '/runs')).json())
                    .items,
            ).toHaveLength(2);
            expect(await resultHash(page, f.prior)).toEqual(f.original);
            await state(page, f.failed, 'failed');
            const denied = await postFromPage(
                page,
                '/api' + f.task + '/runs',
                randomUUID(),
                'WEB07 denied',
            );
            expect(denied.status).toBe(409);
            expect(denied.body.error.code).toBe('task_busy');
            await page.reload();
            await expect(
                page.getByText('恢复证据不一致，等待可信侧核对。', {
                    exact: true,
                }),
            ).toBeVisible();
            await expect(
                page.getByRole('button', { name: '安全重试', exact: true }),
            ).toHaveCount(0);
            console.log(
                'A12_RETRY_BLOCKED',
                JSON.stringify({
                    attemptId: retry.id,
                    runId: retry.runId,
                    checkpoint,
                    fault,
                    workspace: after.volumeSha256,
                    history: after.historySha256,
                }),
            );
        });
    }
}
test('WEB-07-07 unknown blocks continuation and retry without execution', async ({
    page,
}) => {
    const task = await fixture(page);
    const prior = await send(page, task, 'WEB07 prior', 1);
    await state(page, prior, 'succeeded');
    const original = await resultHash(page, prior);
    const unknown = await send(page, task, 'WEB07 unknown', 2);
    await state(page, unknown, 'needs_review');
    await provePartial(task, unknown);
    const observed = await hook('inspectWrites', ids(task, unknown));
    expect(observed.sdkWriteDenied && observed.sessionWriteDenied).toBe(true);
    const continued = await postFromPage(
        page,
        '/api' + task + '/runs',
        randomUUID(),
        'WEB07 denied',
    );
    expect(continued.status).toBe(409);
    await rejectRetry(page, unknown, 'needs_review');
    await expect(
        page.getByText('上一次操作结果未确认。').first(),
    ).toBeVisible();
    await expect(
        page.getByRole('button', { name: '发送要求' }),
    ).not.toBeEnabled();
    const after = await hook('inspectWrites', ids(task, unknown));
    unchangedExecution(observed, after);
    expect(after.attempts).toBe(observed.attempts);
    expect(
        (await (await get(page, '/api' + task + '/runs')).json()).items,
    ).toHaveLength(2);
    await state(page, unknown, 'needs_review');
    expect(await resultHash(page, prior)).toEqual(original);
});
