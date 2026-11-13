import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const account = 'upload-demo';
const project = { id: 'upload-project', name: '上传项目' };
const registerPath = '/api/space/projects/' + project.id + '/uploads';
const resumeId = 'resume-upload';
const resumeRecord = {
    id: resumeId,
    project: project.id,
    path: 'resume.txt',
    size: 4,
    state: 'uploading',
};

function gate(): { wait: Promise<void>; release: () => void } {
    let release = () => {};
    const wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { wait, release };
}

async function fixture(
    page: Page,
    options: {
        captureParts?: boolean;
        pauseFirstPut?: Promise<void>;
        pauseFirstComplete?: Promise<void>;
        pauseResumePut?: Promise<void>;
        signedOutAt?: 'sign' | 'cache';
    },
) {
    const parts = new Map<string, Map<number, Buffer>>();
    const objects = new Map<string, Buffer>();
    function expectPartNumber(number: number, size: number) {
        expect(Number.isInteger(number)).toBe(true);
        expect(number).toBeGreaterThanOrEqual(1);
        expect(number).toBeLessThanOrEqual(Math.ceil(size / 2));
    }
    const writes: string[] = [];
    const reads: string[] = [];
    const files = new Map<
        string,
        {
            id: string;
            project: string;
            path: string;
            size: number;
            state: string;
        }
    >();
    if (options.pauseResumePut) files.set(resumeId, resumeRecord);
    let failResume = Boolean(options.pauseResumePut);

    await page.route('**/api/session', (route) =>
        route.fulfill({ json: { account } }),
    );
    await page.route(/\/(api\/space|fixture-upload)(?:\/|$)/, async (route) => {
        const request = route.request();
        const method = request.method();
        const { pathname } = new URL(request.url());
        if (method !== 'GET') writes.push(method + ' ' + pathname);
        if (method === 'GET' && pathname === '/api/space') {
            const uploads = [...files.values()];
            return route.fulfill({
                json: {
                    projects: [project],
                    uploads,
                    quota: 100,
                    fileLimit: 100,
                    partSize: 2,
                    saved: uploads
                        .filter((file) => file.state === 'saved')
                        .reduce((size, file) => size + file.size, 0),
                    reserved: uploads
                        .filter((file) => file.state === 'uploading')
                        .reduce((size, file) => size + file.size, 0),
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
                    files: [...files.values()].filter(
                        (file) => file.state === 'saved',
                    ),
                },
            });
        }
        if (method === 'POST' && pathname === registerPath) {
            const { id, path, size } = request.postDataJSON() as {
                id: string;
                path: string;
                size: number;
            };
            if (path === 'resume.txt') expect(id).toBe(resumeId);
            const file = {
                id,
                path,
                size,
                project: project.id,
                state: 'uploading',
            };
            files.set(id, file);
            return route.fulfill({ json: file });
        }
        const attachment =
            /^\/api\/space\/files\/([^/]+)\/(preview|download)$/.exec(pathname);
        if (options.captureParts && method === 'GET' && attachment) {
            const fileId = attachment[1]!;
            const file = files.get(fileId);
            const body = objects.get(fileId);
            expect(file?.project).toBe(project.id);
            expect(file?.state).toBe('saved');
            expect(body).toBeDefined();
            return route.fulfill({
                body: body!,
                ...(attachment[2] === 'download'
                    ? {
                          headers: {
                              'content-disposition':
                                  'attachment; filename="note.txt"',
                          },
                      }
                    : {}),
            });
        }
        const id = pathname
            .split('/')
            .at(pathname.startsWith('/fixture-upload/') ? 2 : 4);
        if (method === 'GET') reads.push(pathname);
        if (
            method === 'GET' &&
            id === 'cached-upload' &&
            options.signedOutAt === 'cache'
        )
            return route.fulfill({ status: 401, json: {} });

        const file = id && files.get(id);
        if (file) {
            if (method === 'GET')
                return route.fulfill({
                    json: { ...file, parts: id === resumeId ? [1] : [] },
                });
            if (method === 'POST' && pathname.endsWith('/part')) {
                if (
                    options.signedOutAt === 'sign' &&
                    file.path === 'expired.txt'
                )
                    return route.fulfill({ status: 401, json: {} });
                const { number } = request.postDataJSON() as { number: number };
                if (options.captureParts) expectPartNumber(number, file.size);
                else expect(number).toBe(id === resumeId ? 2 : 1);
                return route.fulfill({
                    json: {
                        url: '/fixture-upload/' + id + '/' + number,
                        checksum: 'fixture',
                    },
                });
            }
            if (method === 'PUT') {
                if (options.captureParts) {
                    const number = Number(pathname.split('/').at(-1));
                    expectPartNumber(number, file.size);
                    const body = request.postDataBuffer();
                    expect(body).not.toBeNull();
                    const uploaded =
                        parts.get(file.id) ?? new Map<number, Buffer>();
                    uploaded.set(number, body!);
                    parts.set(file.id, uploaded);
                }
                if (file.path === 'first.txt') await options.pauseFirstPut;
                if (id === resumeId && failResume) {
                    await options.pauseResumePut;
                    failResume = false;
                    return route.fulfill({ status: 500 });
                }
                return route.fulfill({ status: 200 });
            }
            if (method === 'POST' && pathname.endsWith('/complete')) {
                if (file.path === 'first.txt') await options.pauseFirstComplete;
                if (options.captureParts) {
                    const chunks: Buffer[] = [];
                    for (
                        let number = 1;
                        number <= Math.ceil(file.size / 2);
                        number++
                    ) {
                        const part = parts.get(file.id)?.get(number);
                        expect(part, 'missing part ' + number).toBeDefined();
                        chunks.push(part!);
                    }
                    const body = Buffer.concat(chunks);
                    expect(body.length).toBe(file.size);
                    objects.set(file.id, body);
                }
                file.state = 'saved';
                return route.fulfill({ json: file });
            }
        }
        await route.abort();
    });
    return { writes, reads, files };
}

