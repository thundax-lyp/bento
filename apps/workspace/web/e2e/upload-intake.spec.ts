import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('上传清单确认后只发送可提交文件', async ({ page }) => {
    const project = { id: 'upload-project', name: '上传项目' };
    const saved = {
        id: 'saved-file',
        project: project.id,
        path: 'saved.txt',
        size: 10,
        state: 'saved',
    };
    const registerPath = '/api/space/projects/' + project.id + '/uploads';
    const writes: string[] = [];
    let registration:
        | { id: string; path: string; size: number; checksums: string[] }
        | undefined;

    await page.route('**/api/session', (route) =>
        route.fulfill({ json: { account: 'upload-demo' } }),
    );
    await page.route(/\/api\/space(?:\/|$)/, async (route) => {
        const request = route.request();
        const method = request.method();
        const { pathname } = new URL(request.url());
        if (method !== 'GET') writes.push(method + ' ' + pathname);
        if (method === 'GET' && pathname === '/api/space') {
            return route.fulfill({
                json: {
                    projects: [project],
                    uploads: [saved],
                    quota: 100,
                    fileLimit: 100,
                    partSize: 16 * 1024 * 1024,
                    saved: saved.size,
                    reserved: 0,
                },
            });
        }
        if (
            method === 'GET' &&
            pathname === '/api/space/projects/' + project.id
        ) {
            return route.fulfill({
                json: {
                    ...project,
                    execution: { state: 'uninitialized' },
                    files: [saved],
                },
            });
        }
        if (method === 'POST' && pathname === registerPath) {
            registration = request.postDataJSON() as NonNullable<
                typeof registration
            >;
            return route.fulfill({ json: { state: 'uploading' } });
        }
        if (registration) {
            const statusPath = '/api/space/uploads/' + registration.id;
            if (method === 'GET' && pathname === statusPath)
                return route.fulfill({
                    json: { state: 'uploading', parts: [] },
                });
            if (method === 'POST' && pathname === statusPath + '/complete')
                return route.fulfill({ json: { state: 'saved' } });
        }
        await route.abort();
    });

    await page.goto('/space/' + project.id);
    const checklist = page.getByRole('region', { name: '上传前清单' });
    const discard = page.getByRole('button', { name: '放弃本次选择' });
    const target = page.getByRole('form', { name: '文件拖放上传' });
    const temp = await mkdtemp(join(tmpdir(), 'bento-upload-intake-'));
    try {
        const root = join(temp, 'root');
        await mkdir(root);
        await writeFile(join(root, 'nested.txt'), 'a');
        await page.getByLabel('文件夹', { exact: true }).setInputFiles(root);
        await expect(checklist).toContainText('root/nested.txt');
        await discard.click();
        await expect(checklist).toHaveCount(0);
    } finally {
        await rm(temp, { recursive: true, force: true });
    }

    async function dropFiles() {
        await target.evaluate((form) => {
            const files = [
                new File(['saved'], 'saved.txt'),
                new File([], 'empty.txt'),
            ];
            const items = files.map((file) => ({
                kind: 'file',
                webkitGetAsEntry: () => ({ isFile: true, name: file.name }),
                getAsFile: () => file,
            }));
            const directory = {
                kind: 'file',
                webkitGetAsEntry: () => ({ isDirectory: true, name: 'folder' }),
                getAsFile: () => null,
            };
            const event = new Event('drop', {
                bubbles: true,
                cancelable: true,
            });
            Object.defineProperty(event, 'dataTransfer', {
                value: { types: ['Files'], items: [...items, directory] },
            });
            form.dispatchEvent(event);
        });
    }

    await dropFiles();
    await expect(checklist).toContainText('目标项目：上传项目');
    await expect(checklist).toContainText('总大小 5 字节');
    await expect(checklist).toContainText('可用额度 90 字节');
    await expect(checklist.getByText(/saved.txt/)).toContainText(
        '目标路径已被占用',
    );
    await expect(checklist.getByText(/empty.txt/)).toContainText('待上传');
    await expect(checklist.getByText(/folder/)).toContainText(
        '请用文件夹选择入口',
    );
    expect(writes).toEqual([]);
    await discard.click();
    await expect(checklist).toHaveCount(0);
    expect(writes).toEqual([]);

    await dropFiles();
    await page.getByRole('button', { name: '确认上传' }).click();
    const results = page.getByRole('list', { name: '上传结果' });
    await expect(results).toContainText('empty.txt · 已保存');
    await expect(checklist).toHaveCount(0);
    expect(registration).toEqual({
        id: expect.any(String),
        path: 'empty.txt',
        size: 0,
        checksums: [],
    });
    expect(writes).toEqual([
        'POST ' + registerPath,
        'POST /api/space/uploads/' + registration?.id + '/complete',
    ]);
});
