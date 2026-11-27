import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Task, TaskRun } from '@workspace-web/api.ts';
import type { Space } from '@workspace-web/space/api.ts';
import { startQueueIsolationFixture } from './queue-isolation-fixture.ts';

let fixture: Awaited<ReturnType<typeof startQueueIsolationFixture>>;
test.beforeEach(async () => {
    fixture = await startQueueIsolationFixture();
});
test.afterEach(async () => {
    await fixture?.close();
});
const origin = 'http://127.0.0.1:4364';
const headers = (key: string = randomUUID()) => ({
    Origin: origin,
    'Idempotency-Key': key,
});
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function get<T>(page: Page, path: string): Promise<T> {
    const response = await page.request.get(path);
    expect(response.status()).toBe(200);
    return response.json() as Promise<T>;
}
async function login(page: Page, account: string) {
    const password = randomUUID();
    await page.goto('/login');
    await page.getByRole('link', { name: '使用邀请码注册' }).click();
    const form = page.locator('form').filter({
        has: page.getByRole('heading', { name: '受邀注册', exact: true }),
    });
    await form.getByLabel('账号').fill(account);
    await form.getByLabel('邀请码').fill('demo-invite');
    await form.getByLabel('新密码').fill(password);
    await form.getByRole('button', { name: '注册', exact: true }).click();
    await expect(page).toHaveURL(/\/login(?:\?|$)/);
    await page.getByLabel('账号').fill(account);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByLabel('任务名称')).toBeVisible();
}
async function blank(page: Page, name: string) {
    await page.goto('/');
    await page.getByLabel('任务名称').fill(name);
    const response = page.waitForResponse(
        (r) =>
            new URL(r.url()).pathname === '/api/tasks' &&
            r.request().method() === 'POST',
    );
    await page
        .getByRole('button', { name: '创建空白任务', exact: true })
        .click();
    const receipt = await response;
    expect(receipt.status()).toBe(202);
    const { task } = (await receipt.json()) as { task: Task };
    await expect(page.getByLabel('任务要求')).toBeEnabled();
    return task.id;
}
async function send(page: Page, taskId: string, status = 202) {
    await page.goto('/tasks/' + taskId);
    await expect(page.getByLabel('任务要求')).toBeEnabled();
    await page.getByLabel('任务要求').fill('noop');
    const response = page.waitForResponse(
        (r) =>
            new URL(r.url()).pathname === `/api/tasks/${taskId}/runs` &&
            r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '发送要求', exact: true }).click();
    const receipt = await response;
    expect(receipt.status()).toBe(status);
    return {
        json: (await receipt.json()) as {
            run?: TaskRun;
            error?: { code: string; message: string };
        },
        key: receipt.request().headers()['idempotency-key']!,
        body: receipt.request().postDataJSON() as { prompt: string },
    };
}
async function run(page: Page, task: string, id: string) {
    return (await get<{ run: TaskRun }>(page, `/api/tasks/${task}/runs/${id}`))
        .run;
}
function report(
    phase: string,
    snapshot: Awaited<ReturnType<typeof fixture.observe>>,
) {
    console.log('WEB-A09', phase, {
        active: snapshot.activeWorkers,
        peak: snapshot.peakWorkers,
        entered: snapshot.enteredRuns.length,
        occupied: snapshot.occupied.length,
        owners: fixture.accounts.map((account, index) => ({
            tenant: ['A', 'B', 'C'][index],
            ...snapshot.owners[account.ownerId],
        })),
    });
}