async function selectFiles(page: Page, names: string[]) {
    await page.getByLabel('文件', { exact: true }).setInputFiles(
        names.map((name) => ({
            name,
            mimeType: 'text/plain',
            buffer: Buffer.from(name === 'resume.txt' ? 'abcd' : 'ab'),
        })),
    );
}

test('批次逐项显示已确认分块和续传结果', async ({ page }) => {
    const firstPut = gate();
    const firstComplete = gate();
    const resumePut = gate();
    const { writes, files } = await fixture(page, {
        pauseFirstPut: firstPut.wait,
        pauseFirstComplete: firstComplete.wait,
        pauseResumePut: resumePut.wait,
    });
    try {
        await page.goto('/space/' + project.id);
        await selectFiles(page, ['first.txt', 'resume.txt', 'last.txt']);
        expect(writes).toEqual([]);
        const confirm = page.getByRole('button', { name: '确认上传' });
        await confirm.click();
        const rows = page
            .getByRole('list', { name: '上传结果' })
            .getByRole('listitem');
        await expect(rows).toHaveText([
            'first.txt · 上传中 · 已确认 0 / 1 块',
            'resume.txt · 等待上传',
            'last.txt · 等待上传',
        ]);
        firstPut.release();
        await expect(rows.first()).toHaveText(
            'first.txt · 正在确认上传结果… · 已确认 1 / 1 块',
        );
        await expect(rows.first()).not.toContainText('已保存');
        firstComplete.release();
        await expect(rows).toHaveText([
            'first.txt · 已保存 · 已确认 1 / 1 块',
            'resume.txt · 上传中 · 已确认 1 / 2 块',
            'last.txt · 等待上传',
        ]);
        const resumePath = '/api/space/uploads/' + resumeId;
        await expect
            .poll(() =>
                writes.filter(
                    (entry) => entry === 'POST ' + resumePath + '/part',
                ),
            )
            .toHaveLength(1);
        resumePut.release();
        await expect(rows).toHaveText([
            'first.txt · 已保存 · 已确认 1 / 1 块',
            'resume.txt · 本次上传未确认：分块上传失败。重新选择同一个文件可继续。 · 已确认 1 / 2 块',
            'last.txt · 已保存 · 已确认 1 / 1 块',
        ]);
        expect(writes).not.toContain('POST ' + resumePath + '/complete');
        expect(
            [...files.values()].map(({ path, state }) => [path, state]),
        ).toEqual([
            ['resume.txt', 'uploading'],
            ['first.txt', 'saved'],
            ['last.txt', 'saved'],
        ]);
        const offset = writes.length;
        await page.reload();
        await selectFiles(page, ['resume.txt']);
        await expect(
            page.getByRole('region', { name: '上传前清单' }),
        ).toContainText('待校验续传');
        const status = page.waitForRequest(
            (request) =>
                request.method() === 'GET' &&
                new URL(request.url()).pathname === resumePath,
        );
        await confirm.click();
        await status;
        await expect(rows).toHaveText([
            'resume.txt · 已保存 · 已确认 2 / 2 块',
        ]);
        expect(writes.slice(offset)).toEqual([
            'POST ' + registerPath,
            'POST ' + resumePath + '/part',
            'PUT /fixture-upload/' + resumeId + '/2',
            'POST ' + resumePath + '/complete',
        ]);
    } finally {
        firstPut.release();
        firstComplete.release();
        resumePut.release();
    }
});

