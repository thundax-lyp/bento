import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { localHost } from '@orchestrator/execution-service/local.ts';
import { serveExecution } from '@orchestrator/execution-service/service.ts';
import { mockAccounts } from '@workspace-api-fixture/account-store.ts';
import { sessionAuth } from '@workspace-api-fixture/auth.ts';
import { httpBackend } from '@workspace-api-fixture/execution-service-http.ts';
import { taskEntryServer } from '@workspace-api-fixture/server.ts';
import { mockBackend } from '@workspace-api-fixture/mock.ts';
import { RequestError } from '@workspace-api-fixture/protocol.ts';
import { mySpace } from '@workspace-api-fixture/space/index.ts';
import {
    spaceObjectKey,
    spaceStorage,
} from '@workspace-api-fixture/space/storage.ts';
import { noBody, notFound } from './fixtures/space-assertions.ts';

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
        if (operation.kind === 'taskSourceImpact') {
            assert.equal(operation.spaceId, target);
            return {
                status: 200,
                json: {
                    runCount: operation.legacyProjectId === binding ? 2 : 0,
                    diffCount: operation.legacyProjectId === binding ? 1 : 0,
                    blockers: [],
                },
            };
        }
        assert.equal(operation.kind, 'taskSourceDeletion');
        assert.equal(operation.legacyProjectId, binding);
        if (operation.phase === 'release') return { status: 204 };
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
    const base = localHost(join(dir, 'volume'));
    let releaseRun = () => {};
    const runGate = new Promise<void>((resolve) => {
        releaseRun = resolve;
    });
    const execution = await serveExecution({
        state: join(dir, 'exec'),
        token,
        retryMs: 20,
        host: {
            ...base,
            async worker(request, signal) {
                if (request.prompt === 'wait for deletion check') await runGate;
                return base.worker(request, signal);
            },
        },
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
        async function seed(
            caller: typeof owner,
            cookie: string,
            hold = false,
        ) {
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
                    VALUES (?,?,?,'nested/README.md',?,?,'saved',0)`,
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
                { prompt: hold ? 'wait for deletion check' : 'change' },
                'run-key',
            );
            assert.equal(created.status, 202);
            const run = runs + '/' + created.json().id;
            await waitFor(
                () => request(run, cookie),
                (result) =>
                    result.json().status === (hold ? 'running' : 'succeeded'),
            );
            return { path, run, file, bytes: bytes.length };
        }
        const a = await seed(owner, cookieA, true);
        const filePath = '/api/space/files/' + a.file;
        const fileUrl = filePath + '/download';
        const detail = await request(a.path, cookieA);
        assert.equal(detail.status, 200);
        assert.deepEqual(detail.json().files, [
            { id: a.file, path: 'nested/README.md', size: a.bytes },
        ]);
        for (const [path, status, code] of [
            ['nested/../escape.txt', 400, 'invalid_space_input'],
            ['nested/README.md', 409, 'space_conflict'],
            ['nested', 409, 'space_conflict'],
            ['nested/README.md/child.txt', 409, 'space_conflict'],
        ] as const) {
            const rejected = await request(
                a.path + '/uploads',
                cookieA,
                'POST',
                {
                    id: randomUUID(),
                    path,
                    size: 0,
                    checksums: [],
                },
            );
            assert.equal(rejected.status, status);
            assert.equal(
                (rejected.json().error as { code: string }).code,
                code,
            );
        }
        const spaceAfterRejections = (
            await request('/api/space', cookieA)
        ).json();
        assert.deepEqual(
            (spaceAfterRejections.uploads as { id: string }[]).map(
                ({ id }) => id,
            ),
            [a.file],
        );
        assert.equal(spaceAfterRejections.saved, a.bytes);
        assert.equal(spaceAfterRejections.reserved, 0);
        assert.deepEqual(
            (await request(a.path + '/deletion', cookieA)).json(),
            {
                fileCount: 1,
                uploadCount: 0,
                runCount: 1,
                diffCount: 0,
                blockers: ['project_busy'],
            },
        );
        const busy = await request(a.path, cookieA, 'DELETE');
        assert.equal(busy.status, 409);
        assert.equal(
            (busy.json().error as { code: string }).code,
            'project_busy',
        );
        assert.equal((await request(a.path, cookieA)).status, 200);
        assert.equal((await request(fileUrl, cookieA)).status, 302);
        assert.equal(
            (await request('/api/space', cookieA)).json().saved,
            a.bytes,
        );
        releaseRun();
        await waitFor(
            () => request(a.run, cookieA),
            (result) => result.json().status === 'succeeded',
        );
        const b = await seed(other, cookieB);
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
            (await request(a.path + '/deletion', cookieA)).status,
            404,
        );
        assert.equal((await request(a.run, cookieA)).status, 404);
        assert.equal(
            (await request(filePath + '/preview', cookieA)).status,
            404,
        );
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
        releaseRun();
        if (web) await web.close();
        else await space.close();
        await execution.close();
        await rm(dir, { recursive: true, force: true });
    }
});