test('WEB-A09: three authenticated tenants isolate queue capacity from physical multipart uploads', async ({
    browser,
}) => {
    const contexts = await Promise.all([
        browser.newContext(),
        browser.newContext(),
        browser.newContext(),
    ]);
    const [a, b, c] = await Promise.all(
        contexts.map((context) => context.newPage()),
    );
    expect(a && b && c).toBeTruthy();
    if (!a || !b || !c) throw Error('Three pages required');
    const [accountA, accountB, accountC] = fixture.accounts;
    if (!accountA || !accountB || !accountC)
        throw Error('Three identities required');
    const owner = [accountA.ownerId, accountB.ownerId, accountC.ownerId];
    const accepted: { page: Page; task: string; id: string }[] = [];
    const big = Buffer.alloc(100_000_000, 97);
    const checksums = Array.from({ length: 6 }, (_, index) =>
        createHash('sha256')
            .update(
                big.subarray(
                    index * 16_777_216,
                    Math.min(big.length, (index + 1) * 16_777_216),
                ),
            )
            .digest('base64'),
    );
    const small = {
        id: randomUUID(),
        path: 'small.txt',
        size: 1,
        checksums: [createHash('sha256').update('x').digest('base64')],
    };
    let tasks: string[] = [];
    let projectId = '';
    let firstUpload = '';
    const secondUpload = randomUUID();
    const selection = await mkdtemp(join(tmpdir(), 'bento-queue-selection-'));
    try {
        await test.step('three independent registered sessions create isolated ready Tasks', async () => {
            for (const [page, account] of [
                [a, accountA],
                [b, accountB],
                [c, accountC],
            ] as const)
                await login(page, account.account);
            tasks = [
                await blank(a, 'A0'),
                await blank(a, 'A1'),
                await blank(a, 'A2'),
                await blank(a, 'A3'),
                await blank(b, 'B0'),
                await blank(c, 'C0'),
            ];
            for (const [index, page] of [a, b, c].entries()) {
                const list = await get<{ items: Task[] }>(page, '/api/tasks');
                expect(list.items.map((t) => t.name).sort()).toEqual(
                    index === 0
                        ? ['A0', 'A1', 'A2', 'A3']
                        : [index === 1 ? 'B0' : 'C0'],
                );
            }
            expect(
                (await b.request.get('/api/tasks/' + tasks[0])).status(),
            ).toBe(404);
            expect(
                (await c.request.get('/api/tasks/' + tasks[0])).status(),
            ).toBe(404);
            const snapshot = await fixture.observe();
            expect(snapshot.activeWorkers).toBe(0);
            expect(snapshot.occupied).toEqual([]);
            expect(snapshot.queued).toEqual([]);
            owner.forEach((id, index) =>
                expect(snapshot.owners[id]).toEqual({
                    tasks: index ? 1 : 4,
                    creationReceipts: index ? 1 : 4,
                    runs: 0,
                    events: 0,
                    retryAttempts: 0,
                    queued: 0,
                }),
            );
            report('ready-empty', snapshot);
        });
        const uploadPage = await contexts[0]!.newPage();
        const quotaPage = await contexts[0]!.newPage();
        await test.step('100 MB physical multipart is held in flight with zero occupied execution slots', async () => {
            const before = await fixture.observe();
            await uploadPage.goto('/workspaces');
            await uploadPage.getByLabel('空间项目名称').fill('Queue upload');
            const created = uploadPage.waitForResponse(
                (r) =>
                    new URL(r.url()).pathname === '/api/space/projects' &&
                    r.request().method() === 'POST',
            );
            await uploadPage
                .getByRole('button', { name: '新建空间项目', exact: true })
                .click();
            projectId = ((await (await created).json()) as { id: string }).id;
            await expect(
                uploadPage.getByRole('heading', {
                    name: '上传文件',
                    exact: true,
                }),
            ).toBeVisible();
            const selectedPath = join(selection, 'big.bin');
            await writeFile(selectedPath, big);
            await uploadPage
                .getByLabel('文件', { exact: true })
                .setInputFiles(selectedPath);
            const registered = uploadPage.waitForResponse(
                (r) =>
                    new URL(r.url()).pathname ===
                        `/api/space/projects/${projectId}/uploads` &&
                    r.request().method() === 'POST',
            );
            await uploadPage
                .getByRole('button', { name: '确认上传', exact: true })
                .click();
            expect((await registered).status()).toBe(200);
            firstUpload = ((await (await registered).json()) as { id: string })
                .id;
            expect(await fixture.storage.waitHeldPart()).toEqual({
                key: 'space/' + firstUpload,
                number: 1,
                bytes: 16_777_216,
            });
            expect(fixture.storage.observe().inFlight).toBeGreaterThanOrEqual(
                1,
            );
            const space = await get<Space>(a, '/api/space');
            expect(space.reserved).toBe(100_000_000);
            expect(space.saved).toBe(0);
            expect(
                space.uploads.find((u) => u.id === firstUpload)?.state,
            ).not.toBe('saved');
            expect(await fixture.observe()).toEqual(before);
            // Wait for the three non-held parts of transferFile's four-part batch.
            await expect
                .poll(() => fixture.storage.observe().partsWritten)
                .toBe(3);
            report('upload-in-flight-zero-slot', before);
        });
        await test.step('200 MB reservation rejects a further byte independently in API and page', async () => {
            const before = await fixture.observe();
            const response = await a.request.post(
                `/api/space/projects/${projectId}/uploads`,
                {
                    headers: headers(),
                    data: {
                        id: secondUpload,
                        path: 'second.bin',
                        size: big.length,
                        checksums,
                    },
                },
            );
            expect(response.status()).toBe(200);
            const space = await get<Space>(a, '/api/space');
            expect(space.reserved).toBe(200_000_000);
            const storage = fixture.storage.observe();
            const rejected = await a.request.post(
                `/api/space/projects/${projectId}/uploads`,
                { headers: headers(), data: small },
            );
            expect(rejected.status()).toBe(409);
            expect(await rejected.json()).toEqual({
                error: {
                    code: 'space_quota',
                    message: '账号空间不足，已保存和上传预占合计最多 200 MB。',
                },
            });
            expect(await get<Space>(a, '/api/space')).toEqual(space);
            expect(fixture.storage.observe()).toEqual(storage);
            await quotaPage.goto('/space/' + projectId);
            const writes: string[] = [];
            quotaPage.on('request', (r) => {
                if (r.method() === 'POST')
                    writes.push(new URL(r.url()).pathname);
            });
            await quotaPage.getByLabel('文件', { exact: true }).setInputFiles({
                name: small.path,
                mimeType: 'text/plain',
                buffer: Buffer.from('x'),
            });
            await expect(
                quotaPage.getByRole('region', { name: '上传前清单' }),
            ).toContainText('账号可用额度不足。');
            await expect(
                quotaPage.getByRole('button', {
                    name: '确认上传',
                    exact: true,
                }),
            ).toBeDisabled();
            expect(writes).toEqual([]);
            expect(await fixture.observe()).toEqual(before);
            console.log('WEB-A09 quota', {
                status: 409,
                code: 'space_quota',
                reserved: space.reserved,
            });
        });
        let firstReceipt!: Awaited<ReturnType<typeof send>>;
        let rejectedReceipt!: Awaited<ReturnType<typeof send>>;
        await test.step('A running plus two queued reaches queue limit; rejection has no writes', async () => {
            const initial = await send(a, tasks[0]!);
            const id = initial.json.run!.id;
            accepted.push({ page: a, task: tasks[0]!, id });
            await expect
                .poll(async () => (await fixture.observe()).enteredRuns)
                .toEqual([id]);
            await expect
                .poll(async () => (await run(a, tasks[0]!, id)).status)
                .toBe('running');
            firstReceipt = await send(a, tasks[1]!);
            accepted.push({
                page: a,
                task: tasks[1]!,
                id: firstReceipt.json.run!.id,
            });
            const second = await send(a, tasks[2]!);
            accepted.push({
                page: a,
                task: tasks[2]!,
                id: second.json.run!.id,
            });
            const before = await fixture.observe();
            expect(before.owners[owner[0]!]!.queued).toBe(2);
            expect(before.owners[owner[0]!]!.runs).toBe(3);
            expect(before.activeWorkers).toBe(1);
            expect(before.occupied).toEqual([
                { owner: owner[0], status: 'running' },
            ]);
            rejectedReceipt = await send(a, tasks[3]!, 429);
            expect(rejectedReceipt.json).toEqual({
                error: {
                    code: 'tenant_queue_full',
                    message:
                        '当前账号的任务队列已满。等一个排队任务开始后再提交。',
                },
            });
            await expect(a.getByRole('alert')).toContainText(
                '当前账号的任务队列已满。等一个排队任务开始后再提交。',
            );
            await expect(a.getByLabel('任务要求')).toHaveValue('noop');
            await expect(
                a.getByRole('button', { name: '发送要求', exact: true }),
            ).toBeEnabled();
            expect(
                (await get<{ task: Task }>(a, '/api/tasks/' + tasks[3])).task
                    .id,
            ).toBe(tasks[3]);
            expect(await fixture.observe()).toEqual(before);
            report('A-429-atomic', before);
        });
        await test.step('B and C still submit through their own pages; A replay is idempotent at capacity', async () => {
            for (const [page, task] of [
                [b, tasks[4]!],
                [c, tasks[5]!],
            ] as const) {
                const result = await send(page, task);
                accepted.push({ page, task, id: result.json.run!.id });
                expect(result.json.run!.status).toBe('queued');
                expect(
                    (
                        await a.request.get(
                            `/api/tasks/${task}/runs/${result.json.run!.id}`,
                        )
                    ).status(),
                ).toBe(404);
            }
            expect(
                (
                    await b.request.get(
                        `/api/tasks/${tasks[0]}/runs/${accepted[0]!.id}`,
                    )
                ).status(),
            ).toBe(404);
            expect(
                (
                    await c.request.get(
                        `/api/tasks/${tasks[0]}/runs/${accepted[0]!.id}`,
                    )
                ).status(),
            ).toBe(404);
            const before = await fixture.observe();
            expect(owner.map((id) => before.owners[id]!.queued)).toEqual([
                2, 1, 1,
            ]);
            expect(before.enteredRuns).toEqual([accepted[0]!.id]);
            expect(before.activeWorkers).toBe(1);
            expect(before.peakWorkers).toBe(1);
            const replay = await a.request.post(`/api/tasks/${tasks[1]}/runs`, {
                headers: headers(firstReceipt.key),
                data: firstReceipt.body,
            });
            expect(replay.status()).toBe(200);
            expect(((await replay.json()) as { run: TaskRun }).run.id).toBe(
                firstReceipt.json.run!.id,
            );
            expect(await fixture.observe()).toEqual(before);
            expect(fixture.storage.observe().inFlight).toBeGreaterThanOrEqual(
                1,
            );
            expect((await get<Space>(a, '/api/space')).reserved).toBe(
                200_000_000,
            );
            report('B-C-202-A-replay-200', before);
        });
        await test.step('claimed A queue entry frees capacity for the original rejected key', async () => {
            fixture.releaseRun(accepted[0]!.id);
            await expect
                .poll(async () => (await fixture.observe()).enteredRuns)
                .toEqual([accepted[0]!.id, firstReceipt.json.run!.id]);
            await expect
                .poll(
                    async () =>
                        (await run(a, tasks[1]!, firstReceipt.json.run!.id))
                            .status,
                )
                .toBe('running');
            expect((await fixture.observe()).owners[owner[0]!]!.queued).toBe(1);
            const response = await a.request.post(
                `/api/tasks/${tasks[3]}/runs`,
                {
                    headers: headers(rejectedReceipt.key),
                    data: rejectedReceipt.body,
                },
            );
            expect(response.status()).toBe(202);
            const id = ((await response.json()) as { run: TaskRun }).run.id;
            accepted.push({ page: a, task: tasks[3]!, id });
            await a.goto('/tasks/' + tasks[3]);
            await expect(a.getByText('noop', { exact: true })).toBeVisible();
            const before = await fixture.observe();
            expect(before.owners[owner[0]!]!.queued).toBe(2);
            const replay = await a.request.post(`/api/tasks/${tasks[3]}/runs`, {
                headers: headers(rejectedReceipt.key),
                data: rejectedReceipt.body,
            });
            expect(replay.status()).toBe(200);
            expect(((await replay.json()) as { run: TaskRun }).run.id).toBe(id);
            const conflict = await a.request.post(
                `/api/tasks/${tasks[3]}/runs`,
                {
                    headers: headers(rejectedReceipt.key),
                    data: { prompt: 'different' },
                },
            );
            expect(conflict.status()).toBe(409);
            expect((await conflict.json()).error.code).toBe(
                'idempotency_conflict',
            );
            expect(await fixture.observe()).toEqual(before);
            expect(
                (
                    await get<{ items: TaskRun[] }>(
                        a,
                        `/api/tasks/${tasks[3]}/runs`,
                    )
                ).items.map((r) => r.id),
            ).toEqual([id]);
            expect(
                (
                    await get<{ items: { kind: string }[] }>(
                        a,
                        `/api/tasks/${tasks[3]}/events`,
                    )
                ).items.filter((e) => e.kind === 'user_message'),
            ).toHaveLength(1);
            report('capacity-reusable-original-key', before);
        });
        await test.step('upload completion, download and quota recovery never alter the occupied slot or queues', async () => {
            const before = await fixture.observe();
            fixture.storage.releaseParts();
            await expect
                .poll(
                    async () =>
                        (await get<Space>(a, '/api/space')).uploads.find(
                            (u) => u.id === firstUpload,
                        )?.state,
                    { timeout: 30000 },
                )
                .toBe('saved');
            const saved = await get<Space>(a, '/api/space');
            expect(saved.saved).toBe(100_000_000);
            expect(saved.reserved).toBe(100_000_000);
            const downloaded = await a.request.get(
                '/api/space/files/' + firstUpload + '/download',
            );
            expect(downloaded.status()).toBe(200);
            const bytes = await downloaded.body();
            expect(bytes.length).toBe(big.length);
            expect(sha(bytes)).toBe(sha(big));
            expect(await fixture.observe()).toEqual(before);
            const cancelled = await a.request.post(
                `/api/space/uploads/${secondUpload}/cancel`,
                { headers: headers(), data: {} },
            );
            expect(cancelled.status()).toBe(200);
            await expect
                .poll(async () => (await get<Space>(a, '/api/space')).reserved)
                .toBe(0);
            expect(await fixture.observe()).toEqual(before);
            const registered = await a.request.post(
                `/api/space/projects/${projectId}/uploads`,
                { headers: headers(), data: small },
            );
            expect(registered.status()).toBe(200);
            const signed = await a.request.post(
                `/api/space/uploads/${small.id}/part`,
                { headers: headers(), data: { number: 1 } },
            );
            expect(signed.status()).toBe(200);
            const signature = (await signed.json()) as {
                url: string;
                checksum: string;
            };
            expect(
                (
                    await a.request.put(signature.url, {
                        headers: {
                            'x-amz-checksum-sha256': signature.checksum,
                        },
                        data: Buffer.from('x'),
                    })
                ).status(),
            ).toBe(200);
            expect(
                (
                    await a.request.post(
                        `/api/space/uploads/${small.id}/complete`,
                        { headers: headers(), data: {} },
                    )
                ).status(),
            ).toBe(200);
            const recovered = await get<Space>(a, '/api/space');
            expect(recovered.saved).toBe(100_000_001);
            expect(recovered.reserved).toBe(0);
            expect(await fixture.observe()).toEqual(before);
            await quotaPage.reload();
            await expect(
                quotaPage.getByRole('heading', {
                    name: '上传文件',
                    exact: true,
                }),
            ).toBeVisible();
            report('upload-complete-slot-unchanged', before);
            console.log('WEB-A09 physical object', {
                bytes: bytes.length,
                sha256: sha(bytes),
                saved: recovered.saved,
                reserved: recovered.reserved,
            });
        });
        await test.step('all accepted Runs execute once and release their slots', async () => {
            fixture.releaseAll();
            await expect
                .poll(
                    async () =>
                        Promise.all(
                            accepted.map(
                                async (entry) =>
                                    (
                                        await run(
                                            entry.page,
                                            entry.task,
                                            entry.id,
                                        )
                                    ).status,
                            ),
                        ),
                    { timeout: 10000 },
                )
                .toEqual(accepted.map(() => 'succeeded'));
            await expect
                .poll(async () => (await fixture.observe()).activeWorkers)
                .toBe(0);
            const final = await fixture.observe();
            expect(final.occupied).toEqual([]);
            expect(final.queued).toEqual([]);
            expect(final.peakWorkers).toBe(1);
            expect(final.enteredRuns.slice().sort()).toEqual(
                accepted.map((entry) => entry.id).sort(),
            );
            expect(owner.map((id) => final.owners[id]!.runs)).toEqual([
                4, 1, 1,
            ]);
            expect(owner.map((id) => final.owners[id]!.retryAttempts)).toEqual([
                0, 0, 0,
            ]);
            report('all-six-succeeded-exactly-once', final);
        });
    } finally {
        try {
            await Promise.all(contexts.map((context) => context.close()));
        } finally {
            await rm(selection, { recursive: true, force: true });
            await assert.rejects(stat(selection), { code: 'ENOENT' });
        }
    }
});
