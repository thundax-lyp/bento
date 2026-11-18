import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { expect, test, type Page, type Response } from '@playwright/test';
import type {
    Session,
    Task,
    TaskCheck,
    TaskEvent,
    TaskResult,
    TaskRun,
} from '../src/api.ts';

const continuation = process.env.BENTO_WEB_A11 === '1';
const uuidV4 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const file = 'web-a13.txt';
const original = Buffer.from('base\n');
const firstBytes = Buffer.from('base\none\n');
const secondBytes = Buffer.from('base\none\ntwo\n');
const views = ['incremental', 'cumulative'] as const;
const passed: TaskCheck = {
    name: '工作区内容检查',
    status: 'passed',
    output: '内容与预期一致',
};
const failed: TaskCheck = {
    name: '工作区内容检查',
    status: 'failed',
    output: '内容与预期不同',
};

const sha256 = (bytes: Buffer) =>
    createHash('sha256').update(bytes).digest('hex');

async function get(page: Page, path: string) {
    const response = await page.request.get(path, {
        timeout: 10_000,
        maxRedirects: 0,
    });
    expect(response.status(), 'authenticated WEB-A13 GET').toBe(200);
    return response;
}

async function json<T>(page: Page, path: string): Promise<T> {
    return (await (await get(page, path)).json()) as T;
}

function accepts(path: string) {
    return (response: Response) =>
        new URL(response.url()).pathname === path &&
        response.request().method() === 'POST';
}

async function createSnapshot(page: Page, source: string) {
    await page.goto(source);
    await page.getByLabel(file, { exact: true }).check();
    const creating = page.waitForResponse(accepts('/api/tasks'));
    await page.getByRole('button', { name: '从所选文件新建任务' }).click();
    const accepted = await creating;
    expect(accepted.status()).toBe(202);
    const { task } = (await accepted.json()) as { task: Task };
    const path = '/tasks/' + encodeURIComponent(task.id);
    await expect(page).toHaveURL(new URL(path, page.url()).href);
    await expect(page.getByLabel('任务要求')).toBeEnabled({ timeout: 180_000 });
    const ready = (await json<{ task: Task }>(page, '/api' + path)).task;
    expect(ready.status).toBe('ready');
    expect(ready.inputs).toHaveLength(1);
    expect(ready.inputs[0]).toMatchObject({
        path: file,
        bytes: original.length,
        sha256: sha256(original),
    });
    return { path, ready };
}

async function sendRound(
    page: Page,
    taskPath: string,
    sequence: number,
    prompt: string,
    replay = false,
) {
    const path = '/api' + taskPath + '/runs';
    const accepting = page.waitForResponse(accepts(path));
    await page
        .getByLabel(sequence === 1 ? '任务要求' : '后续要求')
        .fill(prompt);
    await page.getByRole('button', { name: '发送要求' }).click();
    const response = await accepting;
    expect(response.status()).toBe(202);
    const { run } = (await response.json()) as { run: TaskRun };
    expect(run.sequence).toBe(sequence);
    if (replay) {
        const originalRequest = response.request();
        const bytes = originalRequest.postDataBuffer();
        const contentType = await originalRequest.headerValue('content-type');
        const key = await originalRequest.headerValue('idempotency-key');
        if (!bytes || !contentType || !key || !uuidV4.test(key))
            throw new Error('WEB-A11 continuation request metadata missing');
        const [replayed, conflict] = await page.evaluate(
            async ({ path, bytes, contentType, key }) => {
                const headers = {
                    'content-type': contentType,
                    'idempotency-key': key,
                };
                async function send(body: Uint8Array<ArrayBuffer> | string) {
                    const response = await fetch(path, {
                        method: 'POST',
                        headers,
                        body,
                        credentials: 'same-origin',
                        redirect: 'error',
                        signal: AbortSignal.timeout(10_000),
                    });
                    return {
                        status: response.status,
                        body: await response.json(),
                    };
                }
                return [
                    await send(new Uint8Array(bytes)),
                    await send(
                        JSON.stringify({ prompt: 'WEB-A11 changed payload' }),
                    ),
                ];
            },
            { path, bytes: [...bytes], contentType, key },
        );
        expect(replayed.status).toBe(200);
        expect(run.retryOf).toBeNull();
        expect(replayed.body).toMatchObject({
            run: {
                id: run.id,
                taskId: run.taskId,
                sequence: 2,
                prompt: run.prompt,
                retryOf: null,
            },
        });
        expect(conflict).toEqual({
            status: 409,
            body: {
                error: {
                    code: 'idempotency_conflict',
                    message: '当前请求无法执行。',
                },
            },
        });
    }
    return { id: run.id, path: path + '/' + encodeURIComponent(run.id) };
}

