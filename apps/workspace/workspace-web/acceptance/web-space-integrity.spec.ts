import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startSpaceIntegrityFixture } from './space-integrity-fixture.ts';

let fixture: Awaited<ReturnType<typeof startSpaceIntegrityFixture>>;
test.beforeAll(async () => {
    fixture = await startSpaceIntegrityFixture();
});
test.afterAll(async () => {
    await fixture?.close();
});

test('WEB-02-02 real selection rejects conflicts and preserves physical originals', async ({
    page,
}) => {
    const password = randomUUID();
    await page.goto('/login');
    await page.getByRole('link', { name: '使用邀请码注册' }).click();
    const registration = page.locator('form').filter({
        has: page.getByRole('heading', { name: '受邀注册', exact: true }),
    });
    await registration.getByLabel('账号').fill('demo');
    await registration.getByLabel('邀请码').fill('demo-invite');
    await registration.getByLabel('新密码').fill(password);
    await registration
        .getByRole('button', { name: '注册', exact: true })
        .click();
    await expect(page).toHaveURL(/\/login(?:\?|$)/);
    await page.getByLabel('账号').fill('demo');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(
        page.getByRole('button', { name: '退出登录', exact: true }),
    ).toBeVisible();
    await page.goto('/space/' + fixture.space.projectId);
    await expect(
        page.getByRole('heading', { name: '上传文件', exact: true }),
    ).toBeVisible();
    const directory = await mkdtemp(join(tmpdir(), 'bento-space-browser-'));
    const writes: string[] = [];
    page.on('request', (request) => {
        if (['POST', 'PUT', 'DELETE'].includes(request.method()))
            writes.push(
                request.method() + ' ' + new URL(request.url()).pathname,
            );
    });
    const baseline = fixture.space.rows('space_uploads');
    const file = page.getByLabel('文件', { exact: true });
    const folder = page.getByLabel('文件夹', { exact: true });
    const checklist = page.getByRole('region', { name: '上传前清单' });
    const confirm = page.getByRole('button', { name: '确认上传', exact: true });
    async function protectedOriginals() {
        expect(writes).toEqual([]);
        assert.deepEqual(fixture.space.rows('space_uploads'), baseline);
        const response = await fixture.space.request('/api/space');
        assert(
            response.json &&
                typeof response.json === 'object' &&
                !Array.isArray(response.json),
        );
        assert.equal(response.json.saved, 9);
        assert.equal(response.json.reserved, 0);
        for (const original of fixture.originals) {
            assert.deepEqual(
                await fixture.space.readObject(original.id),
                original.bytes,
            );
            assert.deepEqual(
                await fixture.space.download(original.id),
                original.bytes,
            );
        }
    }
    async function discard() {
        await page
            .getByRole('button', { name: '放弃本次选择', exact: true })
            .click();
        await expect(checklist).toHaveCount(0);
    }
    try {
        await test.step('duplicate target from two real files shows its own reason', async () => {
            const paths: string[] = [];
            for (const name of ['one', 'two']) {
                await mkdir(join(directory, name));
                const path = join(directory, name, 'duplicate.txt');
                await writeFile(path, 'abc');
                paths.push(path);
            }
            await file.setInputFiles(paths);
            await expect(checklist.getByRole('listitem')).toHaveCount(2);
            await expect(checklist).toContainText('清单内目标路径重复。');
            await expect(confirm).toBeDisabled();
            await protectedOriginals();
            await discard();
        });
        await test.step('saved target is rejected before registration', async () => {
            const path = join(directory, 'saved.txt');
            await writeFile(path, 'new');
            await file.setInputFiles(path);
            await expect(checklist).toContainText('目标路径已被占用。');
            await expect(confirm).toBeDisabled();
            await protectedOriginals();
            await discard();
        });
        await test.step('saved file blocks a selected real directory', async () => {
            const path = join(directory, 'prefix');
            await mkdir(path);
            await writeFile(join(path, 'child.txt'), 'new');
            await folder.setInputFiles(path);
            await expect(checklist).toContainText('prefix/child.txt');
            await expect(checklist).toContainText('目标路径已被占用。');
            await expect(confirm).toBeDisabled();
            await protectedOriginals();
            await discard();
        });
        await test.step('saved directory blocks a selected real file', async () => {
            const path = join(directory, 'dir');
            await writeFile(path, 'new');
            await file.setInputFiles(path);
            await expect(checklist).toContainText('目标路径已被占用。');
            await expect(confirm).toBeDisabled();
            await protectedOriginals();
            await discard();
        });
        await test.step('normal control file uploads through the same real HTTP storage', async () => {
            const path = join(directory, 'normal.txt');
            await writeFile(path, 'abc');
            await file.setInputFiles(path);
            await expect(checklist).toContainText('待上传');
            await expect(confirm).toBeEnabled();
            await confirm.click();
            await expect
                .poll(
                    () =>
                        fixture.space
                            .rows('space_uploads')
                            .filter((row) => row.state === 'saved').length,
                )
                .toBe(4);
            const saved = fixture.space
                .rows('space_uploads')
                .find((row) => row.path === 'normal.txt');
            assert(saved && typeof saved.id === 'string');
            assert.deepEqual(
                await fixture.space.download(saved.id),
                Buffer.from('abc'),
            );
            expect(
                writes.some((request) => request.startsWith('PUT /parts/')),
            ).toBe(true);
            for (const original of fixture.originals)
                assert.deepEqual(
                    await fixture.space.download(original.id),
                    original.bytes,
                );
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
