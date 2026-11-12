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
                files: state === 'saved' ? [file] : [],
                execution: { state: 'uninitialized' },
            },
        }),
    );
    await page.route('**/api/space', (route) =>
        route.fulfill({
            json: {
                projects: [project],
                uploads: state === 'deleted' ? [] : [{ ...file, state }],
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
    await open.click();
    await apply.click();
    await expect(row).toContainText('正在删除');
    await expect(download).toHaveCount(0);
    await expect(checklist).toContainText('可用额度 93 字节');

    state = 'deleted';
    await expect(row).toHaveCount(0);
    await expect(checklist).toContainText('可用额度 100 字节');
    expect(writes).toEqual(
        Array.from({ length: 2 }, () => ({
            method: 'DELETE',
            path: fileApi + file.id,
            origin: new URL(baseURL!).origin,
        })),
    );
});