test('上传鉴权失效后保留当前批次逐项结论', async ({ page }) => {
    const { writes, files } = await fixture(page, { signedOutAt: 'sign' });
    await page.goto('/space/' + project.id);
    await selectFiles(page, ['first.txt', 'expired.txt', 'skipped.txt']);
    await page.getByRole('button', { name: '确认上传' }).click();
    const rows = page
        .getByRole('list', { name: '上传结果' })
        .getByRole('listitem');
    await expect(rows).toHaveText([
        'first.txt · 已保存 · 已确认 1 / 1 块',
        'expired.txt · 登录已过期，请重新登录。 · 已确认 0 / 1 块',
        'skipped.txt · 未开始，请重新登录后重选文件。',
    ]);
    expect([...files.values()].map(({ path }) => path)).toEqual([
        'first.txt',
        'expired.txt',
    ]);
    const [first, expired] = [...files.keys()];
    expect(writes).toEqual([
        'POST ' + registerPath,
        'POST /api/space/uploads/' + first + '/part',
        'PUT /fixture-upload/' + first + '/1',
        'POST /api/space/uploads/' + first + '/complete',
        'POST ' + registerPath,
        'POST /api/space/uploads/' + expired + '/part',
    ]);
});

test('缓存上传探测鉴权失效后停止批次', async ({ page }) => {
    const { reads, writes } = await fixture(page, { signedOutAt: 'cache' });
    await page.addInitScript(
        (key) => {
            sessionStorage.setItem(key, 'cached-upload');
        },
        JSON.stringify(['bento:upload', account, project.id, 'cached.txt', 2]),
    );
    await page.goto('/space/' + project.id);
    await selectFiles(page, ['cached.txt', 'skipped.txt']);
    await page.getByRole('button', { name: '确认上传' }).click();
    const rows = page
        .getByRole('list', { name: '上传结果' })
        .getByRole('listitem');
    await expect(rows).toHaveText([
        'cached.txt · 登录已过期，请重新登录。',
        'skipped.txt · 未开始，请重新登录后重选文件。',
    ]);
    expect(reads).toEqual(['/api/space/uploads/cached-upload']);
    expect(writes).toEqual([]);
});

test('上传目录后按层级查看并下载原文件', async ({ page }) => {
    await fixture(page, { captureParts: true });
    const temp = await mkdtemp(join(tmpdir(), 'bento-upload-directory-'));
    const folder = join(temp, 'fixture');
    const note = Buffer.from('你好\n');
    try {
        await mkdir(join(folder, 'nested'), { recursive: true });
        await writeFile(join(folder, 'nested', 'note.txt'), note);
        await writeFile(join(folder, 'root.txt'), 'root\n');
        await page.goto('/space/' + project.id);
        await page.getByLabel('文件夹', { exact: true }).setInputFiles(folder);
        await page.getByRole('button', { name: '确认上传' }).click();
        const results = page.getByRole('list', { name: '上传结果' });
        await expect(results).toContainText('fixture/nested/note.txt · 已保存');
        await expect(results).toContainText('fixture/root.txt · 已保存');
        await page.reload();

        const tree = page.getByRole('list', { name: '已保存文件' });
        const root = tree.getByRole('list', { name: 'fixture', exact: true });
        const nested = root.getByRole('list', { name: 'nested', exact: true });
        const nestedRow = nested.getByRole('listitem');
        await expect(nestedRow).toHaveCount(1);
        await expect(
            nestedRow.getByRole('checkbox', {
                name: 'fixture/nested/note.txt',
            }),
        ).toBeVisible();
        await expect(nestedRow).toContainText('7 字节');
        await expect(
            nested.getByRole('checkbox', { name: 'fixture/root.txt' }),
        ).toHaveCount(0);
        const rootRow = root
            .locator(':scope > li')
            .filter({
                has: page.getByRole('checkbox', { name: 'fixture/root.txt' }),
            });
        await expect(rootRow).toContainText('5 字节');

        await nestedRow.getByRole('button', { name: '预览文本' }).click();
        await expect(
            page.getByRole('region', { name: '文本预览' }).locator('pre'),
        ).toHaveJSProperty('textContent', note.toString());
        const downloadPromise = page.waitForEvent('download');
        await nestedRow.getByRole('link', { name: '下载文件' }).click();
        const download = await downloadPromise;
        expect(await readFile(await download.path())).toEqual(note);
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
});
