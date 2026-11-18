import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
    mkdir,
    mkdtemp,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Locator, type Page } from '@playwright/test';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const exec = promisify(execFile);
const source = Buffer.from('base\n');
const retained = Buffer.from('keep\n');
const partSize = 16_777_216;
const uploadSize = partSize + 1;
const files = '/api/space/files/';
const uploads = '/api/space/uploads/';
const projects = '/api/space/projects/';
const bothViews = ['incremental', 'cumulative'] as const;
type Upload = {
    id: string;
    project: string;
    path: string;
    size: number;
    state: string;
    parts?: number[];
};
type Space = {
    saved: number;
    reserved: number;
    uploads: Upload[];
    projects: { id: string }[];
};
type Recovery = {
    projectId: string | null;
    sourceFileId: string | null;
    keepFileId: string | null;
    multipartUploadId: string | null;
    taskId: string | null;
    runId: string | null;
    stage: string;
};

function input(name: string) {
    const path = process.env[name];
    if (!path || !isAbsolute(path))
        throw new Error('Missing absolute WEB-A05 input ' + name);
    return path;
}

async function observe(observer: string, ...args: string[]) {
    try {
        await exec(observer, args, { timeout: 15_000, maxBuffer: 4096 });
        return true;
    } catch (error) {
        if ((error as { code?: unknown }).code === 1) return false;
        throw new Error('WEB-A05 observer failed: ' + args[0], {
            cause: error,
        });
    }
}

async function json<T>(page: Page, path: string) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    return (await response.json()) as T;
}

async function download(page: Page, link: Locator) {
    const [event] = await Promise.all([
        page.waitForEvent('download'),
        link.click(),
    ]);
    try {
        return await readFile((await event.path())!);
    } finally {
        await event.delete();
    }
}

function responseFor(page: Page, method: string, path: string) {
    return page.waitForResponse(
        (r) =>
            r.request().method() === method &&
            new URL(r.url()).pathname === path,
    );
}

async function patches(page: Page, path: string, runId: string) {
    const result = await json<{
        result: {
            runId: string;
            version: number;
            incrementalSha256: string;
            cumulativeSha256: string;
        };
    }>(page, path + '/results');
    expect(result.result.runId).toBe(runId);
    expect(result.result.version).toBe(1);
    const bytes = await Promise.all(
        bothViews.map(async (view) => {
            const url = path + '/results/1/diff?view=' + view;
            const preview = await page.request.get(url);
            const attachment = await page.request.get(url + '&download=1');
            expect(preview.status()).toBe(200);
            expect(attachment.status()).toBe(200);
            expect(attachment.headers()['content-disposition']).toBe(
                'attachment; filename="changes.patch"',
            );
            const patch = await preview.body();
            expect((await attachment.body()).equals(patch)).toBe(true);
            expect(sha(patch)).toBe(
                view === 'incremental'
                    ? result.result.incrementalSha256
                    : result.result.cumulativeSha256,
            );
            expect(patch.toString()).toMatch(/^\+one$/m);
            return patch;
        }),
    );
    return { result, bytes };
}

