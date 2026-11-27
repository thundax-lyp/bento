import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { localHost } from '@/apps/orchestrator/src/execution-service/local.ts';
import { serveExecution } from '@/apps/orchestrator/src/execution-service/service.ts';
import { mockAccounts } from '../src/account-store.ts';
import { sessionAuth } from '../src/auth.ts';
import { httpBackend } from '../src/execution-service-http.ts';
import { taskEntryServer } from '../src/server.ts';
import { RequestError } from '../src/protocol.ts';
import { mySpace } from '../src/space/index.ts';
import { spaceObjectKey, spaceStorage } from '../src/space/storage.ts';

test(
    'WEB-A07 focused frozen project inputs through both HTTP boundaries',
    { timeout: 20000 },
    async (t) => {
        t.mock.timers.enable({ apis: ['setInterval'] });
        const dir = await mkdtemp(join(tmpdir(), 'bento-input-snapshot-'));
        const dbPath = join(dir, 'space.sqlite');
        const token = 'fixture-only-input-snapshot-token';
        const origin = 'http://127.0.0.1:32123';
        const owner = { ownerId: 'owner-a', account: 'a', inviteSha256: '' };
        const other = { ownerId: 'owner-b', account: 'b', inviteSha256: '' };
        const auth = sessionAuth(mockAccounts([owner, other]), false);
        const fixtureRequest = { headers: {} } as Parameters<
            typeof auth.startSession
        >[0];
        const rawCookieA = auth
            .startSession(fixtureRequest, owner)
            .cookie.split(';')[0];
        const rawCookieB = auth
            .startSession(fixtureRequest, other)
            .cookie.split(';')[0];
        assert(rawCookieA && rawCookieB);
        const cookieA: string = rawCookieA;
        const cookieB: string = rawCookieB;
        const storage = spaceStorage(
            'http://127.0.0.1:1',
            'fixture',
            'us-east-1',
        );
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
        storage.empty = async (key) => {
            objects.set(key, Buffer.alloc(0));
        };
        const host = localHost(join(dir, 'volume'));
        const snapshot = host.snapshot;
        const worker = host.worker;
        let notifyEntered!: () => void;
        let releaseGate!: () => void;
        const entered = new Promise<void>((resolve) => {
            notifyEntered = resolve;
        });
        const released = new Promise<void>((resolve) => {
            releaseGate = resolve;
        });
        let gateEntered = false;
        void entered.then(() => {
            gateEntered = true;
        });
        let blockedProject: string | undefined;
        const executions: {
            binding: Parameters<typeof snapshot>[0];
            run: string;
            session: string;
            files: Awaited<ReturnType<typeof snapshot>>;
        }[] = [];
        host.snapshot = async (binding) => {
            if (binding.project === blockedProject) {
                blockedProject = undefined;
                notifyEntered();
                await released;
            }
            return snapshot(binding);
        };
        host.worker = async (request, ...args) => {
            if (request.mode === 'execute') {
                executions.push({
                    binding: request.binding,
                    run: request.grant.run,
                    session: request.grant.session,
                    files: await snapshot(request.binding),
                });
            }
            return worker(request, ...args);
        };
        const execution = await serveExecution({
            state: join(dir, 'exec'),
            token,
            retryMs: 20,
            host,
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
            web = await taskEntryServer({
                port: 0,
                origin,
                auth,
                space,
                backend,
            });
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
                    ...(input === undefined
                        ? {}
                        : { body: JSON.stringify(input) }),
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
                input: string,
            ) {
                const project = randomUUID();
                const file = randomUUID();
                const bytes = Buffer.from(input);
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
                return { path, file, bytes: bytes.length };
            }

            function initialize(
                path: string,
                cookie: string,
                key: string,
                fileIds: string[],
            ) {
                return request(
                    path + '/execution',
                    cookie,
                    'POST',
                    { fileIds },
                    key,
                );
            }

            async function detail(path: string) {
                const response = await request(path, cookieA);
                assert.equal(response.status, 200);
                return response.json() as {
                    files: { id: string; path: string; size: number }[];
                    execution: {
                        state: string;
                        projectId?: string;
                        inputs?: unknown;
                    };
                };
            }

            async function ready(
                project: Awaited<ReturnType<typeof seed>>,
                key: string,
            ) {
                assert.equal(
                    (
                        await initialize(project.path, cookieA, key, [
                            project.file,
                        ])
                    ).status,
                    202,
                );
                const initialized = await waitFor(
                    async () => {
                        t.mock.timers.tick(2000);
                        return (await detail(project.path)).execution;
                    },
                    ({ state }) => state === 'ready',
                );
                assert(typeof initialized.projectId === 'string');
                assert.deepEqual(initialized.inputs, [
                    {
                        fileId: project.file,
                        path: 'README.md',
                        size: project.bytes,
                        available: true,
                    },
                ]);
                return {
                    projectId: initialized.projectId,
                    inputs: initialized.inputs,
                };
            }

            function expectError(
                response: Awaited<ReturnType<typeof request>>,
                status: number,
                code: string,
            ) {
                assert.equal(response.status, status);
                assert.equal(
                    (response.json().error as { code: string }).code,
                    code,
                );
            }

            async function submit(
                projectId: string,
                prompt: string,
                key: string,
            ) {
                const runs = '/api/projects/' + projectId + '/runs';
                const response = await request(
                    runs,
                    cookieA,
                    'POST',
                    { prompt },
                    key,
                );
                assert.equal(response.status, 202);
                const { id, sessionId } = response.json();
                assert(typeof id === 'string' && typeof sessionId === 'string');
                assert.equal(response.json().projectId, projectId);
                return { id, sessionId, projectId, runs, url: runs + '/' + id };
            }

            async function succeeded(url: string) {
                await waitFor(
                    async () => {
                        const response = await request(url, cookieA);
                        assert.equal(response.status, 200);
                        return response.json().status;
                    },
                    (status) => status === 'succeeded',
                );
            }

            const alpha = await seed(owner, cookieA, 'alpha\n');
            const beta = await seed(owner, cookieA, 'beta\n');
            const foreign = await seed(other, cookieB, 'foreign\n');
            expectError(
                await initialize(alpha.path, cookieB, 'foreign-owner', [
                    alpha.file,
                ]),
                404,
                'not_found',
            );
            expectError(
                await initialize(alpha.path, cookieA, 'wrong-project', [
                    beta.file,
                ]),
                404,
                'not_found',
            );
            expectError(
                await initialize(alpha.path, cookieA, 'foreign-file', [
                    foreign.file,
                ]),
                404,
                'not_found',
            );
            assert.equal(
                (await detail(alpha.path)).execution.state,
                'uninitialized',
            );

            const alphaReady = await ready(alpha, 'initialize-alpha');
            blockedProject = alphaReady.projectId;
            const first = await submit(
                alphaReady.projectId,
                'first change',
                'run-alpha',
            );
            await waitFor(async () => gateEntered, Boolean);
            const queued = await request(first.url, cookieA);
            assert.equal(queued.status, 200);
            const { id, projectId, sessionId, status, prompt } = queued.json();
            assert.deepEqual(
                { id, projectId, sessionId, status, prompt },
                {
                    id: first.id,
                    projectId: first.projectId,
                    sessionId: first.sessionId,
                    status: 'queued',
                    prompt: 'first change',
                },
            );

            const extra = randomUUID();
            const upload = await request(
                alpha.path + '/uploads',
                cookieA,
                'POST',
                {
                    id: extra,
                    path: 'extra.txt',
                    size: 0,
                    checksums: [],
                },
            );
            assert.equal(upload.status, 200);
            assert.equal(upload.json().state, 'uploading');
            const completed = await request(
                '/api/space/uploads/' + extra + '/complete',
                cookieA,
                'POST',
            );
            assert.equal(completed.status, 200);
            assert.equal(completed.json().state, 'saved');

            const changed = await detail(alpha.path);
            assert.deepEqual(
                new Set(changed.files.map((file) => file.id)),
                new Set([alpha.file, extra]),
            );
            assert.deepEqual(changed.execution, {
                state: 'ready',
                ...alphaReady,
            });
            expectError(
                await initialize(
                    alpha.path,
                    cookieA,
                    'initialize-alpha-changed',
                    [alpha.file, extra],
                ),
                409,
                'execution_already_bound',
            );

            const replay = await request(
                first.runs,
                cookieA,
                'POST',
                { prompt: 'first change' },
                'run-alpha',
            );
            assert.equal(replay.status, 200);
            assert.equal(replay.json().id, first.id);
            const list = await request(first.runs, cookieA);
            assert.equal(list.status, 200);
            assert.deepEqual(
                (list.json().runs as { id: string }[]).map((run) => run.id),
                [first.id],
            );
            const stillQueued = await request(first.url, cookieA);
            assert.equal(stillQueued.status, 200);
            assert.equal(stillQueued.json().status, 'queued');

            expectError(await request(first.url, cookieB), 404, 'not_found');
            expectError(
                await request(first.url + '/diff', cookieB),
                404,
                'not_found',
            );
            expectError(
                await request(
                    first.runs,
                    cookieB,
                    'POST',
                    { prompt: 'foreign change' },
                    'foreign-run',
                ),
                404,
                'not_found',
            );

            releaseGate();
            await succeeded(first.url);
            const firstDiff = await request(first.url + '/diff', cookieA);
            assert.equal(firstDiff.status, 200);
            assert.match(firstDiff.text, /^ alpha$/m);
            assert.match(firstDiff.text, /^\+first change$/m);

            const betaReady = await ready(beta, 'initialize-beta');
            const second = await submit(
                betaReady.projectId,
                'second change',
                'run-beta',
            );
            await succeeded(second.url);
            assert.deepEqual(
                executions.map((execution) => execution.files),
                [
                    [{ path: 'README.md', text: 'alpha\n' }],
                    [{ path: 'README.md', text: 'beta\n' }],
                ],
            );
            const [firstExecution, secondExecution] = executions;
            assert(firstExecution && secondExecution);
            for (const [actual, expected] of [
                [firstExecution, first],
                [secondExecution, second],
            ] as const) {
                assert.equal(actual.binding.tenant, owner.ownerId);
                assert.equal(actual.binding.project, expected.projectId);
                assert.equal(actual.binding.session, expected.sessionId);
                assert.equal(actual.session, expected.sessionId);
                assert.equal(actual.run, expected.id);
            }
            assert.notEqual(first.projectId, second.projectId);
            assert.notEqual(first.sessionId, second.sessionId);
            assert.notEqual(first.id, second.id);
            assert.notEqual(
                firstExecution.binding.sandbox,
                secondExecution.binding.sandbox,
            );
            assert.notEqual(
                firstExecution.binding.volume,
                secondExecution.binding.volume,
            );

            const secondDiff = await request(second.url + '/diff', cookieA);
            assert.equal(secondDiff.status, 200);
            assert.match(secondDiff.text, /^ beta$/m);
            assert.match(secondDiff.text, /^\+second change$/m);
            assert.doesNotMatch(secondDiff.text, /first change/);
            const preserved = await request(first.url + '/diff', cookieA);
            assert.equal(preserved.status, 200);
            assert.equal(preserved.text, firstDiff.text);
            expectError(
                await request(second.runs + '/' + first.id, cookieA),
                404,
                'not_found',
            );
        } finally {
            releaseGate();
            try {
                if (web) await web.close();
                else await space.close();
            } finally {
                try {
                    await execution.close();
                } finally {
                    await rm(dir, { recursive: true, force: true });
                }
            }
        }
    },
);