type Round = Awaited<ReturnType<typeof sendRound>>;

async function verifyContinuationLedger(
    page: Page,
    taskId: string,
    first: Round,
    second: Round,
): Promise<void> {
    const path = '/api/tasks/' + encodeURIComponent(taskId);
    const { items: runs } = await json<{ items: TaskRun[] }>(
        page,
        path + '/runs',
    );
    expect(first.id).not.toBe(second.id);
    expect(runs).toMatchObject(
        [first, second].map(({ id }, index) => ({
            id,
            taskId,
            sequence: index + 1,
            status: 'succeeded',
            resultVersion: 1,
        })),
    );
    const eventsPath = path + '/events?after=';
    const pageOne = await json<{ items: TaskEvent[] }>(page, eventsPath + '0');
    expect(Object.keys(pageOne)).toEqual(['items']);
    expect(pageOne.items.length).toBeGreaterThan(0);
    let cursor = 0;
    const eventIds = new Set<string>();
    for (const event of pageOne.items) {
        expect(Number.isSafeInteger(event.sequence)).toBe(true);
        expect(event.sequence).toBeGreaterThan(cursor);
        expect(event.id.length).toBeGreaterThan(0);
        expect(eventIds.has(event.id)).toBe(false);
        expect([first.id, second.id]).toContain(event.runId);
        eventIds.add(event.id);
        cursor = event.sequence;
    }
    expect(await json(page, eventsPath + cursor)).toEqual({ items: [] });
    for (const run of runs) {
        expect(
            pageOne.items.filter(
                (event) =>
                    event.runId === run.id && event.kind === 'user_message',
            ),
        ).toMatchObject([{ text: run.prompt, check: null }]);
    }
    const invalid = await page.request.get(eventsPath + '-1', {
        timeout: 10_000,
        maxRedirects: 0,
    });
    expect(invalid.status()).toBe(400);
    expect(await invalid.json()).toEqual({
        error: { code: 'invalid_input', message: '任务请求内容无效。' },
    });
}

function observeContinuation(taskId: string, runId: string) {
    const root = process.env.BENTO_WEB_A11_ROOT;
    if (!root || !isAbsolute(root))
        throw new Error('WEB-A11 requires its isolated observer root');
    let observation: {
        taskId: string;
        runId: string;
        sessionDigest: string;
        workspaceDigest: string;
        bindingDigest: string;
    };
    try {
        observation = JSON.parse(
            execFileSync(
                'docker',
                [
                    'compose',
                    '-p',
                    'bento-a-web-a11',
                    '--env-file',
                    'compose.env',
                    '-f',
                    'compose.yaml',
                    '-f',
                    'web-core.yaml',
                    '-f',
                    'execution.yaml',
                    'exec',
                    '-T',
                    'orchestrator',
                    'node',
                    join(root, 'private/observe-web-a11.mjs'),
                    taskId,
                    runId,
                ],
                {
                    cwd: join(root, 'private/foundation'),
                    encoding: 'utf8',
                    timeout: 10_000,
                    stdio: ['ignore', 'pipe', 'pipe'],
                },
            ),
        ) as typeof observation;
    } catch {
        throw new Error('WEB-A11 observation rejected');
    }
    const { sessionDigest, workspaceDigest, bindingDigest } = observation;
    expect(observation.taskId).toBe(taskId);
    expect(observation.runId).toBe(runId);
    for (const digest of [sessionDigest, workspaceDigest, bindingDigest])
        expect(digest).toMatch(/^[a-f0-9]{64}$/);
    return { sessionDigest, workspaceDigest, bindingDigest };
}

