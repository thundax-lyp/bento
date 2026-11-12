import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { mockBackend } from './mock.ts';
import { RequestError } from './protocol.ts';
import { mySpace } from './space.ts';
import { spaceObjectKey, spaceStorage } from './space-storage.ts';

const noBody = () => Promise.reject(new Error('Unexpected request body'));
const errorIs =
    (status: number, code: string, message: string) => (error: unknown) =>
        error instanceof RequestError &&
        error.status === status &&
        error.code === code &&
        error.message === message;
const notFound = errorIs(404, 'not_found', '找不到该资源。');

test('preview signs only readable saved files within the byte limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bento-space-files-'));
    const dbPath = join(dir, 'space.sqlite');
    const storage = spaceStorage('http://127.0.0.1:1', 'fixture', 'us-east-1');
    const calls: string[] = [];
    storage.preview = async (key) => {
        calls.push('preview ' + key);
        return 'https://fixture.invalid/read';
    };
    storage.download = async (key, name) => {
        calls.push('download ' + key + ' ' + name);
        return 'https://fixture.invalid/download';
    };
    const space = mySpace(dbPath, storage, mockBackend());
    try {
        const owner = 'owner-a';
        const project = randomUUID();
        const empty = randomUUID();
        const exact = randomUUID();
        const large = randomUUID();
        const pending = randomUUID();
        const db = new DatabaseSync(dbPath);
        try {
            db.prepare('INSERT INTO space_projects VALUES (?, ?, ?)').run(
                project,
                owner,
                'Fixture',
            );
            const insert = db.prepare(`
                INSERT INTO space_uploads (id, project, owner, path, size, manifest, state, expires)
                VALUES (?, ?, ?, ?, ?, '[]', ?, 0)
            `);
            insert.run(empty, project, owner, 'empty.txt', 0, 'saved');
            insert.run(
                exact,
                project,
                owner,
                'folder/exact.txt',
                262144,
                'saved',
            );
            insert.run(large, project, owner, 'large.txt', 262145, 'saved');
            insert.run(pending, project, owner, 'pending.txt', 1, 'uploading');
        } finally {
            db.close();
        }
        const preview = (caller: string, id: string) =>
            space.route(
                caller,
                'GET',
                '/api/space/files/' + id + '/preview',
                noBody,
            );
        for (const id of [empty, exact]) {
            assert.deepEqual(await preview(owner, id), {
                redirect: 'https://fixture.invalid/read',
            });
        }
        await assert.rejects(
            preview(owner, large),
            errorIs(413, 'preview_too_large', '文件超过 256 KiB，无法预览。'),
        );
        await assert.rejects(preview('owner-b', exact), notFound);
        await assert.rejects(preview('owner-b', large), notFound);
        await assert.rejects(preview(owner, randomUUID()), notFound);
        await assert.rejects(preview(owner, pending), notFound);
        assert.deepEqual(
            await space.route(
                owner,
                'GET',
                '/api/space/files/' + exact + '/download',
                noBody,
            ),
            { redirect: 'https://fixture.invalid/download' },
        );
        assert.deepEqual(calls, [
            'preview ' + spaceObjectKey(empty),
            'preview ' + spaceObjectKey(exact),
            'download ' + spaceObjectKey(exact) + ' exact.txt',
        ]);
    } finally {
        await space.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('file deletion retains quota until storage and execution cleanup are confirmed', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const dir = await mkdtemp(join(tmpdir(), 'bento-space-delete-'));
    const dbPath = join(dir, 'space.sqlite');
    const owner = 'owner-a';
    const projectId = randomUUID();
    const fileId = randomUUID();
    const executionProjectId = randomUUID();
    const objectKey = spaceObjectKey(fileId);
    const bytes = 7;
    const storage = spaceStorage('http://127.0.0.1:1', 'fixture', 'us-east-1');
    let exists = true;
    const heads: string[] = [];
    const deletes: string[] = [];
    storage.size = async (key) => {
        heads.push(key);
        return exists ? bytes : null;
    };
    storage.remove = async (key) => {
        deletes.push(key);
        exists = false;
        throw new Error('Fixture lost object deletion receipt');
    };
    storage.preview = async () => {
        throw new Error('Unexpected preview signature');
    };
    storage.download = async () => {
        throw new Error('Unexpected download signature');
    };

    const acquire: string[] = [];
    const release: string[] = [];
    const fallback = mockBackend();
    const spaceBackend: typeof fallback = async (caller, operation) => {
        if (operation.kind === 'acquireFileDeleteHold') {
            assert.equal(caller, owner);
            assert.equal(operation.projectId, executionProjectId);
            acquire.push(operation.operationId);
            if (acquire.length === 1)
                return { status: 200, json: { state: 'denied' } };
            if (acquire.length === 2)
                throw new Error('Fixture lost acquisition receipt');
            return { status: 200, json: { state: 'held' } };
        }
        if (operation.kind === 'releaseFileDeleteHold') {
            assert.equal(caller, owner);
            assert.equal(operation.projectId, executionProjectId);
            release.push(operation.operationId);
            if (release.length === 1)
                throw new Error('Fixture lost release receipt');
            return { status: 200, json: { state: 'released' } };
        }
        return fallback(caller, operation);
    };

    let space = mySpace(dbPath, storage, spaceBackend);
    const filePath = '/api/space/files/' + fileId;
    const remove = (caller = owner, path = filePath) =>
        space.route(caller, 'DELETE', path, noBody);
    async function spaceView() {
        const result = await space.route(owner, 'GET', '/api/space', noBody);
        assert('uploads' in result && result.uploads);
        return { uploads: result.uploads, saved: result.saved };
    }
    async function projectView() {
        const result = await space.route(
            owner,
            'GET',
            '/api/space/projects/' + projectId,
            noBody,
        );
        assert(
            'files' in result &&
                result.files &&
                result.execution &&
                'inputs' in result.execution,
        );
        return { files: result.files, inputs: result.execution.inputs };
    }
    async function sweep() {
        t.mock.timers.tick(30000);
        // All fixture I/O resolves in microtasks. The next turn observes the sweep result.
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    try {
        const seed = new DatabaseSync(dbPath);
        try {
            seed.prepare('INSERT INTO space_projects VALUES (?, ?, ?)').run(
                projectId,
                owner,
                'Fixture',
            );
            seed.prepare(
                `
                INSERT INTO space_uploads (id, project, owner, path, size, manifest, state, expires)
                VALUES (?, ?, ?, 'file.txt', ?, '[]', 'saved', 0)
            `,
            ).run(fileId, projectId, owner, bytes);
            seed.prepare(
                `
                INSERT INTO space_execution (spaceId, owner, key, state, inputs, projectId)
                VALUES (?, ?, 'initialization', 'validating', ?, NULL)
            `,
            ).run(
                projectId,
                owner,
                JSON.stringify([
                    { fileId, path: 'file.txt', size: bytes, manifest: '[]' },
                ]),
            );

            await assert.rejects(remove('owner-b'), notFound);
            await assert.rejects(
                remove(owner, '/api/space/files/' + randomUUID()),
                notFound,
            );
            await assert.rejects(
                remove(),
                errorIs(409, 'project_importing', '文件正在用于初始化工作区。'),
            );
            assert.deepEqual(acquire, []);
            seed.prepare(
                "UPDATE space_execution SET state='ready', projectId=? WHERE spaceId=?",
            ).run(executionProjectId, projectId);
        } finally {
            seed.close();
        }

        await assert.rejects(
            remove(),
            errorIs(409, 'project_busy', '文件正在被未结束的任务使用。'),
        );
        assert.equal((await spaceView()).uploads[0]?.state, 'saved');
        await assert.rejects(
            remove(),
            errorIs(
                503,
                'file_delete_unconfirmed',
                '暂未确认删除结果，请刷新后重试。',
            ),
        );
        assert.equal((await spaceView()).uploads[0]?.state, 'saved');

        assert.deepEqual(await remove(), { deleteStatus: 202 });
        assert.deepEqual(await remove(), { deleteStatus: 202 });
        assert.notEqual(acquire[0], acquire[1]);
        assert.equal(acquire[1], acquire[2]);
        assert.equal(acquire.length, 3);
        assert.equal((await spaceView()).uploads[0]?.state, 'deleting');
        assert.equal((await spaceView()).saved, bytes);
        for (const action of ['preview', 'download'])
            await assert.rejects(
                space.route(owner, 'GET', filePath + '/' + action, noBody),
                notFound,
            );
        assert.deepEqual((await projectView()).files, []);
        assert.deepEqual((await projectView()).inputs, [
            { fileId, path: 'file.txt', size: bytes, available: false },
        ]);

        await sweep();
        assert.equal((await spaceView()).saved, bytes);
        assert.deepEqual(heads, [objectKey]);
        assert.deepEqual(deletes, [objectKey]);
        assert.deepEqual(release, []);
        await space.close();

        space = mySpace(dbPath, storage, spaceBackend);
        await sweep();
        assert.deepEqual(heads, [objectKey, objectKey]);
        assert.deepEqual(deletes, [objectKey]);
        assert.deepEqual(release, [acquire[1]]);
        assert.equal((await spaceView()).saved, bytes);
        assert.deepEqual(await remove(), { deleteStatus: 202 });

        await sweep();
        assert.deepEqual(release, [acquire[1], acquire[1]]);
        assert.deepEqual(heads, [objectKey, objectKey]);
        assert.deepEqual(await remove(), { deleteStatus: 204 });
        assert.deepEqual(await remove(), { deleteStatus: 204 });
        await assert.rejects(remove('owner-b'), notFound);
        assert.equal((await spaceView()).saved, 0);
        assert.deepEqual((await spaceView()).uploads, []);
        assert.deepEqual((await projectView()).inputs, [
            { fileId, path: 'file.txt', size: bytes, available: false },
        ]);
        const tombstone = await space.route(
            owner,
            'GET',
            '/api/space/uploads/' + fileId,
            noBody,
        );
        assert('state' in tombstone && tombstone.state === 'deleted');
    } finally {
        await space.close();
        await rm(dir, { recursive: true, force: true });
    }
});
