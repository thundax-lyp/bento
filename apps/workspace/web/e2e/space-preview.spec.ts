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
