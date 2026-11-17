import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { expect, test, type Page, type Response } from '@playwright/test';
import type { Session, Task, TaskResult, TaskRun } from '../src/api.ts';

const first = 'web05-first.txt';
const second = 'web05-second.txt';
const sha256 = (bytes: Buffer) =>
    createHash('sha256').update(bytes).digest('hex');
const taskPath = (id: string) => '/tasks/' + encodeURIComponent(id);
const runPath = (run: TaskRun) =>
    '/api' + taskPath(run.taskId) + '/runs/' + encodeURIComponent(run.id);

type Observation = {
    matched: boolean;
    status: string;
    reserved: boolean;
    entered: boolean;
};

type Attestation = {
    matched: boolean;
    versionMatches: boolean;
    bindingDigest: string;
    markerCount: number;
    firstMatches: boolean;
    secondPresent: boolean;
    credentialsPresent: boolean;
};

function runnerRoot() {
    const root = process.env.BENTO_WEB05_ROOT;
    if (!root || !isAbsolute(root))
        throw new Error('WEB-05 requires its isolated runner');
    return root;
}

function callRunner(args: string[], input?: string) {
    try {
        return execFileSync('bash', ['web05/acceptance/run.sh', ...args], {
            cwd: runnerRoot(),
            input,
            encoding: 'utf8',
            timeout: 90_000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch {
        throw new Error('WEB-05 private control failed: ' + args[0]);
    }
}

function observe(taskId: string, runId: string): Observation {
    return JSON.parse(callRunner(['observe', taskId, runId])) as Observation;
}

function attest(task: Task, run?: TaskRun): Attestation {
    const proof = JSON.parse(
        callRunner(['attest', task.id, run?.id ?? '-']),
    ) as Attestation;
    expect(proof).toMatchObject({
        matched: true,
        versionMatches: true,
        credentialsPresent: false,
    });
    return proof;
}

async function get(page: Page, path: string) {
    const response = await page.request.get(path, {
        timeout: 10_000,
        maxRedirects: 0,
    });
    expect(response.status(), 'authenticated WEB-05 read').toBe(200);
    return response;
}

async function json<T>(page: Page, path: string): Promise<T> {
    return (await (await get(page, path)).json()) as T;
}

function posted(path: string) {
    return (response: Response) =>
        new URL(response.url()).pathname === path &&
        response.request().method() === 'POST';
}

async function replay<T>(
    page: Page,
    path: string,
    submit: () => Promise<void>,
    accepted: (value: T) => void,
    beforeFetchReplay?: () => Promise<void>,
) {
    const receipts: {
        status: number;
        key: string | undefined;
        body: string | null;
        bytes: number[] | undefined;
        contentType: string | undefined;
        value: T;
    }[] = [];
    await page.route(
        (url) => url.pathname === path,
        async (route) => {
            if (route.request().method() !== 'POST') return route.continue();
            const response = await route.fetch({ maxRetries: 0 });
            const value = (await response.json()) as T;
            receipts.push({
                status: response.status(),
                key: route.request().headers()['idempotency-key'],
                body: route.request().postData(),
                bytes: route.request().postDataBuffer()?.toJSON().data,
                contentType: route.request().headers()['content-type'],
                value,
            });
            if (receipts.length === 1) {
                accepted(value);
                await route.abort('failed');
            } else {
                await route.fulfill({ response });
            }
        },
    );
    try {
        await submit();
        await expect.poll(() => receipts.length).toBe(1);
        if (beforeFetchReplay) {
            await beforeFetchReplay();
            const first = receipts[0];
            if (!first?.key || !first.contentType || !first.bytes)
                throw new Error('WEB-05 missing original request data');
            await page.unroute((url) => url.pathname === path);
            const reply = await page.evaluate(
                async ({ path, key, contentType, bytes }) => {
                    const response = await fetch(path, {
                        method: 'POST',
                        headers: {
                            'content-type': contentType,
                            'idempotency-key': key,
                        },
                        body: new Uint8Array(bytes),
                        redirect: 'error',
                    });
                    return {
                        status: response.status,
                        value: await response.json(),
                    };
                },
                {
                    path,
                    key: first.key,
                    contentType: first.contentType,
                    bytes: first.bytes,
                },
            );
            receipts.push({ ...first, ...reply });
        } else {
            await submit();
        }
        await expect.poll(() => receipts.length).toBe(2);
        expect(receipts.map((value) => value.status)).toEqual([202, 200]);
        const [first, replayed] = receipts;
        if (!first || !replayed)
            throw new Error('WEB-05 replay receipts missing');
        expect(first.key).toMatch(/^[a-f0-9-]{36}$/);
        expect(replayed.key).toBe(first.key);
        expect(replayed.body).toBe(first.body);
        expect(
            Object.hasOwn(JSON.parse(first.body ?? '{}'), 'environmentVersion'),
        ).toBe(false);
        return [first.value, replayed.value] as const;
    } finally {
        await page.unroute((url) => url.pathname === path);
    }
}

async function loadTask(page: Page, taskId: string) {
    return (await json<{ task: Task }>(page, '/api' + taskPath(taskId))).task;
}

async function waitTask(page: Page, task: Task, status: Task['status']) {
    await expect
        .poll(async () => (await loadTask(page, task.id)).status, {
            timeout: 90_000,
        })
        .toBe(status);
    return loadTask(page, task.id);
}

async function createBlank(page: Page, name: string, dropReceipt = false) {
    await page.goto('/');
    await page.getByLabel('任务名称').fill(name);
    const submit = () =>
        page.getByRole('button', { name: '创建空白任务' }).click();
    let task: Task;
    if (dropReceipt) {
        const replies = await replay<{ task: Task }>(
            page,
            '/api/tasks',
            submit,
            () => {},
        );
        task = replies[0].task;
        expect(replies[1].task).toMatchObject({
            id: task.id,
            environmentVersion: task.environmentVersion,
        });
    } else {
        const response = page.waitForResponse(posted('/api/tasks'));
        await submit();
        task = await acceptedTask(await response);
    }
    await expect(page).toHaveURL(new URL(taskPath(task.id), page.url()).href);
    return task;
}

async function acceptedTask(response: Response) {
    expect(response.status()).toBe(202);
    const input = response.request().postDataJSON() as object;
    expect(Object.hasOwn(input, 'environmentVersion')).toBe(false);
    return ((await response.json()) as { task: Task }).task;
}

async function snapshot(page: Page, names: string[]) {
    for (const name of names)
        await page.getByLabel(name, { exact: true }).check();
    const accepting = page.waitForResponse(posted('/api/tasks'));
    await page.getByRole('button', { name: '从所选文件新建任务' }).click();
    const task = await acceptedTask(await accepting);
    await expect(page).toHaveURL(new URL(taskPath(task.id), page.url()).href);
    return task;
}

async function upload(page: Page, name: string, contents: string) {
    await page.getByLabel('文件', { exact: true }).setInputFiles({
        name,
        mimeType: 'text/plain',
        buffer: Buffer.from(contents),
    });
    await page.getByRole('button', { name: '确认上传' }).click();
    const saved = page.getByRole('list', { name: '上传结果' });
    await expect(saved).toContainText(name);
    await expect(saved).toContainText('已保存');
}

async function send(page: Page, task: Task, prompt: string, sequence = 1) {
    await page
        .getByLabel(sequence === 1 ? '任务要求' : '后续要求')
        .fill(prompt);
    const accepting = page.waitForResponse(
        posted('/api' + taskPath(task.id) + '/runs'),
    );
    await page.getByRole('button', { name: '发送要求' }).click();
    const response = await accepting;
    expect(response.status()).toBe(202);
    const { run } = (await response.json()) as { run: TaskRun };
    expect(run).toMatchObject({ taskId: task.id, sequence });
    return run;
}

async function result(
    page: Page,
    run: TaskRun,
    surfaces: string[],
    markerCount: number,
) {
    await expect
        .poll(
            async () =>
                (await json<{ run: TaskRun }>(page, runPath(run))).run.status,
            { timeout: 150_000 },
        )
        .toBe('succeeded');
    const path = runPath(run) + '/results';
    const body = await (await get(page, path)).text();
    const { result } = JSON.parse(body) as { result: TaskResult };
    expect(result).toMatchObject({ runId: run.id, version: 1 });
    expect(result.summary.trim().length > 0).toBe(true);
    surfaces.push(body);
    const patch = path + '/1/diff?view=cumulative';
    const downloaded = await get(page, patch + '&download=1');
    expect(downloaded.headers()['content-disposition']).toBe(
        'attachment; filename="changes.patch"',
    );
    const bytes = await downloaded.body();
    expect(sha256(bytes)).toBe(result.cumulativeSha256);
    expect(
        bytes
            .toString()
            .split('\n')
            .filter((line) => line === '+first' || line === '+second'),
    ).toHaveLength(markerCount);
    surfaces.push(
        bytes.toString(),
        await (
            await get(page, '/api' + taskPath(run.taskId) + '/events')
        ).text(),
    );
}

async function prepare(page: Page, task: Task) {
    const path = '/api' + taskPath(task.id) + '/prepare';
    const receipts = await page.evaluate(
        (url) =>
            Promise.all(
                [0, 1].map(async () => {
                    const response = await fetch(url, {
                        method: 'POST',
                        credentials: 'same-origin',
                    });
                    return {
                        status: response.status,
                        body: (await response.json()) as { task: Task },
                    };
                }),
            ),
        path,
    );
    for (const { status, body } of receipts) {
        expect(status).toBe(200);
        expect(body.task).toMatchObject({
            id: task.id,
            inputDigest: task.inputDigest,
            environmentVersion: task.environmentVersion,
        });
    }
    return waitTask(page, task, 'ready');
}

test('WEB-05 real execution environment', async ({
    page,
    browser,
    baseURL,
    storageState,
}) => {
    if (!baseURL || !storageState)
        throw new Error('WEB-05 requires an isolated authenticated deployment');
    const surfaces: string[] = [];
    const { account } = await json<Session>(page, '/api/session');
    expect(typeof account).toBe('string');
    if (!account) throw new Error('WEB-05 requires the invited account');
    const { ownerId } = JSON.parse(
        readFileSync(
            join(runnerRoot(), 'web05/acceptance/acceptance-owner.json'),
            'utf8',
        ),
    ) as { ownerId?: string };
    if (!ownerId || !/^[a-f0-9]{48}$/.test(ownerId) || ownerId === account) {
        throw new Error('WEB-05 requires its trusted invitation owner binding');
    }
    expect((await json<{ items: Task[] }>(page, '/api/tasks')).items).toEqual(
        [],
    );
    expect(
        (await json<{ projects: unknown[] }>(page, '/api/space')).projects,
    ).toEqual([]);

    const blank = await createBlank(page, 'WEB-05 blank ' + randomUUID(), true);
    expect(blank.inputs).toEqual([]);
    await waitTask(page, blank, 'ready');
    callRunner(['active-pause', blank.id]);
    await page.getByLabel('任务要求').fill('WEB05 blank');
    let watcher: ReturnType<typeof spawn> | undefined;
    let watched: Promise<number | null> | undefined;
    try {
        const [firstReceipt, replayed] = await replay<{ run: TaskRun }>(
            page,
            '/api' + taskPath(blank.id) + '/runs',
            () => page.getByRole('button', { name: '发送要求' }).click(),
            ({ run }) => {
                watcher = spawn(
                    'bash',
                    [
                        'web05/acceptance/run.sh',
                        'watch-active',
                        blank.id,
                        run.id,
                    ],
                    {
                        cwd: runnerRoot(),
                        stdio: 'ignore',
                    },
                );
                watched = once(watcher, 'exit').then(
                    ([code]) => code as number | null,
                    () => null,
                );
            },
            async () => {
                await expect(
                    page.getByRole('status').filter({ hasText: '运行中' }),
                ).toBeVisible();
                await expect(
                    page.getByRole('button', { name: '发送要求' }),
                ).toBeDisabled();
            },
        );
        const run = firstReceipt.run;
        expect(replayed.run.id).toBe(run.id);
        await expect
            .poll(() => observe(blank.id, run.id), { timeout: 35_000 })
            .toMatchObject({
                matched: true,
                status: 'running',
                reserved: true,
                entered: true,
            });
        expect(
            (
                await json<{ items: TaskRun[] }>(
                    page,
                    '/api' + taskPath(blank.id) + '/runs',
                )
            ).items,
        ).toHaveLength(1);
        surfaces.push(await page.content());
        await page.close();
        callRunner(['active-release', blank.id, run.id]);
        expect(await watched).toBe(0);
        await expect
            .poll(() => observe(blank.id, run.id).status, { timeout: 150_000 })
            .toBe('succeeded');
        const resumed = await browser.newContext({ baseURL, storageState });
        try {
            const active = await resumed.newPage();
            await active.goto('/runs');
            const link = active
                .getByRole('list', { name: '任务', exact: true })
                .getByRole('link', { name: blank.name });
            await expect(link).toHaveAttribute('href', taskPath(blank.id));
            await link.click();
            await result(active, run, surfaces, 1);
            expect(attest(blank, run).markerCount).toBe(1);

            const failedName = 'WEB-05 prepare ' + randomUUID();
            callRunner(['fail-prepare', ownerId, failedName]);
            const failed = await createBlank(active, failedName);
            await waitTask(active, failed, 'failed');
            await expect(active.getByText('任务准备失败。')).toBeVisible();
            callRunner(['bind-prepare', failed.id]);
            callRunner(['clear-prepare', failed.id]);
            const repaired = await prepare(active, failed);
            expect(attest(repaired).markerCount).toBe(0);
            const repairedRun = await send(active, repaired, 'WEB05 blank');
            await result(active, repairedRun, surfaces, 1);

            const projectName = 'WEB-05 snapshot ' + randomUUID();
            await active.goto('/workspaces');
            await active.getByLabel('空间项目名称').fill(projectName);
            await active.getByRole('button', { name: '新建空间项目' }).click();
            await expect(active).toHaveURL(/\/space\/[^/?]+$/);
            const source = new URL(active.url()).pathname;
            await upload(active, first, 'base\n');

            callRunner(['fail-prepare', ownerId, projectName]);
            const originalFailure = await snapshot(active, [first]);
            const recorded = await waitTask(active, originalFailure, 'failed');
            callRunner(['bind-prepare', recorded.id]);
            await active.goto(source);
            const frozen = await snapshot(active, [first]);
            await waitTask(active, frozen, 'ready');
            expect(frozen.inputs).toHaveLength(1);
            expect(frozen.inputs[0]).toMatchObject({
                path: first,
                sha256: sha256(Buffer.from('base\n')),
            });
            const initial = attest(frozen);
            callRunner(['hold', frozen.id]);
            const queued = await send(active, frozen, 'WEB05 frozen');
            expect(observe(frozen.id, queued.id)).toMatchObject({
                status: 'queued',
                reserved: false,
            });
            await active.goto(source);
            await upload(active, second, 'new\n');
            await active.reload();
            await expect(
                active.getByLabel(second, { exact: true }),
            ).toBeVisible();
            callRunner(['rotate', frozen.id, queued.id]);
            expect(observe(frozen.id, queued.id)).toMatchObject({
                status: 'queued',
                reserved: false,
            });
            callRunner(['release', frozen.id, queued.id]);
            await active.goto(taskPath(frozen.id));
            await result(active, queued, surfaces, 1);
            expect(attest(frozen, queued)).toMatchObject({
                bindingDigest: initial.bindingDigest,
                markerCount: 1,
                firstMatches: true,
                secondPresent: false,
            });
            const continued = await send(active, frozen, 'WEB05 continue', 2);
            await result(active, continued, surfaces, 2);
            expect(attest(frozen, continued)).toMatchObject({
                bindingDigest: initial.bindingDigest,
                markerCount: 2,
            });

            await active.goto(taskPath(recorded.id));
            await active
                .getByRole('button', { name: '更换输入或环境，另建任务' })
                .click();
            await active.getByRole('link', { name: '确认另建' }).click();
            await expect(active).toHaveURL(new URL(source, active.url()).href);
            const independent = await snapshot(active, [first, second]);
            expect(independent.id).not.toBe(recorded.id);
            expect(independent.inputDigest).not.toBe(recorded.inputDigest);
            expect(independent.environmentVersion).not.toBe(
                recorded.environmentVersion,
            );
            await waitTask(active, independent, 'ready');
            const onlyRead = await send(active, independent, 'WEB05 isolated');
            await result(active, onlyRead, surfaces, 0);
            const separate = attest(independent, onlyRead);
            expect(separate).toMatchObject({
                markerCount: 0,
                firstMatches: true,
                secondPresent: true,
            });
            expect(separate.bindingDigest).not.toBe(initial.bindingDigest);

            await active.goto(taskPath(recorded.id));
            expect(await loadTask(active, recorded.id)).toMatchObject({
                id: recorded.id,
                inputDigest: recorded.inputDigest,
                environmentVersion: recorded.environmentVersion,
                status: 'failed',
                prepareError: recorded.prepareError,
            });
            callRunner(['clear-prepare', recorded.id]);
            const historical = await prepare(active, recorded);
            expect(attest(historical)).toMatchObject({
                firstMatches: true,
                secondPresent: false,
                markerCount: 0,
            });
            surfaces.push(
                await active.content(),
                await (
                    await get(active, '/api' + taskPath(recorded.id))
                ).text(),
            );
            expect(
                JSON.parse(callRunner(['scan'], JSON.stringify(surfaces))),
            ).toEqual({ positiveCount: 1, matchCount: 0 });
        } finally {
            await resumed.close();
        }
    } finally {
        if (watcher?.exitCode === null) watcher.kill();
    }
});
