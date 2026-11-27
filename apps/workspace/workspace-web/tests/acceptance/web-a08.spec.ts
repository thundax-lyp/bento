import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    expect,
    test,
    type Locator,
    type Page,
    type Response,
} from '@playwright/test';
import type { Session, Task, TaskResult, TaskRun } from '@workspace-web/api.ts';

const file = 'web-a08.txt';
const sha256 = (bytes: Buffer) =>
    createHash('sha256').update(bytes).digest('hex');

function posted(path: string) {
    return (response: Response) =>
        new URL(response.url()).pathname === path &&
        response.request().method() === 'POST';
}

async function upload(page: Page, name: string, buffer: Buffer) {
    await page.getByLabel('文件', { exact: true }).setInputFiles({
        name,
        mimeType: 'text/plain',
        buffer,
    });
    await page.getByRole('button', { name: '确认上传' }).click();
    await expect(
        page.getByRole('list', { name: '已保存文件', exact: true }),
    ).toContainText(name, { timeout: 60_000 });
}

async function download(page: Page, link: Locator) {
    const pending = page.waitForEvent('download', { timeout: 60_000 });
    await link.click();
    const artifact = await pending;
    try {
        return await readFile(await artifact.path());
    } finally {
        await artifact.delete();
    }
}

async function verifyLargeFile(page: Page) {
    const name = 'large.txt';
    const contents = Buffer.alloc(1024 * 1024 + 1, 'x');
    await upload(page, name, contents);
    const saved = page
        .getByRole('list', { name: '已保存文件', exact: true })
        .getByRole('listitem')
        .filter({ hasText: name });
    const link = saved.getByRole('link', { name: '下载文件' });
    expect((await download(page, link)).equals(contents)).toBe(true);
    const url = await link.getAttribute('href');
    expect(url).toMatch(/^\/api\//);

    const checkbox = page.getByRole('checkbox', { name, exact: true });
    await checkbox.check();
    const rejected = page.waitForResponse(posted('/api/tasks'));
    await page.getByRole('button', { name: '从所选文件新建任务' }).click();
    expect((await rejected).status()).toBe(413);
    await expect(
        page.getByText(/单个文件已超过快照的 1 MiB 总量限制/),
    ).toBeVisible();
    await checkbox.uncheck();
    return url!;
}

async function applyPatch(patch: Buffer, before: Buffer, after: Buffer) {
    const directory = await mkdtemp(join(tmpdir(), 'bento-web-a08-'));
    try {
        await writeFile(join(directory, file), before);
        const result = spawnSync('git', ['apply', '-'], {
            cwd: directory,
            input: patch,
            timeout: 10_000,
            env: {
                PATH: process.env.PATH,
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: '/dev/null',
            },
        });
        expect(result.status, 'git apply succeeds').toBe(0);
        expect(await readdir(directory)).toEqual([file]);
        expect((await readFile(join(directory, file))).equals(after)).toBe(
            true,
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('WEB-A08 three invited accounts recover their own background Run', async ({
    browser,
    baseURL,
}) => {
    const accounts = [1, 2, 3].map((index) => {
        const account = process.env['BENTO_WEB_A08_ACCOUNT_' + index];
        const username = process.env['BENTO_WEB_A08_USERNAME_' + index];
        const password = process.env['BENTO_WEB_A08_PASSWORD_' + index];
        if (!account || !username || !password)
            throw new Error('WEB-A08 requires three invited accounts');
        return { account, username, password };
    });
    expect(new Set(accounts.map(({ account }) => account)).size).toBe(3);
    if (!baseURL) throw new Error('WEB-A08 requires its isolated deployment');

    async function login(page: Page, identity: (typeof accounts)[number]) {
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
            throw new Error('WEB-A08 could not submit the invited login');
        }
        await expect(page).toHaveURL(new URL('/', baseURL!).href, {
            timeout: 20_000,
        });
        await page.goto('/runs');
        const session = await page.request.get('/api/session');
        expect(session.status()).toBe(200);
        expect(
            ((await session.json()) as Session).account === identity.account,
        ).toBe(true);
    }

    const deliveries: { name: string; paths: string[] }[] = [];
    for (const [index, identity] of accounts.entries()) {
        await test.step('Account ' + (index + 1), async () => {
            const name = 'WEB-A08 ' + randomUUID();
            const marker = 'account-' + (index + 1) + '-' + randomUUID();
            const original = Buffer.from(marker + '\n');
            const finalLine = 'verified-' + marker;
            const expected = Buffer.from(marker + '\n' + finalLine + '\n');

            const initial = await browser.newContext({ baseURL });
            let taskPath: string;
            let runPath: string;
            let runId: string;
            let largeFilePath: string | undefined;
            try {
                const page = await initial.newPage();
                await login(page, identity);
                await page.goto('/workspaces');
                await page.getByLabel('空间项目名称').fill(name);
                await page
                    .getByRole('button', { name: '新建空间项目' })
                    .click();
                await expect(page).toHaveURL(/\/space\/[^/?]+$/);
                if (index === 0) largeFilePath = await verifyLargeFile(page);
                await upload(page, file, original);
                await page
                    .getByRole('checkbox', { name: file, exact: true })
                    .check();
                const creating = page.waitForResponse(posted('/api/tasks'));
                await page
                    .getByRole('button', { name: '从所选文件新建任务' })
                    .click();
                const created = await creating;
                expect(created.status()).toBe(202);
                const { task } = (await created.json()) as { task: Task };
                taskPath = '/tasks/' + encodeURIComponent(task.id);
                await expect(page).toHaveURL(new URL(taskPath, baseURL).href);
                await expect(page.getByLabel('任务要求')).toBeEnabled({
                    timeout: 180_000,
                });
                const ready = await initial.request.get('/api' + taskPath);
                expect(ready.status()).toBe(200);
                const { task: snapshot } = (await ready.json()) as {
                    task: Task;
                };
                expect(snapshot.inputs).toMatchObject([
                    {
                        path: file,
                        bytes: original.length,
                        sha256: sha256(original),
                    },
                ]);

                const runs = '/api' + taskPath + '/runs';
                await page
                    .getByLabel('任务要求')
                    .fill(
                        '只修改 ' +
                            file +
                            '。保留现有第一行，在第二行追加 ' +
                            finalLine +
                            ' 和换行。请用 bento_workspace_append，path 为 web-a08.txt，line 是上述第二行（不含换行）。保存后调用 bento_workspace_check，' +
                            'path 为 ' +
                            file +
                            '，expected 为 ' +
                            JSON.stringify(expected.toString('utf8')) +
                            '。给出简短结论。',
                    );
                const accepting = page.waitForResponse(posted(runs));
                await page.getByRole('button', { name: '发送要求' }).click();
                const accepted = await accepting;
                expect(accepted.status()).toBe(202);
                const { run } = (await accepted.json()) as { run: TaskRun };
                expect(run).toMatchObject({ taskId: task.id, sequence: 1 });
                runId = run.id;
                runPath = runs + '/' + encodeURIComponent(runId);
                const readRun = async () => {
                    const response = await initial.request.get(runPath, {
                        timeout: 10_000,
                    });
                    expect(response.status()).toBe(200);
                    const { run: current } = (await response.json()) as {
                        run: TaskRun;
                    };
                    expect(current.id).toBe(runId);
                    return current.status;
                };
                expect(['queued', 'running']).toContain(await readRun());
                await page.close();
                expect(initial.pages()).toHaveLength(0);
                const closedStatus = await readRun();
                expect(
                    ['queued', 'running'],
                    'Run stays active with no open page',
                ).toContain(closedStatus);
                let terminal: TaskRun['status'] = closedStatus;
                await expect
                    .poll(
                        async () => {
                            terminal = await readRun();
                            return [
                                'succeeded',
                                'failed',
                                'cancelled',
                                'needs_review',
                            ].includes(terminal);
                        },
                        { intervals: [2000], timeout: 180_000 },
                    )
                    .toBe(true);
                expect(terminal).toBe('succeeded');
                console.log(
                    'WEB-A08 account %d: %s with page closed, then %s',
                    index + 1,
                    closedStatus,
                    terminal,
                );
            } finally {
                await initial.close();
            }

            const reopened = await browser.newContext({ baseURL });
            try {
                const page = await reopened.newPage();
                await login(page, identity);
                const link = page
                    .getByRole('list', { name: '任务', exact: true })
                    .getByRole('link', { name, exact: true });
                await expect(link).toHaveAttribute('href', taskPath);
                const previews = page.waitForResponse((response) => {
                    const url = new URL(response.url());
                    return (
                        url.pathname === runPath + '/results/1/diff' &&
                        url.searchParams.get('view') === 'cumulative' &&
                        !url.searchParams.has('download')
                    );
                });
                await link.click();
                await expect(page.getByLabel('执行轮次')).toHaveValue(runId);
                const results = runPath + '/results';
                const resultResponse = await reopened.request.get(results);
                expect(resultResponse.status()).toBe(200);
                const { result } = (await resultResponse.json()) as {
                    result: TaskResult;
                };
                expect(result).toMatchObject({ runId, version: 1 });
                expect(result.checks).toEqual([
                    expect.objectContaining({ status: 'passed' }),
                ]);
                const preview = await previews;
                expect(preview.status()).toBe(200);
                const bytes = await preview.body();
                expect(sha256(bytes)).toBe(result.cumulativeSha256);
                await page
                    .getByRole('button', { name: '修改 ' + file })
                    .click();
                await expect(
                    page
                        .getByLabel('逐行变更')
                        .getByText('+' + finalLine, { exact: true }),
                ).toBeVisible();
                const attachment = page.getByRole('link', {
                    name: '下载 diff',
                });
                const diff = results + '/1/diff?view=cumulative';
                await expect(attachment).toHaveAttribute(
                    'href',
                    diff + '&download=1',
                );
                expect((await download(page, attachment)).equals(bytes)).toBe(
                    true,
                );
                await applyPatch(bytes, original, expected);
                deliveries.push({
                    name,
                    paths: [
                        '/api' + taskPath,
                        runPath,
                        results,
                        diff,
                        diff + '&download=1',
                        ...(largeFilePath ? [largeFilePath] : []),
                    ],
                });
            } finally {
                await reopened.close();
            }
        });
    }

    for (const [index, identity] of accounts.entries()) {
        await test.step(
            'Cross-account reads from account ' + (index + 1),
            async () => {
                const context = await browser.newContext({ baseURL });
                try {
                    const page = await context.newPage();
                    await login(page, identity);
                    for (const [owner, delivery] of deliveries.entries()) {
                        if (index === owner) continue;
                        await expect(
                            page.getByRole('link', {
                                name: delivery.name,
                                exact: true,
                            }),
                        ).toHaveCount(0);
                        for (const path of delivery.paths) {
                            const response = await context.request.get(path, {
                                maxRedirects: 0,
                            });
                            expect(response.status()).toBe(404);
                        }
                    }
                } finally {
                    await context.close();
                }
            },
        );
    }
});