test('WEB-A05 B isolated deletion and quota reclamation', async ({
    page,
    baseURL,
}) => {
    const storage = input('BENTO_WEB_A05_STORAGE_CHECK');
    const runtime = input('BENTO_WEB_A05_RUNTIME_CHECK');
    const recoveryPath = input('BENTO_WEB_A05_RECOVERY_FILE');
    const headers = { origin: new URL(baseURL!).origin };
    const ids: Recovery = {
        projectId: null,
        sourceFileId: null,
        keepFileId: null,
        multipartUploadId: null,
        taskId: null,
        runId: null,
        stage: 'initial',
    };
    const save = async (stage: string) => {
        ids.stage = stage;
        const temp = join(dirname(recoveryPath), '.a05-' + randomUUID());
        await writeFile(temp, JSON.stringify(ids), { mode: 0o600, flag: 'wx' });
        await rename(temp, recoveryPath);
    };
    const space = () => json<Space>(page, '/api/space');
    const originalState = await space();
    expect(originalState).toMatchObject({
        projects: [],
        saved: 0,
        reserved: 0,
    });
    const remove = (path: string) => page.request.delete(path, { headers });
    const missing = async (path: string) =>
        expect(
            (await page.request.get(path, { maxRedirects: 0 })).status(),
        ).toBe(404);
    const expectReplay = async (path: string) => {
        for (let i = 0; i < 2; i++) {
            const response = await remove(path);
            expect(response.status()).toBe(204);
            expect((await response.body()).length).toBe(0);
        }
    };
    const row = (path: string) =>
        page
            .getByRole('list', { name: path.split('/')[0]!, exact: true })
            .getByRole('listitem')
            .filter({
                has: page.getByRole('checkbox', { name: path, exact: true }),
            });
    const fileLink = (path: string) =>
        row(path).getByRole('link', { name: '下载文件' });
    const projectConfirm = page.getByRole('region', { name: '确认删除项目' });
    let projectApi = '',
        projectPage = '',
        taskPath = '',
        runPath = '',
        sourceKey = '',
        keepKey = '';
    let before: Awaited<ReturnType<typeof patches>>;
    await test.step('T3 WEB-03-02 单文件', async () => {
        await save('T3 project');
        await page.goto('/workspaces');
        await page.getByLabel('空间项目名称').fill('WEB-A05 ' + randomUUID());
        await page.getByRole('button', { name: '新建空间项目' }).click();
        await expect(page).toHaveURL(/\/space\/[^/?]+$/);
        projectPage = new URL(page.url()).pathname;
        ids.projectId = projectPage.split('/').at(-1)!;
        projectApi = projects + ids.projectId;
        await save('T3 upload');
        const directory = await mkdtemp(join(tmpdir(), 'web-a05-'));
        try {
            const root = join(directory, 'web-a05');
            await Promise.all([
                mkdir(join(root, 'src'), { recursive: true }),
                mkdir(join(root, 'keep'), { recursive: true }),
            ]);
            await Promise.all([
                writeFile(join(root, 'src/input.txt'), source),
                writeFile(join(root, 'keep/keep.txt'), retained),
            ]);
            const folder = page.getByLabel('文件夹', { exact: true });
            await folder.setInputFiles(join(root, 'src'));
            await page.getByRole('button', { name: '确认上传' }).click();
            await expect
                .poll(async () => (await space()).saved)
                .toBe(source.length);
            await folder.setInputFiles(join(root, 'keep'));
            await page.getByRole('button', { name: '确认上传' }).click();
            await expect
                .poll(async () => (await space()).saved)
                .toBe(source.length + retained.length);
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
        const initial = await space();
        expect(initial.reserved).toBe(0);
        const own = initial.uploads.filter((u) => u.project === ids.projectId);
        const src = own.find((u) => u.path === 'src/input.txt')!;
        const keep = own.find((u) => u.path === 'keep/keep.txt')!;
        expect(src).toMatchObject({ size: source.length, state: 'saved' });
        expect(keep).toMatchObject({ size: retained.length, state: 'saved' });
        ids.sourceFileId = src.id;
        ids.keepFileId = keep.id;
        sourceKey = 'space/' + src.id;
        keepKey = 'space/' + keep.id;
        await save('T3 snapshot');
        await expect(row(src.path)).toContainText('input.txt');
        await expect(row(keep.path)).toContainText('keep.txt');
        await row(src.path).getByRole('button', { name: '预览文本' }).click();
        await expect(
            page.getByRole('region', { name: '文本预览' }).locator('pre'),
        ).toHaveJSProperty('textContent', source.toString());
        await page.getByRole('button', { name: '关闭预览' }).click();
        expect(sha(await download(page, fileLink(src.path)))).toBe(sha(source));
        expect(sha(await download(page, fileLink(keep.path)))).toBe(
            sha(retained),
        );
        expect(
            await observe(
                storage,
                'head-saved',
                sourceKey,
                String(source.length),
            ),
        ).toBe(true);
        await row(src.path)
            .getByRole('checkbox', { name: src.path, exact: true })
            .check();
        const creating = responseFor(page, 'POST', '/api/tasks');
        await page.getByRole('button', { name: '从所选文件新建任务' }).click();
        const created = await creating;
        expect(created.status()).toBe(202);
        ids.taskId = (await created.json()).task.id;
        taskPath = '/api/tasks/' + ids.taskId;
        await save('T3 submit Run');
        await expect(page.getByLabel('任务要求')).toBeEnabled({
            timeout: 120_000,
        });
        await page.getByLabel('任务要求').fill('WEB-A05 fixture append one');
        const accepting = responseFor(page, 'POST', taskPath + '/runs');
        await page.getByRole('button', { name: '发送要求' }).click();
        const accepted = await accepting;
        expect(accepted.status()).toBe(202);
        ids.runId = (await accepted.json()).run.id;
        runPath = taskPath + '/runs/' + ids.runId;
        await save('T3 wait Run');
        await expect
            .poll(
                async () =>
                    (await json<{ run: { status: string } }>(page, runPath)).run
                        .status,
                { timeout: 180_000, intervals: [2000] },
            )
            .toBe('succeeded');
        before = await patches(page, runPath, ids.runId!);
        await page.goto(projectPage);
        const confirm = page.getByRole('group', { name: '确认删除文件' });
        const open = row(src.path).getByRole('button', { name: '删除文件' });
        await open.click();
        await expect(confirm).toContainText(src.path);
        await expect(confirm).toContainText('已有任务与补丁仍可查看');
        await confirm.getByRole('button', { name: '保留文件' }).click();
        expect(sha(await download(page, fileLink(src.path)))).toBe(sha(source));
        await open.click();
        await save('T3 delete file');
        const path = files + src.id;
        const deleting = responseFor(page, 'DELETE', path);
        await confirm.getByRole('button', { name: '确认删除' }).click();
        expect([202, 204]).toContain((await deleting).status());
        await missing(path + '/download');
        await missing(path + '/preview');
        let sawDeleting = false;
        await expect
            .poll(
                async () => {
                    const current = await space();
                    if (
                        current.uploads.some(
                            (u) => u.id === src.id && u.state === 'deleting',
                        )
                    ) {
                        sawDeleting = true;
                        expect(current.saved).toBe(initial.saved);
                    }
                    if (current.saved !== retained.length) return false;
                    expect(current.reserved).toBe(initial.reserved);
                    return observe(storage, 'head-absent', sourceKey);
                },
                { timeout: 120_000, intervals: [2000] },
            )
            .toBe(true);
        console.log('T3 deleting projection observed:', sawDeleting);
        await expectReplay(path);
        expect(await space()).toMatchObject({
            saved: retained.length,
            reserved: 0,
        });
        expect(sha(await download(page, fileLink(keep.path)))).toBe(
            sha(retained),
        );
        expect(
            await observe(
                storage,
                'head-saved',
                keepKey,
                String(retained.length),
            ),
        ).toBe(true);
        await page.goto('/tasks/' + ids.taskId);
        expect((await page.request.get(taskPath)).status()).toBe(200);
        expect((await page.request.get(runPath)).status()).toBe(200);
        const after = await patches(page, runPath, ids.runId!);
        expect(after.result).toEqual(before.result);
        for (const [i, bytes] of after.bytes.entries())
            expect(bytes.equals(before.bytes[i]!)).toBe(true);
        await save('T3 passed');
    });
    await test.step('T4 WEB-03-06 multipart 清理', async () => {
        await page.goto(projectPage);
        ids.multipartUploadId = randomUUID();
        const id = ids.multipartUploadId;
        const key = 'space/' + id;
        const upload = uploads + id;
        await save('T4 reserve');
        const checksum = (length: number) =>
            createHash('sha256').update(Buffer.alloc(length)).digest('base64');
        const create = await page.request.post(projectApi + '/uploads', {
            headers,
            data: {
                id,
                path: 'pending.bin',
                size: uploadSize,
                checksums: [checksum(partSize), checksum(1)],
            },
        });
        expect(create.status()).toBe(200);
        const signed = await page.request.post(upload + '/part', {
            headers,
            data: { number: 1 },
        });
        expect(signed.status()).toBe(200);
        const signature = (await signed.json()) as {
            url: string;
            checksum: string;
        };
        const put = await page.evaluate(
            async ({ signed, length }) => {
                try {
                    const r = await fetch(signed.url, {
                        method: 'PUT',
                        headers: { 'x-amz-checksum-sha256': signed.checksum },
                        body: new Blob([new Uint8Array(length)]),
                    });
                    return r.status;
                } catch {
                    return 0;
                }
            },
            { signed: signature, length: partSize },
        );
        expect(put).toBeGreaterThanOrEqual(200);
        expect(put).toBeLessThan(300);
        expect((await json<Upload>(page, upload)).parts).toEqual([1]);
        expect(await observe(storage, 'part-one', key, String(partSize))).toBe(
            true,
        );
        await page.reload();
        await page
            .getByRole('button', { name: '删除项目', exact: true })
            .click();
        await expect(projectConfirm).toContainText('未清理上传 1');
        await expect(projectConfirm).toContainText(
            '请先取消并清理未完成的上传。',
        );
        await expect(
            projectConfirm.getByRole('button', { name: '确认删除' }),
        ).toBeDisabled();
        const blocked = async () => {
            const response = await remove(projectApi);
            expect(response.status()).toBe(409);
            expect((await response.json()).error.code).toBe('upload_pending');
        };
        await blocked();
        expect(sha(await download(page, fileLink('keep/keep.txt')))).toBe(
            sha(retained),
        );
        await projectConfirm
            .getByRole('button', { name: '取消', exact: true })
            .click();
        await save('T4 cancel');
        const cancelled = responseFor(page, 'POST', upload + '/cancel');
        await page
            .getByRole('listitem')
            .filter({ hasText: 'pending.bin' })
            .getByRole('button', { name: '取消上传' })
            .click();
        expect((await cancelled).status()).toBe(200);
        expect(await space()).toMatchObject({
            saved: retained.length,
            reserved: uploadSize,
        });
        expect((await json<Upload>(page, upload)).state).toBe('cleaning');
        await blocked();
        expect(await observe(storage, 'part-one', key, String(partSize))).toBe(
            true,
        );
        await expect
            .poll(
                async () => {
                    const current = await space();
                    const pending = current.uploads.find((u) => u.id === id)!;
                    if (pending.state === 'cleaning') {
                        expect(current.reserved).toBe(uploadSize);
                        return false;
                    }
                    expect(pending.state).toBe('cancelled');
                    expect(current.reserved).toBe(0);
                    return (
                        (await observe(storage, 'multipart-absent', key)) &&
                        (await observe(storage, 'head-absent', key))
                    );
                },
                { timeout: 720_000, intervals: [2000] },
            )
            .toBe(true);
        expect(
            (await page.request.post(upload + '/cancel', { headers })).status(),
        ).toBe(200);
        expect(await space()).toMatchObject({
            reserved: 0,
            saved: retained.length,
        });
        const impact = await json<{ blockers: string[] }>(
            page,
            projectApi + '/deletion',
        );
        expect(impact.blockers).not.toContain('upload_pending');
        await save('T4 passed');
    });
    await test.step('T5 WEB-03-02 整项目', async () => {
        expect(await observe(runtime, 'capture', ids.taskId!)).toBe(true);
        await page.reload();
        await page
            .getByRole('button', { name: '删除项目', exact: true })
            .click();
        await expect(projectConfirm).toContainText(
            '项目文件、执行工作区、任务历史和补丁将一并删除',
        );
        expect(sha(await download(page, fileLink('keep/keep.txt')))).toBe(
            sha(retained),
        );
        const current = await patches(page, runPath, ids.runId!);
        for (const [i, bytes] of current.bytes.entries())
            expect(bytes.equals(before.bytes[i]!)).toBe(true);
        await save('T5 delete project');
        const deleting = responseFor(page, 'DELETE', projectApi);
        await projectConfirm.getByRole('button', { name: '确认删除' }).click();
        expect([202, 204]).toContain((await deleting).status());
        await expect
            .poll(async () => (await remove(projectApi)).status(), {
                timeout: 120_000,
                intervals: [2000],
            })
            .toBe(204);
        for (const path of [
            projectApi,
            projectApi + '/deletion',
            files + ids.keepFileId + '/download',
            taskPath,
            runPath,
            runPath + '/results',
            ...bothViews.map(
                (view) => runPath + '/results/1/diff?view=' + view,
            ),
        ])
            await missing(path);
        const list = await json<{ items: { id: string }[] }>(
            page,
            '/api/tasks',
        );
        expect(list.items.some((t) => t.id === ids.taskId)).toBe(false);
        for (const key of [sourceKey, keepKey]) {
            expect(await observe(storage, 'head-absent', key)).toBe(true);
            expect(await observe(storage, 'multipart-absent', key)).toBe(true);
        }
        expect(await observe(runtime, 'absent', ids.taskId!)).toBe(true);
        await expectReplay(projectApi);
        expect(await space()).toMatchObject({
            projects: [],
            saved: 0,
            reserved: 0,
        });
        await save('T5 passed');
    });
});