test(
    'Task snapshot replay and file holds survive personal API restart',
    { timeout: 25_000 },
    async (t) => {
        t.mock.timers.enable({ apis: ['setInterval'] });
        const state = await mkdtemp(join(tmpdir(), 'bento-task-space-'));
        const dbPath = join(state, 'space.sqlite');
        const origin = 'http://127.0.0.1:31811';
        const token = 'fixture-only-task-space-bearer';
        const owner = { ownerId: 'owner-a', account: 'a', inviteSha256: '' };
        const auth = sessionAuth(mockAccounts([owner]), false);
        const cookie = auth
            .startSession(
                { headers: {} } as Parameters<typeof auth.startSession>[0],
                owner,
            )
            .cookie.split(';')[0]!;
        const base = localHost(join(state, 'volume'));
        let release = () => {};
        const wait = new Promise<void>((resolve) => {
            release = resolve;
        });
        const execution = await serveExecution({
            state: join(state, 'execution'),
            token,
            retryMs: 20,
            host: {
                ...base,
                async worker(request, signal, slot, exit) {
                    if (request.prompt === 'pause') await wait;
                    return base.worker(request, signal, slot, exit);
                },
            },
        });
        const real = httpBackend(execution.url, token, 3000);
        const storage = spaceStorage(
            'http://127.0.0.1:1',
            'fixture',
            'us-east-1',
        );
        const objects = new Map<string, Buffer>();
        storage.read = async (key) => Buffer.from(objects.get(key)!);
        storage.size = async (key) => objects.get(key)?.length ?? null;
        storage.remove = async (key) => {
            objects.delete(key);
        };
        storage.download = async (key) => 'https://fixture.invalid/' + key;
        const checkingFile = randomUUID();
        let announceChecking = () => {};
        let releaseChecking = () => {};
        const checking = new Promise<void>((resolve) => {
            announceChecking = resolve;
        });
        const held = new Promise<void>((resolve) => {
            releaseChecking = resolve;
        });
        let loseCreate = true;
        const backend: typeof real = async (ownerId, operation) => {
            if (
                operation.kind === 'acquireTaskInputDeleteHold' &&
                operation.fileId === checkingFile
            ) {
                announceChecking();
                await held;
            }
            const received = await real(ownerId, operation);
            if (
                operation.kind === 'createTask' &&
                operation.input.sourceSpaceId !== null &&
                loseCreate
            ) {
                loseCreate = false;
                throw new RequestError(
                    502,
                    'backend_error',
                    'fixture lost receipt',
                );
            }
            return received;
        };
        const makeWeb = (withSpace = true) =>
            taskEntryServer({
                port: 0,
                origin,
                auth,
                backend,
                ...(withSpace
                    ? { space: mySpace(dbPath, storage, backend) }
                    : {}),
            });
        let web = await makeWeb();
        t.after(async () => {
            release();
            releaseChecking();
            await web.close();
            await execution.close();
            await rm(state, { recursive: true, force: true });
        });
        async function call(
            path: string,
            method = 'GET',
            body?: unknown,
            key?: string,
        ) {
            const response = await fetch(web.origin + path, {
                method,
                headers: {
                    Cookie: cookie,
                    Origin: origin,
                    ...(key ? { 'Idempotency-Key': key } : {}),
                    ...(body === undefined
                        ? {}
                        : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                redirect: 'manual',
                signal: AbortSignal.timeout(5000),
            });
            const text = await response.text();
            return {
                status: response.status,
                text,
                json: () => JSON.parse(text),
            };
        }
        async function until<T>(
            operation: () => Promise<T>,
            ok: (value: T) => boolean,
        ) {
            for (let i = 0; i < 400; i++) {
                const v = await operation();
                if (ok(v)) return v;
                await delay(25);
            }
            throw new Error('Task API fixture did not settle');
        }
        const sourceId = randomUUID();
        const selected = randomUUID();
        const unrelated = randomUUID();
        const invalid = randomUUID();
        const invalidPath = randomUUID();
        const limit = randomUUID();
        const oversized = randomUUID();
        const db = new DatabaseSync(dbPath);
        db.prepare("INSERT INTO space_projects VALUES (?,?,'Source')").run(
            sourceId,
            owner.ownerId,
        );
        function seed(id: string, path: string, bytes: Buffer) {
            objects.set(spaceObjectKey(id), bytes);
            db.prepare(
                "INSERT INTO space_uploads(id,project,owner,path,size,manifest,state,expires) VALUES (?,?,?,?,?,?,'saved',?)",
            ).run(
                id,
                sourceId,
                owner.ownerId,
                path,
                bytes.length,
                JSON.stringify([
                    createHash('sha256').update(bytes).digest('base64'),
                ]),
                Date.now() + 60000,
            );
        }
        seed(selected, 'README.md', Buffer.from('frozen\n'));
        seed(unrelated, 'unrelated.txt', Buffer.from('unrelated'));
        seed(invalid, 'invalid.txt', Buffer.from([0xff]));
        seed(invalidPath, '../invalid-path.txt', Buffer.from('invalid path'));
        seed(limit, 'limit.txt', Buffer.alloc(1024 * 1024, 97));
        seed(oversized, 'oversized.txt', Buffer.alloc(1024 * 1024 + 1, 97));
        seed(checkingFile, 'checking.txt', Buffer.from('deletion in progress'));
        db.close();
        const deleting = call('/api/space/files/' + checkingFile, 'DELETE');
        await checking;
        const legacy = await call(
            '/api/space/projects/' + sourceId + '/execution',
            'POST',
            { fileIds: [checkingFile] },
            randomUUID(),
        );
        assert.equal(legacy.status, 404, legacy.text);
        const inspecting = new DatabaseSync(dbPath);
        assert.equal(
            inspecting
                .prepare(
                    'SELECT count(*) AS count FROM space_execution WHERE spaceId=?',
                )
                .get(sourceId)?.count,
            0,
        );
        inspecting.close();
        releaseChecking();
        assert.equal((await deleting).status, 202);

        const source = {
            kind: 'space_snapshot',
            spaceId: sourceId,
            fileIds: [selected],
        };
        const input = { name: 'Snapshot', source };
        const key = randomUUID();
        const failed = await call(
            '/api/tasks',
            'POST',
            {
                name: 'Invalid',
                source: {
                    ...source,
                    fileIds: [selected, invalid, invalidPath],
                },
            },
            randomUUID(),
        );
        assert.equal(failed.status, 400, failed.text);
        const issues: NonNullable<RequestError['issues']> =
            failed.json().error.issues;
        assert.deepEqual(
            issues.sort((a, b) => a.path.localeCompare(b.path)),
            [
                {
                    fileId: invalidPath,
                    path: '../invalid-path.txt',
                    code: 'invalid_path',
                },
                { fileId: invalid, path: 'invalid.txt', code: 'invalid_utf8' },
            ],
        );
        for (const [fileIds, issues] of [
            [[selected, limit], undefined],
            [
                [selected, oversized],
                [
                    {
                        fileId: oversized,
                        path: 'oversized.txt',
                        code: 'too_large',
                    },
                ],
            ],
        ] as const) {
            const reply = await call(
                '/api/tasks',
                'POST',
                { name: 'Too large', source: { ...source, fileIds } },
                randomUUID(),
            );
            assert.equal(reply.status, 413, reply.text);
            assert.match(reply.json().error.message, /1 MiB/);
            assert.deepEqual(reply.json().error.issues, issues);
        }
        const tooMany = await call(
            '/api/tasks',
            'POST',
            {
                name: 'Too many',
                source: {
                    ...source,
                    fileIds: Array.from({ length: 101 }, () => randomUUID()),
                },
            },
            randomUUID(),
        );
        assert.equal(tooMany.status, 413, tooMany.text);
        assert.match(tooMany.json().error.message, /100/);
        for (const id of [selected, invalid, limit, oversized])
            assert.equal(
                (await call('/api/space/files/' + id + '/download')).status,
                302,
            );
        assert.equal((await call('/api/tasks')).json().items.length, 0);
        assert.equal(
            (await call('/api/tasks', 'POST', input, key)).status,
            502,
        );
        await web.close();
        web = await makeWeb();
        const recovered = await call('/api/tasks', 'POST', input, key);
        assert.equal(recovered.status, 200, recovered.text);
        const taskId = recovered.json().task.id;
        assert.equal((await call('/api/tasks')).json().items.length, 1);
        assert.equal(
            (
                await call(
                    '/api/tasks',
                    'POST',
                    { ...input, name: 'Changed' },
                    key,
                )
            ).status,
            409,
        );
        const task = '/api/tasks/' + taskId;
        await until(
            async () => call('/api/tasks', 'POST', input, key),
            (r) => r.json().task.status === 'ready',
        );
        const runKey = randomUUID();
        const run = await call(
            task + '/runs',
            'POST',
            { prompt: 'pause' },
            runKey,
        );
        assert.equal(run.status, 202, run.text);
        const runId = run.json().run.id;
        assert.equal(
            (
                await call(task + '/runs', 'POST', { prompt: 'pause' }, runKey)
            ).json().run.id,
            runId,
        );
        const inputFile = '/api/space/files/' + selected;
        assert.equal((await call(inputFile, 'DELETE')).status, 409);
        assert.equal((await call(inputFile + '/download')).status, 302);
        release();
        await until(
            () => call(task + '/runs/' + runId),
            (r) => r.json().run.status === 'succeeded',
        );
        assert.equal((await call(inputFile, 'DELETE')).status, 202);
        assert.equal(
            (
                await call(
                    task + '/runs',
                    'POST',
                    { prompt: 'later' },
                    randomUUID(),
                )
            ).status,
            409,
        );
        const unrelatedFile = '/api/space/files/' + unrelated;
        assert.equal((await call(unrelatedFile, 'DELETE')).status, 202);
        await web.close();
        web = await makeWeb();
        t.mock.timers.tick(30_000);
        await until(
            () => call(unrelatedFile, 'DELETE'),
            (r) => r.status === 204,
        );
        await until(
            () => call(inputFile, 'DELETE'),
            (r) => r.status === 204,
        );
        const followup = await call(
            task + '/runs',
            'POST',
            { prompt: 'later' },
            randomUUID(),
        );
        assert.equal(followup.status, 202, followup.text);
        await until(
            () => call(task + '/runs/' + followup.json().run.id),
            (r) => r.json().run.status === 'succeeded',
        );
        const events = (await call(task + '/events?after=0')).json().items;
        assert.equal(events.length, 2);
        assert(events.every((event: object) => !('key' in event)));
        assert.equal(
            (
                await call(
                    task + '/runs/' + runId + '/results/1/diff?view=cumulative',
                )
            ).status,
            200,
        );

        await web.close();
        web = await makeWeb(false);
        const missingSpace = await call(
            '/api/tasks',
            'POST',
            input,
            randomUUID(),
        );
        assert.equal(missingSpace.status, 503);
        assert.equal(missingSpace.json().error.code, 'source_unavailable');
        const blank = await call(
            '/api/tasks',
            'POST',
            { name: 'Blank', source: { kind: 'blank' } },
            randomUUID(),
        );
        assert.equal(blank.status, 202, blank.text);
        assert.equal((await call('/api/tasks')).json().items.length, 2);
        assert.equal((await call(task)).json().task.id, taskId);
        assert.equal((await call(task + '/events')).json().items.length, 2);
        assert.equal((await call(task + '/runs')).json().items.length, 2);
    },
);
