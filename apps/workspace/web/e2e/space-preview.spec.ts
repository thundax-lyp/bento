import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { createServer } from 'node:http';

const project = { id: 'preview-project', name: '预览项目' };
const spaceUrl = '/space/' + project.id;
const projectApi = '/api/space/projects/' + project.id;
const fileApi = '/api/space/files/';

const savedFile = (id: string, size: number) => ({
    id,
    path: id + '.txt',
    project: project.id,
    size,
    state: 'saved',
});

test('已保存文件只读预览并保留下载', async ({ page, baseURL }) => {
    const literal = '<script>fixture</script>\n第二行\n';
    const bodies: Record<string, Buffer> = {
        '/text': Buffer.from(literal),
        '/oversize': Buffer.alloc(262145, 97),
        '/binary': Buffer.from([0xc3, 0x28]),
    };
    const objectServer = createServer((req, res) => {
        const body = bodies[req.url ?? ''];
        if (!body) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, {
            'access-control-allow-origin': new URL(baseURL!).origin,
            'content-type': 'application/octet-stream',
        });
        res.end(body);
    });
    const listening = once(objectServer, 'listening');
    objectServer.listen(0, '127.0.0.1');
    await listening;
    const address = objectServer.address();
    if (!address || typeof address === 'string')
        throw new Error('Fixture listen address unavailable');

    const files = [
        savedFile('text', Buffer.byteLength(literal)),
        savedFile('metadata', 262145),
        savedFile('oversize', 1),
        savedFile('binary', 2),
    ];
    try {
        await page.route('**/api/session', (route) =>
            route.fulfill({ json: { account: 'preview-demo' } }),
        );
        await page.route('**' + projectApi, (route) =>
            route.fulfill({
                json: {
                    ...project,
                    files,
                    execution: { state: 'uninitialized' },
                },
            }),
        );
        await page.route('**/api/space', (route) =>
            route.fulfill({
                json: {
                    projects: [project],
                    uploads: files,
                    quota: 1000000,
                    fileLimit: 4000000000,
                    partSize: 16777216,
                    saved: 262148 + Buffer.byteLength(literal),
                    reserved: 0,
                },
            }),
        );
        await page.route('**' + fileApi + '*/preview', (route) => {
            const id = new URL(route.request().url()).pathname
                .split('/')
                .at(-2);
            if (id === 'metadata') return route.fulfill({ status: 413 });
            return route.fulfill({
                status: 302,
                headers: {
                    location: 'http://127.0.0.1:' + address.port + '/' + id,
                },
            });
        });

        await page.goto(spaceUrl);
        const preview = page.getByRole('region', { name: '文本预览' });
        const row = (id: string) =>
            page.getByRole('listitem').filter({
                has: page.getByRole('checkbox', {
                    name: id + '.txt',
                    exact: true,
                }),
            });
        await row('text').getByRole('button', { name: '预览文本' }).click();
        await expect(preview.locator('pre')).toHaveJSProperty(
            'textContent',
            literal,
        );
        await expect(preview.locator('script')).toHaveCount(0);
        await expect(
            row('text').getByRole('link', { name: '下载文件' }),
        ).toHaveAttribute('href', fileApi + 'text/download');

        for (const [id, message] of [
            ['metadata', '文件超过 256 KiB，无法预览'],
            ['oversize', '文件超过 256 KiB，无法预览'],
            ['binary', '文件不是有效的 UTF-8 文本'],
        ] as const) {
            await row(id).getByRole('button', { name: '预览文本' }).click();
            await expect(preview.getByRole('status')).toHaveText(message);
            await expect(preview.locator('pre')).toHaveCount(0);
            await expect(
                row(id).getByRole('link', { name: '下载文件' }),
            ).toHaveAttribute('href', fileApi + id + '/download');
        }
        await preview.getByRole('button', { name: '关闭预览' }).click();
        await expect(preview).toHaveCount(0);
    } finally {
        await new Promise<void>((resolve, reject) => {
            objectServer.close((error) => (error ? reject(error) : resolve()));
            objectServer.closeAllConnections();
        });
    }
});

