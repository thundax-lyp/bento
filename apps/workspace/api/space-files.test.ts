import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { localHost } from '../../orchestrator/execution-service/local.ts';
import { serveExecution } from '../../orchestrator/execution-service/service.ts';
import { mockAccounts } from './account-store.ts';
import { sessionAuth } from './auth.ts';
import { httpBackend } from './execution-service-http.ts';
import { taskEntryServer } from './server.ts';
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

test('project deletion space retains frozen progress and retires object IDs globally', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const dir = await mkdtemp(join(tmpdir(), 'bento-project-space-'));
    const dbPath = join(dir, 'space.sqlite');
    const owner = 'owner-a';
    const other = 'owner-b';
    const target = randomUUID();
    const otherProject = randomUUID();
    const extra = randomUUID();
    const accountTarget = randomUUID();
    const accountOther = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    const extraFile = randomUUID();
    const pendingUpload = randomUUID();
    const binding = randomUUID();
    const path = '/api/space/projects/' + target;
    const otherPath = '/api/space/projects/' + otherProject;
    const storage = spaceStorage('http://127.0.0.1:1', 'fixture', 'us-east-1');
    const objects = new Map([
        [spaceObjectKey(first), 7],
        [spaceObjectKey(second), 11],
        [spaceObjectKey(extraFile), 3],
    ]);
    const removed: string[] = [];
    const operations: string[] = [];
    let headUnknown = false;
    let deny = true;
    let executionReady = false;
    let releaseUpload = () => {};
    const uploadGate = new Promise<void>((resolve) => {
        releaseUpload = resolve;
    });
    let uploading = () => {};
    const uploadStarted = new Promise<void>((resolve) => {
        uploading = resolve;
    });
    storage.size = async (key) => {
        if (key === spaceObjectKey(second) && headUnknown)
            throw new Error('HEAD unknown');
        return objects.get(key) ?? null;
    };
    storage.remove = async (key) => {
        removed.push(key);
        objects.delete(key);
        if (key === spaceObjectKey(second))
            throw new Error('Lost storage receipt');
    };
    storage.download = async (key) => 'https://fixture.invalid/' + key;
    storage.abort = async () => {};
    storage.create = async () => {
        uploading();
        await uploadGate;
        return 'fixture-multipart';
    };
    storage.empty = async () => {
        throw new Error('Retired ID must never write an object');
    };
    const backend: ReturnType<typeof mockBackend> = async (
        caller,
        operation,
    ) => {
        assert.equal(caller, owner);
        if (operation.kind === 'projectDeletionImpact') {
            assert.equal(operation.projectId, binding);
            return {
                status: 200,
                json: { runCount: 2, diffCount: 1, blockers: [] },
            };
        }
        assert.equal(operation.kind, 'advanceProjectDeletion');
        assert.equal(operation.projectId, binding);
        operations.push(operation.operationId);
        if (deny)
            throw new RequestError(409, 'project_busy', 'fixture rejection');
        if (operations.length === 2) throw new Error('Lost execution receipt');
        return executionReady
            ? { status: 204 }
            : { status: 202, json: { state: 'deleting' } };
    };
    let space = mySpace(dbPath, storage, backend);
    const sql = new DatabaseSync(dbPath);
    const request = (
        caller: string,
        method: string,
        url: string,
        body?: unknown,
        keys?: string[],
    ) =>
        space.route(
            caller,
            method,
            url,
            body === undefined ? noBody : async () => body,
            keys,
        );
    const remove = (caller = owner, url = path) =>
        request(caller, 'DELETE', url);
    const view = async (caller = owner) => {
        const data = await request(caller, 'GET', '/api/space');
        assert('projects' in data && data.projects && 'saved' in data);
        return data;
    };
    const sweep = async () => {
        t.mock.timers.tick(30_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const seedUpload = (
        id: string,
        project: string,
        caller: string,
        size: number,
        state: string,
    ) =>
        sql
            .prepare(
                'INSERT INTO space_uploads (id, project, owner, path, size, manifest, state, expires) VALUES (?,?,?,?,?,?,?,?)',
            )
            .run(
                id,
                project,
                caller,
                id + '.txt',
                size,
                '[]',
                state,
                Date.now() + 60_000,
            );
    const reserve = (caller: string, url: string, id: string) =>
        request(caller, 'POST', url + '/uploads', {
            id,
            path: 'new.txt',
            size: 0,
            checksums: [],
        });
    try {
        for (const [id, caller] of [
            [target, owner],
            [otherProject, other],
            [extra, owner],
            [accountTarget, other],
            [accountOther, other],
        ]) {
            assert(id && caller);
            sql.prepare('INSERT INTO space_projects VALUES (?,?,?)').run(
                id,
                caller,
                'Fixture',
            );
        }
        seedUpload(first, target, owner, 7, 'saved');
        seedUpload(second, target, owner, 11, 'saved');
        seedUpload(extraFile, extra, owner, 3, 'saved');
        const upload = request(owner, 'POST', path + '/uploads', {
            id: pendingUpload,
            path: 'pending.txt',
            size: 1,
            checksums: [createHash('sha256').update('x').digest('base64')],
        });
        await uploadStarted;
        await assert.rejects(remove(), { code: 'upload_pending' });
        releaseUpload();
        await upload;
        sql.prepare("UPDATE space_uploads SET state='cleaning' WHERE id=?").run(
            pendingUpload,
        );
        const fileUrl = '/api/space/files/' + first + '/download';
        assert.deepEqual(await request(owner, 'GET', path + '/deletion'), {
            fileCount: 2,
            uploadCount: 1,
            runCount: 0,
            diffCount: 0,
            blockers: ['upload_pending'],
        });
        assert('redirect' in (await request(owner, 'GET', fileUrl)));
        await assert.rejects(remove(), { code: 'upload_pending' });
        sql.prepare(
            "UPDATE space_uploads SET state='cancelled' WHERE id=?",
        ).run(pendingUpload);

        assert.deepEqual(
            await request(
                owner,
                'POST',
                path + '/execution',
                { fileIds: [first] },
                ['init'],
            ).then((data) => 'executionStatus' in data && data.executionStatus),
            202,
        );
        await assert.rejects(remove(), { code: 'project_importing' });
        sql.prepare(
            "UPDATE space_execution SET state='importing' WHERE spaceId=?",
        ).run(target);
        await assert.rejects(remove(), { code: 'project_importing' });
        sql.prepare(
            "UPDATE space_execution SET state='ready', projectId=? WHERE spaceId=?",
        ).run(binding, target);
        sql.prepare(
            "INSERT INTO space_file_deletions VALUES (?,?,?,'checking')",
        ).run(first, randomUUID(), binding);
        await assert.rejects(remove(), { code: 'project_delete_unconfirmed' });
        sql.prepare('DELETE FROM space_file_deletions WHERE fileId=?').run(
            first,
        );
        assert.deepEqual(await request(owner, 'GET', path + '/deletion'), {
            fileCount: 2,
            uploadCount: 0,
            runCount: 2,
            diffCount: 1,
            blockers: [],
        });
        await assert.rejects(remove(other), notFound);
        await assert.rejects(remove(), { code: 'project_busy' });
        assert('redirect' in (await request(owner, 'GET', fileUrl)));
        deny = false;
        await assert.rejects(remove(), {
            status: 503,
            code: 'project_delete_unconfirmed',
        });
        await assert.rejects(reserve(owner, path, randomUUID()), {
            code: 'project_busy',
        });
        await assert.rejects(
            request(owner, 'POST', path + '/execution', { fileIds: [first] }, [
                'after-delete',
            ]),
            { code: 'project_busy' },
        );
        await assert.rejects(request(owner, 'GET', fileUrl), notFound);
        assert.equal((await view()).saved, 21);
        assert.deepEqual(await remove(), { deleteStatus: 202 });
        assert.equal(space.drain(owner), false);
        assert.equal(await space.purge(owner), false);
        assert.deepEqual(removed, []);
        assert.equal(space.drain(other), true);
        await assert.rejects(
            remove(other, '/api/space/projects/' + accountTarget),
            { status: 409, code: 'project_busy' },
        );

        await space.close();
        space = mySpace(dbPath, storage, backend);
        await assert.rejects(remove(owner, '/api/space/projects/' + extra), {
            code: 'project_busy',
        });
        await assert.rejects(
            remove(other, '/api/space/projects/' + accountOther),
            { code: 'project_busy' },
        );
        headUnknown = true;
        executionReady = true;
        await sweep();
        assert.equal(operations[2], operations[1]);
        assert.equal(operations[3], operations[1]);
        assert.notEqual(operations[0], operations[1]);
        assert.equal((await view()).saved, 14);
        assert.deepEqual(removed, [spaceObjectKey(first)]);
        assert.equal(await space.purge(owner), false);
        headUnknown = false;
        await sweep();
        assert.equal((await view()).saved, 14);
        assert.equal(objects.has(spaceObjectKey(second)), false);
        await space.close();
        space = mySpace(dbPath, storage, backend);
        await sweep();
        assert.equal((await view()).saved, 3);
        assert.deepEqual(await remove(), { deleteStatus: 204 });
        assert.deepEqual(await remove(), { deleteStatus: 204 });
        assert.equal((await view()).saved, 3);
        await assert.rejects(remove(other), notFound);
        await assert.rejects(
            request(owner, 'GET', path + '/deletion'),
            notFound,
        );
        await assert.rejects(request(owner, 'GET', path), notFound);
        await assert.rejects(
            request('owner-c', 'POST', '/api/space/projects', {
                id: target,
                name: 'Fixture',
            }),
            notFound,
        );
        // A third active owner is required because the other two owners are draining.
        const remaining = 'owner-c';
        const remainingProject = randomUUID();
        await request(remaining, 'POST', '/api/space/projects', {
            id: remainingProject,
            name: 'Remaining',
        });
        const remainingPath = '/api/space/projects/' + remainingProject;
        for (const id of [first, second, pendingUpload])
            await assert.rejects(
                reserve(remaining, remainingPath, id),
                notFound,
            );
        assert.equal(await space.purge(owner), true);
        await assert.rejects(
            reserve(remaining, remainingPath, extraFile),
            notFound,
        );
        await space.close();
        space = mySpace(dbPath, storage, backend);
        for (const id of [first, second, extraFile, pendingUpload])
            await assert.rejects(
                reserve(remaining, remainingPath, id),
                notFound,
            );
        assert.deepEqual([...objects], []);
        assert.equal((await view(remaining)).saved, 0);
        assert.equal((await view(remaining)).reserved, 0);
        assert.equal(
            (await view(other)).projects.some(
                (project) => project.id === otherPath.split('/').at(-1),
            ),
            true,
        );
    } finally {
        releaseUpload();
        sql.close();
        await space.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('project deletion crosses both HTTP boundaries', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const dir = await mkdtemp(join(tmpdir(), 'bento-project-bridge-'));
    const dbPath = join(dir, 'space.sqlite');
    const token = 'fixture-only-project-deletion-token';
    const origin = 'http://127.0.0.1:32123';
    const owner = { ownerId: 'owner-a', account: 'a', inviteSha256: '' };
    const other = { ownerId: 'owner-b', account: 'b', inviteSha256: '' };
    const auth = sessionAuth(mockAccounts([owner, other]), false);
    const fixtureRequest = { headers: {} } as Parameters<
        typeof auth.startSession
    >[0];
    const cookieA = auth
        .startSession(fixtureRequest, owner)
        .cookie.split(';')[0];
    const cookieB = auth
        .startSession(fixtureRequest, other)
        .cookie.split(';')[0];
    assert(cookieA && cookieB);
    const storage = spaceStorage('http://127.0.0.1:1', 'fixture', 'us-east-1');
    const objects = new Map<string, Buffer>();
    storage.read = async (key) => {
        const bytes = objects.get(key);
        assert(bytes);
        return Buffer.from(bytes);
    };
    storage.size = async (key) => objects.get(key)?.length ?? null;
    storage.remove = async (key) => {
        objects.delete(key);
    };
    storage.download = async (key) => 'https://fixture.invalid/' + key;
    const execution = await serveExecution({
        state: join(dir, 'exec'),
        token,
        retryMs: 20,
        host: localHost(join(dir, 'volume')),
    });
    const backend = httpBackend(execution.url, token, 3000);
    const space = mySpace(dbPath, storage, backend);
    let web: Awaited<ReturnType<typeof taskEntryServer>> | undefined;
    async function waitFor<T>(
        read: () => Promise<T>,
        done: (value: T) => boolean,
    ) {
        const limit = Date.now() + 5000;
        do {
            const value = await read();
            if (done(value)) return value;
            await delay(20);
        } while (Date.now() < limit);
        throw new Error('Fixture state did not settle');
    }
    try {
        web = await taskEntryServer({ port: 0, origin, auth, space, backend });
        const request = async (
            path: string,
            cookie: string,
            method = 'GET',
            input?: unknown,
            key?: string,
            requestOrigin = origin,
        ) => {
            const res = await fetch(web!.origin + path, {
                method,
                headers: {
                    Cookie: cookie,
                    Origin: requestOrigin,
                    ...(key ? { 'Idempotency-Key': key } : {}),
                    ...(input === undefined
                        ? {}
                        : { 'Content-Type': 'application/json' }),
                },
                ...(input === undefined ? {} : { body: JSON.stringify(input) }),
                redirect: 'manual',
                signal: AbortSignal.timeout(5000),
            });
            const text = await res.text();
            return {
                status: res.status,
                text,
                json: () => JSON.parse(text) as Record<string, unknown>,
            };
        };
        async function seed(caller: typeof owner, cookie: string) {
            const project = randomUUID();
            const file = randomUUID();
            const bytes = Buffer.from('# Fixture\n');
            const path = '/api/space/projects/' + project;
            assert.equal(
                (
                    await request('/api/space/projects', cookie, 'POST', {
                        id: project,
                        name: 'Fixture',
                    })
                ).status,
                200,
            );
            const sql = new DatabaseSync(dbPath);
            try {
                sql.prepare(
                    `INSERT INTO space_uploads (id,project,owner,path,size,manifest,state,expires)
                    VALUES (?,?,?,'README.md',?,?,'saved',0)`,
                ).run(
                    file,
                    project,
                    caller.ownerId,
                    bytes.length,
                    JSON.stringify([
                        createHash('sha256').update(bytes).digest('base64'),
                    ]),
                );
            } finally {
                sql.close();
            }
            objects.set(spaceObjectKey(file), bytes);
            assert.equal(
                (
                    await request(
                        path + '/execution',
                        cookie,
                        'POST',
                        { fileIds: [file] },
                        'initialize',
                    )
                ).status,
                202,
            );
            const binding = await waitFor(async () => {
                t.mock.timers.tick(2000);
                const detail = (await request(path, cookie)).json()
                    .execution as { state: string; projectId?: string };
                return detail.state === 'ready' ? detail.projectId : undefined;
            }, Boolean);
            assert(binding);
            const runs = '/api/projects/' + binding + '/runs';
            const created = await request(
                runs,
                cookie,
                'POST',
                { prompt: 'change' },
                'run-key',
            );
            assert.equal(created.status, 202);
            const run = runs + '/' + created.json().id;
            await waitFor(
                () => request(run, cookie),
                (result) => result.json().status === 'succeeded',
            );
            return { path, run, file, bytes: bytes.length };
        }
        const a = await seed(owner, cookieA);
        const b = await seed(other, cookieB);
        const fileUrl = '/api/space/files/' + a.file + '/download';
        assert.equal((await request(fileUrl, cookieA)).status, 302);
        assert.equal(
            (await request(a.run + '/diff?download=1', cookieA)).status,
            200,
        );
        assert.deepEqual(
            (await request(a.path + '/deletion', cookieA)).json(),
            {
                fileCount: 1,
                uploadCount: 0,
                runCount: 1,
                diffCount: 1,
                blockers: [],
            },
        );
        assert.equal((await request(a.path, cookieB, 'DELETE')).status, 404);
        const invalid = await request(
            a.path,
            cookieA,
            'DELETE',
            undefined,
            undefined,
            'http://invalid.example',
        );
        assert.equal(invalid.status, 400);
        assert.match(invalid.text, /invalid_origin/);
        const removed = await request(
            a.path,
            cookieA,
            'DELETE',
            undefined,
            'public-key-must-not-be-forwarded',
        );
        assert.equal(removed.status, 204);
        assert.equal(removed.text, '');
        assert.equal((await request(a.path, cookieA, 'DELETE')).status, 204);
        assert.equal((await request(a.path, cookieA)).status, 404);
        assert.equal(
            (await request(a.run + '/diff?download=1', cookieA)).status,
            404,
        );
        assert.equal((await request(fileUrl, cookieA)).status, 404);
        assert.equal((await request('/api/space', cookieA)).json().saved, 0);
        assert.equal(
            (await request('/api/space', cookieB)).json().saved,
            b.bytes,
        );
        assert.equal(
            (await request(b.run + '/diff?download=1', cookieB)).status,
            200,
        );
        assert.deepEqual([...objects.keys()], [spaceObjectKey(b.file)]);
    } finally {
        if (web) await web.close();
        else await space.close();
        await execution.close();
        await rm(dir, { recursive: true, force: true });
    }
});

const recoveryBytes = 16777219;
const recoveryPath = 'nested/fixture.bin';
const recoveryDownload = 'https://fixture.invalid/download';

type UploadRecoveryFixture = Awaited<
    ReturnType<typeof openUploadRecoveryFixture>
>;

async function openUploadRecoveryFixture() {
    const dir = await mkdtemp(join(tmpdir(), 'bento-upload-recovery-'));
    const dbPath = join(dir, 'space.sqlite');
    const origin = 'http://127.0.0.1:1';
    const owner = { ownerId: 'owner-a', account: 'a', inviteSha256: '' };
    const auth = sessionAuth(mockAccounts([owner]), false);
    const cookie = auth
        .startSession(
            { headers: {} } as Parameters<typeof auth.startSession>[0],
            owner,
        )
        .cookie.split(';')[0]!;
    const backend = mockBackend();
    const id = randomUUID();
    const project = randomUUID();
    const projectUrl = '/api/space/projects/' + project;
    const uploadUrl = '/api/space/uploads/' + id;
    const objectKey = spaceObjectKey(id);
    const storageId = 'fixture-multipart';
    const chunks = [Buffer.alloc(16777216, 1), Buffer.alloc(3, 2)];
    const digest = (bytes: Buffer) =>
        createHash('sha256').update(bytes).digest('base64');
    const checksums = chunks.map(digest);
    const signatures = new Map<
        string,
        { number: number; size: number; checksum: string }
    >();
    const parts = new Map<
        number,
        {
            PartNumber: number;
            Size: number;
            ETag: string;
            ChecksumSHA256: string;
        }
    >();
    const calls: unknown[][] = [];
    const stored = { active: false, size: null as number | null, writes: 0 };
    const storage = spaceStorage(origin, 'fixture', 'us-east-1');
    function record(operation: string, key: string, ...args: unknown[]) {
        assert.equal(key, objectKey);
        calls.push([operation, key, ...args]);
    }
    storage.create = async (key) => {
        record('create', key);
        assert.equal(stored.active, false);
        stored.active = true;
        return storageId;
    };
    storage.signPart = async (key, upload, number, size, checksum) => {
        record('signPart', key, upload, number, size, checksum);
        assert.equal(upload, storageId);
        assert(stored.active);
        assert.equal(size, chunks[number - 1]?.length);
        assert.equal(checksum, checksums[number - 1]);
        const url = `https://fixture.invalid/${key}?uploadId=${upload}&partNumber=${number}`;
        signatures.set(url, { number, size, checksum });
        return url;
    };
    function putPart(url: string, bytes: Buffer, checksum: string): void {
        const signature = signatures.get(url);
        assert(signature && stored.active);
        assert.equal(signature.size, bytes.length);
        assert.equal(signature.checksum, checksum);
        assert.equal(digest(bytes), checksum);
        parts.set(signature.number, {
            PartNumber: signature.number,
            Size: bytes.length,
            ETag: `"part-${signature.number}"`,
            ChecksumSHA256: checksum,
        });
    }
    storage.parts = async (key, upload) => {
        record('parts', key, upload);
        assert.equal(upload, storageId);
        return stored.active
            ? [...parts.values()].sort((a, b) => b.PartNumber - a.PartNumber)
            : null;
    };
    storage.complete = async (key, upload, completed) => {
        record('complete', key, upload, completed);
        assert.equal(upload, storageId);
        assert(stored.active);
        assert.equal(stored.writes, 0);
        assert.deepEqual(
            completed,
            [1, 2].map((number) => {
                const part = parts.get(number);
                assert(part);
                const { PartNumber, ETag, ChecksumSHA256 } = part;
                return { PartNumber, ETag, ChecksumSHA256 };
            }),
        );
        stored.active = false;
        parts.clear();
        stored.size = recoveryBytes;
        stored.writes++;
    };
    storage.size = async (key) => {
        record('size', key);
        return stored.size;
    };
    storage.abort = async (key, upload) => {
        record('abort', key, upload);
        if (upload !== undefined) assert.equal(upload, storageId);
        stored.active = false;
        parts.clear();
    };
    storage.remove = async (key) => {
        record('remove', key);
        stored.size = null;
    };
    storage.download = async (key, name) => {
        record('download', key, name);
        assert.notEqual(stored.size, null);
        return recoveryDownload;
    };
    storage.empty =
        storage.read =
        storage.preview =
            async () => {
                assert.fail('Unexpected storage call');
            };

    let web: Awaited<ReturnType<typeof taskEntryServer>> | undefined;
    async function reopen() {
        await web?.close();
        web = undefined;
        web = await taskEntryServer({
            port: 0,
            origin,
            auth,
            backend,
            space: mySpace(dbPath, storage, backend),
        });
    }
    async function request(
        path: string,
        method = 'GET',
        input?: unknown,
        signal?: AbortSignal,
    ) {
        assert(web);
        const timeout = AbortSignal.timeout(5000);
        const response = await fetch(web.origin + path, {
            method,
            headers: {
                Cookie: cookie,
                Origin: origin,
                'Content-Type': 'application/json',
            },
            ...(input === undefined ? {} : { body: JSON.stringify(input) }),
            redirect: 'manual',
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        const text = await response.text();
        return {
            status: response.status,
            location: response.headers.get('location'),
            json: text ? JSON.parse(text) : null,
        };
    }
    function row() {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
            const rows = db
                .prepare(
                    'SELECT state, storageId, signedUntil, cleanup FROM space_uploads WHERE id=?',
                )
                .all(id);
            assert.equal(rows.length, 1);
            const row = rows[0];
            assert(row);
            assert.equal(row.storageId, storageId);
            return row;
        } finally {
            db.close();
        }
    }
    async function sendPart(number: number) {
        const before = Date.now();
        const response = await request(uploadUrl + '/part', 'POST', { number });
        assert.equal(response.status, 200);
        const bytes = chunks[number - 1];
        assert(bytes);
        putPart(response.json.url, bytes, response.json.checksum);
        const signedUntil = row().signedUntil;
        assert(typeof signedUntil === 'number');
        assert(
            signedUntil >= before + 605000 &&
                signedUntil <= Date.now() + 605000,
        );
    }
    async function view(state: string, expectedParts: number[]) {
        const response = await request(uploadUrl);
        assert.equal(response.status, 200);
        assert.equal(response.json.id, id);
        assert.equal(response.json.state, state);
        assert.deepEqual(response.json.parts, expectedParts);
        assert.equal(row().state, state);
        return response.json;
    }
    async function projection(saved: number, reserved: number) {
        const usage = await request('/api/space');
        assert.equal(usage.status, 200);
        assert.equal(usage.json.saved, saved);
        assert.equal(usage.json.reserved, reserved);
        const detail = await request(projectUrl);
        assert.equal(detail.status, 200);
        assert.deepEqual(
            detail.json.files,
            saved ? [{ id, path: recoveryPath, size: recoveryBytes }] : [],
        );
        const download = await request('/api/space/files/' + id + '/download');
        assert.equal(download.status, saved ? 302 : 404);
        assert.equal(download.location, saved ? recoveryDownload : null);
        if (!saved) assert.equal(download.json.error.code, 'not_found');
    }
    async function savedOnce() {
        await view('saved', []);
        await projection(recoveryBytes, 0);
        assert.deepEqual(stored, {
            active: false,
            size: recoveryBytes,
            writes: 1,
        });
    }
    const complete = (signal?: AbortSignal) =>
        request(uploadUrl + '/complete', 'POST', {}, signal);
    async function close() {
        await web?.close();
        web = undefined;
    }
    const dispose = async () => {
        try {
            await close();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    };
    try {
        await reopen();
        assert.equal(
            (
                await request('/api/space/projects', 'POST', {
                    id: project,
                    name: 'Fixture',
                })
            ).status,
            200,
        );
        const started = await request(projectUrl + '/uploads', 'POST', {
            id,
            path: recoveryPath,
            size: recoveryBytes,
            checksums,
        });
        assert.equal(started.status, 200);
        assert.equal(started.json.state, 'uploading');
        assert.equal(started.json.id, id);
        assert(
            Number.isInteger(started.json.expires) &&
                started.json.expires > Date.now(),
        );
        return {
            storage,
            stored,
            calls,
            parts,
            request,
            projectUrl,
            uploadUrl,
            row,
            sendPart,
            view,
            projection,
            savedOnce,
            complete,
            close,
            reopen,
            dispose,
        };
    } catch (error) {
        await dispose();
        throw error;
    }
}

async function withUploadRecoveryFixture(
    t: TestContext,
    run: (fixture: UploadRecoveryFixture) => Promise<void>,
): Promise<void> {
    t.signal.throwIfAborted();
    const fixture = await openUploadRecoveryFixture();
    try {
        await run(fixture);
    } finally {
        await fixture.dispose();
    }
}

function assertUploadError(
    response: { status: number; json: { error: { code: string } } },
    status: number,
    code: string,
) {
    assert.equal(response.status, status);
    assert.equal(response.json.error.code, code);
}

test(
    'WEB-A04 missing multipart parts recover',
    { timeout: 20000 },
    async (t) => {
        await withUploadRecoveryFixture(t, async (f) => {
            await f.sendPart(2);
            await f.view('uploading', [2]);
            await f.projection(0, recoveryBytes);
            assertUploadError(await f.complete(), 409, 'space_conflict');
            await f.view('uploading', [2]);
            assert(!f.calls.some(([operation]) => operation === 'complete'));
            await f.projection(0, recoveryBytes);
            await f.sendPart(1);
            const first = f.parts.get(1);
            assert(first);
            first.Size--;
            await f.view('uploading', [2]);
            assertUploadError(await f.complete(), 409, 'space_conflict');
            assert(!f.calls.some(([operation]) => operation === 'complete'));
            first.Size++;
            await f.view('uploading', [1, 2]);
            assert.equal((await f.complete()).status, 200);
            await f.savedOnce();
        });
    },
);

async function uploadRecoveryParts(f: UploadRecoveryFixture) {
    await f.sendPart(1);
    await f.sendPart(2);
}

function recoveryClock(t: TestContext) {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1800000000000 });
    return {
        async sweep() {
            t.mock.timers.tick(30000);
            await new Promise<void>((resolve) => setImmediate(resolve));
        },
        expireSignature(f: UploadRecoveryFixture) {
            const signedUntil = f.row().signedUntil;
            assert(typeof signedUntil === 'number');
            t.mock.timers.setTime(signedUntil + 1);
        },
    };
}

const recoveryCallCount = (f: UploadRecoveryFixture, operation: string) =>
    f.calls.filter(([name]) => name === operation).length;

async function assertRecoveryGate(f: UploadRecoveryFixture, pending: boolean) {
    const result = await f.request(f.projectUrl + '/deletion');
    assert.equal(result.status, 200);
    assert.equal(result.json.uploadCount, pending ? 1 : 0);
    assert.deepEqual(result.json.blockers, pending ? ['upload_pending'] : []);
    if (pending) {
        assert.equal(result.json.fileCount, 0);
        assertUploadError(
            await f.request(f.projectUrl, 'DELETE'),
            409,
            'upload_pending',
        );
    }
}

test(
    'WEB-A04 wrong object size stays hidden',
    { timeout: 20000 },
    async (t) => {
        const clock = recoveryClock(t);
        await withUploadRecoveryFixture(t, async (f) => {
            await uploadRecoveryParts(f);
            const complete = f.storage.complete;
            f.storage.complete = async (...args) => {
                await complete(...args);
                f.stored.size = recoveryBytes - 1;
            };
            assertUploadError(await f.complete(), 409, 'space_conflict');
            await f.view('cleaning', []);
            assert.equal(f.row().cleanup, 'failed');
            assert.equal(recoveryCallCount(f, 'complete'), 1);
            await f.projection(0, recoveryBytes);
            await assertRecoveryGate(f, true);
            await clock.sweep();
            assert.equal(recoveryCallCount(f, 'abort'), 1); // Preparation only.
            assert.equal(recoveryCallCount(f, 'remove'), 0);
            await f.projection(0, recoveryBytes);
            clock.expireSignature(f);
            await clock.sweep();
            await f.view('failed', []);
            assert.equal(f.stored.active, false);
            assert.equal(f.stored.size, null);
            assert.equal(recoveryCallCount(f, 'remove'), 1);
            await f.projection(0, 0);
            await assertRecoveryGate(f, false);
            const cancel = await f.request(f.uploadUrl + '/cancel', 'POST', {});
            assert.equal(cancel.status, 200);
            assert.equal(cancel.json.state, 'failed');
            assertUploadError(await f.complete(), 409, 'space_conflict');
            await f.projection(0, 0);
        });
    },
);

function recoveryBarrier() {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    return {
        async waitForEntry() {
            await Promise.race([
                entered,
                delay(5000, undefined, { ref: false }).then(() =>
                    assert.fail('Storage barrier was not entered'),
                ),
            ]);
        },
        async pause() {
            enter();
            await released;
        },
        release,
    };
}

const lostRecoveryReceipt = () =>
    new Error('Fixture lost storage completion receipt');

test(
    'WEB-A04 lost storage completion receipt replays',
    { timeout: 20000 },
    async (t) => {
        await withUploadRecoveryFixture(t, async (f) => {
            await uploadRecoveryParts(f);
            const complete = f.storage.complete;
            f.storage.complete = async (...args) => {
                await complete(...args);
                throw lostRecoveryReceipt();
            };
            assertUploadError(await f.complete(), 500, 'server_error');
            await f.view('completing', []);
            await f.projection(0, recoveryBytes);
            await assertRecoveryGate(f, true);
            const start = f.calls.length;
            const first = await f.complete();
            assert.equal(first.status, 200);
            assert.deepEqual(
                f.calls.slice(start).map(([name]) => name),
                ['size'],
            );
            const second = await f.complete();
            assert.equal(second.status, 200);
            assert.deepEqual(second.json, first.json);
            assert.equal(f.calls.length, start + 1);
            await f.savedOnce();
        });
        await withUploadRecoveryFixture(t, async (f) => {
            await uploadRecoveryParts(f);
            const barrier = recoveryBarrier();
            const complete = f.storage.complete;
            f.storage.complete = async (...args) => {
                await complete(...args);
                await barrier.pause();
            };
            const controller = new AbortController();
            const aborted = assert.rejects(f.complete(controller.signal), {
                name: 'AbortError',
            });
            void aborted.catch(() => {});
            try {
                await barrier.waitForEntry();
                assert.equal(f.row().state, 'completing');
                controller.abort();
                await aborted;
                barrier.release();
                const deadline = Date.now() + 5000;
                let read = await f.request(f.uploadUrl);
                while (read.json.state !== 'saved' && Date.now() < deadline) {
                    await delay(20);
                    read = await f.request(f.uploadUrl);
                }
                assert.equal(read.status, 200);
                assert.equal(read.json.state, 'saved');
                assert.equal(f.row().state, 'saved');
                const { parts, ...upload } = read.json;
                assert.deepEqual(parts, []);
                const start = f.calls.length;
                const retry = await f.complete();
                assert.equal(retry.status, 200);
                assert.deepEqual(retry.json, upload);
                assert.equal(f.calls.length, start);
                await f.savedOnce();
            } finally {
                controller.abort();
                barrier.release();
                await Promise.allSettled([aborted]);
            }
        });
    },
);

test(
    'WEB-A04 pending completion survives reopen',
    { timeout: 20000 },
    async (t) => {
        const clock = recoveryClock(t);
        await withUploadRecoveryFixture(t, async (f) => {
            await uploadRecoveryParts(f);
            const barrier = recoveryBarrier();
            const complete = f.storage.complete;
            f.storage.complete = async (...args) => {
                await complete(...args);
                await barrier.pause();
                throw lostRecoveryReceipt();
            };
            const controller = new AbortController();
            const aborted = assert.rejects(f.complete(controller.signal), {
                name: 'AbortError',
            });
            void aborted.catch(() => {});
            try {
                await barrier.waitForEntry();
                controller.abort();
                await aborted;
            } finally {
                controller.abort();
                barrier.release();
                await Promise.allSettled([aborted]);
            }
            await f.close();
            assert.equal(f.row().state, 'completing');
            const start = f.calls.length;
            await f.reopen();
            await f.view('completing', []);
            await f.projection(0, recoveryBytes);
            await clock.sweep();
            const { parts, ...upload } = await f.view('saved', []);
            assert.deepEqual(parts, []);
            const retry = await f.complete();
            assert.equal(retry.status, 200);
            assert.deepEqual(retry.json, upload);
            assert.deepEqual(
                f.calls.slice(start).map(([name]) => name),
                ['size'],
            );
            await f.savedOnce();
        });
    },
);