async function deleteContinuationSource(
    page: Page,
    source: string,
    rounds: Round[],
) {
    await page.goto(source);
    await page.getByRole('button', { name: '删除项目', exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    const paths = [
        '/api/space/projects/' + source.split('/').at(-1),
        ...rounds.map((round) => round.path + '/results'),
    ];
    await expect
        .poll(
            async () =>
                Promise.all(
                    paths.map(async (path) =>
                        (
                            await page.request.get(path, {
                                timeout: 10_000,
                                maxRedirects: 0,
                            })
                        ).status(),
                    ),
                ),
            { timeout: 120_000 },
        )
        .toEqual(paths.map(() => 404));
}

async function awaitResult(page: Page, round: Round) {
    let status: TaskRun['status'] | undefined;
    await expect
        .poll(
            async () => {
                const { run } = await json<{ run: TaskRun }>(page, round.path);
                expect(run.id).toBe(round.id);
                status = run.status;
                return [
                    'succeeded',
                    'failed',
                    'cancelled',
                    'needs_review',
                ].includes(status);
            },
            {
                intervals: [2000],
                timeout: 180_000,
                message: 'Run reaches a terminal observation',
            },
        )
        .toBe(true);
    expect(status).toBe('succeeded');
    await page.getByLabel('执行轮次').selectOption(round.id);
    await expect(page.getByLabel('执行轮次')).toHaveValue(round.id);
}

async function readResult(page: Page, round: Round) {
    const resultPath = round.path + '/results';
    const resultBody = await (await get(page, resultPath)).body();
    const { result } = JSON.parse(resultBody.toString('utf8')) as {
        result: TaskResult;
    };
    expect(result.runId).toBe(round.id);
    expect(result.version).toBe(1);
    expect(result.summary.trim().length > 0, 'published summary').toBe(true);
    const patches = await Promise.all(
        views.map(async (view) => {
            const path = resultPath + '/1/diff?view=' + view;
            const preview = await get(page, path);
            const attachment = await get(page, path + '&download=1');
            expect(attachment.headers()['content-disposition']).toBe(
                'attachment; filename="changes.patch"',
            );
            const bytes = await preview.body();
            expect(
                (await attachment.body()).equals(bytes),
                'preview and attachment bytes agree',
            ).toBe(true);
            const hash = sha256(bytes);
            expect(hash).toBe(
                view === 'incremental'
                    ? result.incrementalSha256
                    : result.cumulativeSha256,
            );
            return { view, path, bytes, hash };
        }),
    );
    return { result, resultBody, patches };
}

type ReadResult = Awaited<ReturnType<typeof readResult>>;

async function applyPatch(bytes: Buffer, before: Buffer, after: Buffer) {
    const directory = await mkdtemp(join(tmpdir(), 'bento-web-a13-'));
    try {
        await writeFile(join(directory, file), before);
        const applied = spawnSync('git', ['apply', '-'], {
            cwd: directory,
            input: bytes,
            env: {
                ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: '/dev/null',
            },
            timeout: 10_000,
        });
        expect(applied.status, 'git apply succeeds').toBe(0);
        expect(await readdir(directory)).toEqual([file]);
        expect(
            (await readFile(join(directory, file))).equals(after),
            'patched bytes agree with expected snapshot',
        ).toBe(true);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

async function verifyPage(
    page: Page,
    saved: ReadResult,
    expectedChecks: TaskCheck[],
    before: Buffer,
    after: Buffer,
) {
    expect(saved.result.checks).toEqual(expectedChecks);
    await expect(
        page.getByText(saved.result.summary, { exact: true }).first(),
    ).toBeVisible();
    const checks = page
        .getByRole('heading', { name: '检查结果' })
        .locator('..')
        .getByRole('listitem')
        .filter({ hasText: passed.name });
    await expect(checks).toHaveCount(expectedChecks.length);
    for (const [index, check] of expectedChecks.entries()) {
        const item = checks.nth(index);
        await expect(item).toContainText(
            check.name + ' · ' + (check.status === 'passed' ? '通过' : '失败'),
        );
        await expect(item.locator('pre')).toHaveText(check.output ?? '');
    }
    for (const patch of saved.patches) {
        await page.getByLabel('补丁范围').selectOption(patch.view);
        const download = page.getByRole('link', { name: '下载 diff' });
        await expect(download).toHaveAttribute(
            'href',
            patch.path + '&download=1',
        );
        const changes = page.getByRole('list', { name: '变更文件' });
        await expect(changes.getByRole('listitem')).toHaveCount(1);
        const changed = changes.getByRole('button', { name: '修改 ' + file });
        await changed.click();
        await expect(changed).toHaveAttribute('aria-pressed', 'true');
        const lines = page.getByLabel('逐行变更');
        const hasTwo = after.equals(secondBytes);
        const hasOne = !hasTwo || patch.view === 'cumulative';
        await expect(lines.getByText('+one', { exact: true })).toHaveCount(
            hasOne ? 1 : 0,
        );
        await expect(lines.getByText('+two', { exact: true })).toHaveCount(
            hasTwo ? 1 : 0,
        );
        await applyPatch(
            patch.bytes,
            patch.view === 'incremental' ? before : original,
            after,
        );
        if (patch.view === 'cumulative') {
            const pending = page.waitForEvent('download');
            await download.click();
            const artifact = await pending;
            expect(artifact.suggestedFilename()).toBe('changes.patch');
            const path = await artifact.path();
            expect(
                (await readFile(path)).equals(patch.bytes),
                'browser download matches response bytes',
            ).toBe(true);
            await artifact.delete();
        }
    }
}

test('WEB-A13 real DSH result delivery', async ({
    page,
    browser,
    baseURL,
    storageState,
}) => {
    if (
        !baseURL ||
        !storageState ||
        process.env.BENTO_WEB_A13_LIST_ONLY === '1'
    )
        throw new Error(
            'WEB-A13 requires the isolated deployment and authenticated storage state',
        );
    const { account } = await json<Session>(page, '/api/session');
    expect(
        typeof account === 'string' && account.length > 0,
        'isolated account authenticated',
    ).toBe(true);

    const project = 'WEB-A13 ' + randomUUID();
    await page.goto('/workspaces');
    await page.getByLabel('空间项目名称').fill(project);
    await page.getByRole('button', { name: '新建空间项目' }).click();
    await expect(page).toHaveURL(/\/space\/[^/?]+$/);
    const source = new URL(page.url()).pathname;
    await page.getByLabel('文件', { exact: true }).setInputFiles({
        name: file,
        mimeType: 'text/plain',
        buffer: original,
    });
    await page.getByRole('button', { name: '确认上传' }).click();
    await expect(page.getByRole('list', { name: '上传结果' })).toContainText(
        '已保存',
    );

    const task = await createSnapshot(page, source);
    const first = await sendRound(
        page,
        task.path,
        1,
        '只修改 web-a13.txt。在现有 base 行之后追加 one 和换行。保存后只调用一次 bento_workspace_check，path 为 web-a13.txt，expected 为 "base\\none\\n"。给出简短公开结论。',
    );
    await page.close();

    const reopened = await browser.newContext({ baseURL, storageState });
    try {
        const active = await reopened.newPage();
        await active.goto('/runs');
        const taskLink = active
            .getByRole('list', { name: '任务', exact: true })
            .getByRole('link', { name: project, exact: true });
        await expect(taskLink).toHaveAttribute('href', task.path);
        await taskLink.click();
        await awaitResult(active, first);
        const savedFirst = await readResult(active, first);
        await verifyPage(active, savedFirst, [passed], original, firstBytes);

        const second = await sendRound(
            active,
            task.path,
            2,
            '先读取 web-a13.txt，确认并保留第一轮的 one 行。只追加 two 和换行。保存后按顺序各调用一次 bento_workspace_check，path 均为 web-a13.txt，expected 依次为 "base\\none\\n" 和 "base\\none\\ntwo\\n"。第一次预期失败，继续完成第二次检查，再给出简短公开结论。',
            continuation,
        );
        await awaitResult(active, second);
        const savedSecond = await readResult(active, second);
        await verifyPage(
            active,
            savedSecond,
            [failed, passed],
            firstBytes,
            secondBytes,
        );

        if (continuation) {
            await verifyContinuationLedger(
                active,
                task.ready.id,
                first,
                second,
            );
            const firstBinding = observeContinuation(task.ready.id, first.id);
            expect(observeContinuation(task.ready.id, second.id)).toEqual(
                firstBinding,
            );
        }

        await active.getByLabel('执行轮次').selectOption(first.id);
        const old = await readResult(active, first);
        expect(
            old.resultBody.equals(savedFirst.resultBody),
            'first-round result still matches',
        ).toBe(true);
        for (const patch of old.patches) {
            const prior = savedFirst.patches.find(
                (item) => item.view === patch.view,
            );
            expect(prior?.hash).toBe(patch.hash);
            expect(
                prior?.bytes.equals(patch.bytes),
                'first-round patch still matches',
            ).toBe(true);
        }

        if (continuation)
            await verifyPage(active, old, [passed], original, firstBytes);

        const readOnly = await createSnapshot(active, source);
        expect(readOnly.ready.id).not.toBe(task.ready.id);
        expect(readOnly.ready.inputs).toEqual(task.ready.inputs);
        const readRound = await sendRound(
            active,
            readOnly.path,
            1,
            '仅阅读 web-a13.txt 并公开报告第一行（base），不要写文件或调用检查工具。',
        );
        await awaitResult(active, readRound);
        const readResultOnly = await readResult(active, readRound);
        expect(
            readResultOnly.result.summary.includes('base'),
            'read-only conclusion includes base',
        ).toBe(true);
        await expect(active.getByText('无检查记录。')).toBeVisible();
        await expect(active.getByText('这次任务没有文件变更。')).toBeVisible();
        expect(readResultOnly.result.checks).toEqual([]);
        for (const patch of readResultOnly.patches) {
            expect(patch.bytes.length).toBe(0);
            expect(patch.hash).toBe(sha256(Buffer.alloc(0)));
        }
        if (continuation)
            await deleteContinuationSource(active, source, [
                first,
                second,
                readRound,
            ]);
        console.log(
            'WEB-A13 delivery checks passed',
            [...savedFirst.patches, ...savedSecond.patches].map(
                ({ hash }) => hash,
            ),
        );
    } finally {
        await reopened.close();
    }
});