test('单文件删除确认后等待服务器回收额度', async ({ page, baseURL }) => {
    const file = savedFile('delete-fixture', 7);
    const remaining = savedFile('remaining-fixture', 0);
    const preparations: unknown[] = [];
    let state: 'saved' | 'deleting' | 'deleted' = 'saved';
    const writes: {
        method: string;
        path: string;
        origin: string | undefined;
    }[] = [];
    await page.route('**/api/session', (route) =>
        route.fulfill({ json: { account: 'delete-demo' } }),
    );
    await page.route('**' + projectApi, (route) =>
        route.fulfill({
            json: {
                ...project,
                files: state === 'saved' ? [file, remaining] : [remaining],
                execution: { state: 'uninitialized' },
            },
        }),
    );
    await page.route('**/api/space', (route) =>
        route.fulfill({
            json: {
                projects: [project],
                uploads:
                    state === 'deleted'
                        ? [remaining]
                        : [{ ...file, state }, remaining],
                quota: 100,
                fileLimit: 4000000000,
                partSize: 16777216,
                saved: state === 'deleted' ? 0 : file.size,
                reserved: 0,
            },
        }),
    );
    await page.route('**' + fileApi + file.id, (route) => {
        const request = route.request();
        writes.push({
            method: request.method(),
            path: new URL(request.url()).pathname,
            origin: request.headers().origin,
        });
        if (writes.length === 1)
            return route.fulfill({
                status: 409,
                json: {
                    error: {
                        code: 'project_busy',
                        message: '文件正在被未结束的任务使用。',
                    },
                },
            });
        state = 'deleting';
        return route.fulfill({ status: 202, json: { state } });
    });
    await page.route('**' + projectApi + '/execution', (route) => {
        preparations.push(route.request().postDataJSON());
        return route.fulfill({ status: 202, json: { state: 'validating' } });
    });
    await page.goto(spaceUrl);
    await page.getByLabel('文件', { exact: true }).setInputFiles({
        name: 'quota-check.txt',
        mimeType: 'text/plain',
        buffer: Buffer.alloc(0),
    });
    const row = page.getByRole('listitem').filter({ hasText: file.path });
    const open = row.getByRole('button', { name: '删除文件' });
    const download = row.getByRole('link', { name: '下载文件' });
    const confirm = page.getByRole('group', { name: '确认删除文件' });
    const apply = confirm.getByRole('button', { name: '确认删除' });
    const checklist = page.getByRole('region', { name: '上传前清单' });
    const input = row.getByRole('checkbox', { name: file.path });
    const prepare = page.getByRole('button', { name: '准备执行文件' });
    await input.check();
    await expect(prepare).toBeEnabled();
    await expect(checklist).toContainText('可用额度 93 字节');

    await open.click();
    await expect(confirm).toContainText(file.path);
    await expect(download).toBeVisible();
    await confirm.getByRole('button', { name: '保留文件' }).click();
    expect(writes).toEqual([]);

    await open.click();
    await apply.click();
    await expect(page.getByRole('alert')).toHaveText(
        '文件正在被未结束的任务使用。',
    );
    await expect(download).toBeVisible();
    await expect(input).toBeChecked();
    await open.click();
    await apply.click();
    await expect(row).toContainText('正在删除');
    await expect(prepare).toBeDisabled();
    await expect(download).toHaveCount(0);
    await expect(checklist).toContainText('可用额度 93 字节');

    state = 'deleted';
    await expect(row).toHaveCount(0);
    await expect(checklist).toContainText('可用额度 100 字节');
    await page.getByRole('checkbox', { name: remaining.path }).check();
    await prepare.click();
    await expect
        .poll(() => preparations)
        .toEqual([{ fileIds: [remaining.id] }]);
    expect(writes).toEqual(
        Array.from({ length: 2 }, () => ({
            method: 'DELETE',
            path: fileApi + file.id,
            origin: new URL(baseURL!).origin,
        })),
    );
});

test('项目删除显示影响、阻塞并等待完成', async ({ page }) => {
    const file = savedFile('project-delete-fixture', 2_000_000_000);
    let state: 'saved' | 'deleting' | 'deleted' = 'saved';
    let blocked = true;
    let deletes = 0;
    await page.route('**/api/session', (route) =>
        route.fulfill({ json: { account: 'project-delete-demo' } }),
    );
    await page.route('**/api/projects', (route) =>
        route.fulfill({ json: { projects: [] } }),
    );
    await page.route('**/api/space', (route) =>
        route.fulfill({
            json: {
                projects:
                    state === 'deleted'
                        ? []
                        : [
                              {
                                  ...project,
                                  ...(state === 'deleting' ? { state } : {}),
                              },
                          ],
                uploads: state === 'deleted' ? [] : [{ ...file, state }],
                quota: 10_000_000_000,
                fileLimit: 4_000_000_000,
                partSize: 16_777_216,
                saved: state === 'deleted' ? 0 : file.size,
                reserved: 0,
            },
        }),
    );
    await page.route('**' + projectApi + '/deletion', (route) =>
        route.fulfill({
            json: {
                fileCount: 1,
                uploadCount: blocked ? 1 : 0,
                runCount: 2,
                diffCount: 1,
                blockers: blocked ? ['upload_pending'] : [],
            },
        }),
    );
    await page.route('**' + projectApi, (route) => {
        if (route.request().method() === 'DELETE') {
            deletes++;
            if (state === 'deleted') return route.fulfill({ status: 204 });
            state = 'deleting';
            return route.fulfill({ status: 202, json: { state } });
        }
        if (state === 'deleted')
            return route.fulfill({
                status: 404,
                json: { error: { message: '找不到该资源。' } },
            });
        return route.fulfill({
            json: {
                ...project,
                ...(state === 'deleting' ? { state } : {}),
                files: state === 'saved' ? [file] : [],
                execution: { state: 'uninitialized' },
            },
        });
    });
    await page.goto(spaceUrl);
    const open = page.getByRole('button', { name: '删除项目', exact: true });
    const confirm = page.getByRole('region', { name: '确认删除项目' });
    const apply = confirm.getByRole('button', { name: '确认删除' });
    await open.click();
    await expect(confirm).toContainText('未清理上传 1');
    await expect(confirm).toContainText('任务 2');
    await expect(confirm).toContainText('已发布补丁 1');
    await expect(apply).toBeDisabled();
    await expect(page.getByRole('link', { name: '下载文件' })).toBeVisible();
    expect(deletes).toBe(0);
    await confirm.getByRole('button', { name: '取消', exact: true }).click();
    blocked = false;
    await open.click();
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(page.getByText('正在删除项目', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '下载文件' })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('正在删除项目', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: '返回 Workspace' }).click();
    await expect(
        page.getByText('已用 2.00 / 10 GB', { exact: false }),
    ).toBeVisible();
    await page.getByRole('link', { name: project.name }).click();
    await expect(page.getByText('正在删除项目', { exact: true })).toBeVisible();
    expect(deletes).toBe(1);
    state = 'deleted';
    await expect(page).toHaveURL(/\/workspaces$/);
    await expect(
        page.getByText('已用 0.00 / 10 GB', { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: project.name })).toHaveCount(0);
    expect(deletes).toBe(2);
    await page.goto(spaceUrl);
    await expect(page.getByRole('alert')).toHaveText('找不到该资源。');
    expect(deletes).toBe(2);
});

test('项目删除响应丢失后用原编号确认完成', async ({ browser, baseURL }) => {
    for (const failure of ['503', 'network']) {
        const page = await browser.newPage(baseURL ? { baseURL } : {});
        let completed = false;
        const calls: string[] = [];
        const missing = {
            status: 404,
            json: { error: { message: '找不到该资源。' } },
        };
        try {
            await page.route('**/api/session', (route) =>
                route.fulfill({ json: { account: 'project-lost-receipt' } }),
            );
            await page.route('**/api/projects', (route) =>
                route.fulfill({ json: { projects: [] } }),
            );
            await page.route('**/api/space', (route) =>
                route.fulfill({
                    json: {
                        projects: completed ? [] : [project],
                        uploads: [],
                        quota: 10_000_000_000,
                        fileLimit: 4_000_000_000,
                        partSize: 16_777_216,
                        saved: completed ? 0 : 2_000_000_000,
                        reserved: 0,
                    },
                }),
            );
            await page.route('**' + projectApi + '/deletion', (route) => {
                if (completed) {
                    calls.push('impact 404');
                    return route.fulfill(missing);
                }
                return route.fulfill({
                    json: {
                        fileCount: 1,
                        uploadCount: 0,
                        runCount: 0,
                        diffCount: 0,
                        blockers: [],
                    },
                });
            });
            await page.route('**' + projectApi, (route) => {
                if (route.request().method() === 'DELETE') {
                    calls.push(
                        'DELETE ' + new URL(route.request().url()).pathname,
                    );
                    if (completed) return route.fulfill({ status: 204 });
                    completed = true;
                    return failure === 'network'
                        ? route.abort()
                        : route.fulfill({
                              status: 503,
                              json: {
                                  error: {
                                      message:
                                          '暂无法确认项目删除进度，请重试。',
                                  },
                              },
                          });
                }
                if (completed) {
                    calls.push('detail 404');
                    return route.fulfill(missing);
                }
                return route.fulfill({
                    json: {
                        ...project,
                        files: [],
                        execution: { state: 'uninitialized' },
                    },
                });
            });
            let unrelatedDeletes = 0;
            await page.route('**/api/space/projects/unrelated', (route) => {
                if (route.request().method() === 'DELETE') unrelatedDeletes++;
                return route.fulfill(missing);
            });
            await page.goto(spaceUrl);
            await page
                .getByRole('button', { name: '删除项目', exact: true })
                .click();
            await page
                .getByRole('button', { name: '确认删除', exact: true })
                .click();
            await expect(page).toHaveURL(/\/workspaces$/);
            await expect(
                page.getByText('已用 0.00 / 10 GB', { exact: false }),
            ).toBeVisible();
            await expect(
                page.getByRole('link', { name: project.name }),
            ).toHaveCount(0);
            const deletion = 'DELETE ' + projectApi;
            expect(calls.filter((entry) => entry === deletion)).toEqual([
                deletion,
                deletion,
            ]);
            expect(
                calls
                    .slice(1, calls.lastIndexOf(deletion))
                    .some((entry) => entry.endsWith('404')),
            ).toBe(true);
            await page.goto('/space/unrelated');
            await expect(page.getByRole('alert')).toHaveText('找不到该资源。');
            expect(unrelatedDeletes).toBe(0);
        } finally {
            await page.close();
        }
    }
});
