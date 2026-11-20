import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { executionHttp } from '@/apps/orchestrator/execution-service/http.ts';
import { dockerOpenShellPurge } from '@/apps/orchestrator/execution-service/docker-openshell-purge.ts';
import { localHost } from '@/apps/orchestrator/execution-service/local.ts';
import { Store } from '@/apps/orchestrator/execution-service/store.ts';
import { serveExecution } from '@/apps/orchestrator/execution-service/service.ts';
import { type ExecutionHost } from '@/apps/orchestrator/execution-service/types.ts';
import {
    testToken,
    readme,
    barrier,
    client,
    until,
    project,
    start,
} from './fixtures/service.ts';

const controllerFixtureFile = fileURLToPath(
    new URL('./fixtures/controller.ts', import.meta.url),
);

test('project deletion execution HTTP', async () => {
    const state = await mkdtemp(join(tmpdir(), 'bento-project-http-'));
    const base = localHost(join(state, 'volume'));
    const entered = barrier();
    const release = barrier();
    const running = barrier();
    const finish = barrier();
    const purged: string[] = [];
    const host: ExecutionHost = {
        ...base,
        async worker(request, signal) {
            if (request.prompt === 'wait') {
                running.resolve();
                await finish.promise;
            }
            return base.worker(request, signal);
        },
        async purge(binding) {
            purged.push(binding.project);
            if (purged.length === 1) {
                entered.resolve();
                await release.promise;
                await base.purge!(binding);
                throw new Error('Lost purge acknowledgement');
            }
            await assert.rejects(
                readFile(
                    join(
                        state,
                        'volume',
                        binding.project,
                        'volume',
                        'README.md',
                    ),
                ),
            );
            await base.purge!(binding);
        },
    };
    let service = await start(state, host);
    try {
        const a = client(service.url);
        const b = client(service.url, 'account-b');
        const target = await project(a);
        const other = await project(b);
        const run = await a(
            target + '/runs',
            'POST',
            { prompt: 'wait' },
            'first',
        );
        const runPath = target + '/runs/' + run.json().id;
        const { sessionId } = run.json();
        await running.promise;
        const key = randomUUID();
        const refused = await a(target, 'DELETE', undefined, key);
        assert.equal(refused.status, 409);
        assert.match(refused.text, /project_busy/);
        finish.resolve();
        await until(
            () => a(runPath),
            (res) => res.json().status === 'succeeded',
            'terminal run',
        );
        assert.equal((await a(runPath + '/diff')).status, 200);
        const sql = new DatabaseSync(join(state, 'business.sqlite'));
        sql.prepare("UPDATE runs SET diff='' WHERE id=?").run(run.json().id);
        sql.close();
        assert.deepEqual((await a(target + '/deletion')).json(), {
            runCount: 1,
            diffCount: 1,
            blockers: [],
        });
        assert.equal((await a(runPath + '/diff')).text, '');
        assert.equal((await a(target, 'DELETE', undefined, key)).status, 409);
        const operation = randomUUID();
        assert.equal(
            (await b(target, 'DELETE', undefined, operation)).status,
            404,
        );
        assert.equal(
            (
                await client(service.url, 'account-a', '')(
                    target,
                    'DELETE',
                    undefined,
                    operation,
                )
            ).status,
            401,
        );
        assert.equal((await a(target, 'DELETE')).status, 400);
        assert.equal((await a(target, 'DELETE', undefined, 'bad')).status, 400);
        const duplicate = await fetch(service.url + '/v1/projects' + target, {
            method: 'DELETE',
            headers: [
                ['Authorization', 'Bearer ' + testToken],
                ['X-Bento-Owner-Id', 'account-a'],
                ['Idempotency-Key', operation],
                ['Idempotency-Key', randomUUID()],
            ],
        });
        assert.equal(duplicate.status, 400);
        await duplicate.body?.cancel();
        const deleting = a(target, 'DELETE', undefined, operation);
        await entered.promise;
        assert.equal(
            (await a(target, 'DELETE', undefined, randomUUID())).status,
            409,
        );
        assert.equal(
            (await a(target + '/runs', 'POST', { prompt: 'next' }, 'next'))
                .status,
            409,
        );
        assert.equal((await a(runPath + '/diff')).status, 404);
        release.resolve();
        assert.equal((await deleting).status, 202);
        await service.close();
        service = await start(state, host);
        const reopened = client(service.url);
        const done = await reopened(target, 'DELETE', undefined, operation);
        assert.equal(done.status, 204);
        assert.equal(done.text, '');
        assert.equal(
            (await reopened(target, 'DELETE', undefined, operation)).status,
            204,
        );
        assert.equal((await reopened(target)).status, 404);
        assert.equal((await reopened(runPath)).status, 404);
        assert.equal((await reopened(runPath + '/diff')).status, 404);
        assert.deepEqual(purged, [target.slice(1), target.slice(1)]);
        for (const [file, table] of [
            ['authority.sqlite', 'execution_sessions'],
            ['history.sqlite', 'sessions'],
        ]) {
            assert(file && table);
            const ledger = new DatabaseSync(join(state, file));
            try {
                if (table === 'execution_sessions') {
                    assert.equal(
                        ledger
                            .prepare(
                                'SELECT 1 FROM execution_sessions WHERE project=?',
                            )
                            .get(target.slice(1)),
                        undefined,
                    );
                    assert(
                        ledger
                            .prepare(
                                'SELECT 1 FROM execution_sessions WHERE project=?',
                            )
                            .get(other.slice(1)),
                    );
                } else {
                    assert.equal(
                        ledger
                            .prepare(
                                'SELECT count(*) AS count FROM sessions WHERE id=?',
                            )
                            .get(sessionId)?.count,
                        0,
                    );
                }
            } finally {
                ledger.close();
            }
        }
        const remaining = client(service.url, 'account-b');
        assert.equal((await remaining(other)).status, 200);
        const next = await remaining(
            other + '/runs',
            'POST',
            { prompt: 'kept' },
            'kept',
        );
        await until(
            () => remaining(other + '/runs/' + next.json().id),
            (res) => res.json().status === 'succeeded',
            'other owner completes',
        );
    } finally {
        finish.resolve();
        release.resolve();
        await service.close();
        await rm(state, { recursive: true, force: true });
    }
});

test('project deletion owner drain', async () => {
    for (const deletionFirst of [false, true]) {
        const state = await mkdtemp(join(tmpdir(), 'bento-project-drain-'));
        const base = localHost(join(state, 'volume'));
        const entered = barrier();
        const release = barrier();
        const finished = barrier();
        let pause = true;
        const host: ExecutionHost = {
            ...base,
            async worker(request, signal) {
                if (request.prompt === 'wait') await finished.promise;
                return base.worker(request, signal);
            },
            async purge(binding) {
                if (deletionFirst && pause) {
                    entered.resolve();
                    await release.promise;
                    throw new Error('Unconfirmed purge');
                }
                await base.purge!(binding);
            },
        };
        let service = await start(state, host);
        const accountPurge = async () => {
            const response = await fetch(service.url + '/v1/account/purge', {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer ' + testToken,
                    'X-Bento-Owner-Id': 'account-a',
                },
            });
            await response.json();
            return response.status;
        };
        try {
            const api = client(service.url);
            const target = await project(api);
            const other = await project(api);
            const operation = randomUUID();
            if (deletionFirst) {
                const deleting = api(target, 'DELETE', undefined, operation);
                await entered.promise;
                assert.equal(await accountPurge(), 202);
                assert.match(
                    (await api(other, 'DELETE', undefined, randomUUID())).text,
                    /owner_closed/,
                );
                release.resolve();
                assert.equal((await deleting).status, 202);
            } else {
                const run = await api(
                    other + '/runs',
                    'POST',
                    { prompt: 'wait' },
                    'wait',
                );
                assert.equal(run.status, 202);
                assert.equal(await accountPurge(), 202);
                assert.match(
                    (await api(target, 'DELETE', undefined, operation)).text,
                    /owner_closed/,
                );
            }
            finished.resolve();
            await service.close();
            pause = false;
            service = await start(state, host);
            const reopened = client(service.url);
            if (deletionFirst) {
                assert.match(
                    (await reopened(other, 'DELETE', undefined, randomUUID()))
                        .text,
                    /owner_closed/,
                );
                assert.equal(
                    (await reopened(target, 'DELETE', undefined, operation))
                        .status,
                    204,
                );
                assert.equal(
                    (await reopened(target, 'DELETE', undefined, operation))
                        .status,
                    204,
                );
                assert.equal(await accountPurge(), 200);
                assert.equal(
                    (await reopened(target, 'DELETE', undefined, operation))
                        .status,
                    404,
                );
            } else {
                const denied = await reopened(
                    target,
                    'DELETE',
                    undefined,
                    operation,
                );
                assert.equal(denied.status, 409);
                assert.match(denied.text, /owner_closed/);
            }
        } finally {
            finished.resolve();
            release.resolve();
            await service.close();
            await rm(state, { recursive: true, force: true });
        }
    }
});

test('project deletion Temporal purge receipts', async () => {
    const state = await mkdtemp(join(tmpdir(), 'bento-project-temporal-'));
    const env = process.env.BENTO_GO_CONTROL;
    const wrapper = join(state, 'control');
    const quote = (value: string) =>
        "'" + value.replaceAll("'", "'\"'\"'") + "'";
    await writeFile(
        wrapper,
        '#!/bin/sh\nexec ' +
            [
                process.execPath,
                ...process.execArgv,
                controllerFixtureFile,
                '--project-delete-control-fixture',
                join(state, 'purges'),
            ]
                .map(quote)
                .join(' ') +
            '\n',
        { mode: 0o700 },
    );
    process.env.BENTO_GO_CONTROL = wrapper;
    const store = new Store(join(state, 'business.sqlite'));
    const project = store.addProject('account-a', 'Fixture', []).id;
    store.importResult(project, 'ready');
    const run = store.addRun('account-a', project, 'run', 'run').run.id;
    store.status(run, 'succeeded', 'done', '');
    store.close();
    const base = localHost(join(state, 'volume'));
    let hostCalls = 0;
    const host: ExecutionHost = {
        ...base,
        async purge(binding) {
            hostCalls++;
            await base.purge!(binding);
        },
    };
    const open = () =>
        serveExecution({
            state,
            host,
            token: testToken,
            retryMs: 60_000,
            temporal: { address: 'fixture', taskQueue: 'fixture' },
        });
    let service: Awaited<ReturnType<typeof open>> | undefined;
    try {
        service = await open();
        const path = '/' + project;
        const key = randomUUID();
        const api = client(service.url);
        for (let i = 0; i < 2; i++) {
            const result = await api(path, 'DELETE', undefined, key);
            assert.equal(result.status, 202);
            assert.deepEqual(result.json(), { state: 'deleting' });
            assert.equal(hostCalls, 0);
            assert.equal((await api(path)).status, 404);
            assert.deepEqual((await api(path + '/deletion')).json(), {
                runCount: 1,
                diffCount: 1,
                blockers: [],
            });
        }
        assert.equal(await readFile(join(state, 'purges'), 'utf8'), '2');
        await service.close();
        service = await open();
        assert.equal(
            (await client(service.url)(path, 'DELETE', undefined, key)).status,
            204,
        );
        assert.equal(await readFile(join(state, 'purges'), 'utf8'), '3');
        assert.equal(hostCalls, 1);
    } finally {
        await service?.close();
        if (env === undefined) delete process.env.BENTO_GO_CONTROL;
        else process.env.BENTO_GO_CONTROL = env;
        await rm(state, { recursive: true, force: true });
    }
});

test('project deletion host observation', async () => {
    const project = randomUUID();
    const volume = 'bento-workspace-' + project;
    const binding = {
        project,
        volume,
        tenant: 'a',
        session: randomUUID(),
        sandbox: 'b-0000000000000000',
    };
    let label = 'foreign';
    let hasSandbox = true;
    let hasVolume = true;
    let attachmentChecks = 0;
    const mutations: string[] = [];
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const purge = dockerOpenShellPurge({
        volumeLabel: { key: 'bento', value: 'fixture' },
        async gateway(args) {
            if (args[1] === 'get')
                return hasSandbox
                    ? ok('{}')
                    : { code: 1, stdout: '', stderr: 'sandbox not found' };
            mutations.push('sandbox');
            hasSandbox = false;
            return ok();
        },
        async docker(args) {
            if (args[1] === 'ls') return ok(hasVolume ? volume : '');
            if (args[1] === 'inspect')
                return ok(JSON.stringify({ bento: label }));
            if (args[0] === 'ps') {
                if (++attachmentChecks === 1) return ok('attached-container');
                if (attachmentChecks === 2)
                    throw new Error('Cannot confirm attachment has cleared');
                return ok();
            }
            mutations.push('volume');
            hasVolume = false;
            throw new Error('Volume deletion receipt lost');
        },
    });
    await assert.rejects(purge(binding), /ownership/);
    assert.deepEqual(mutations, []);
    label = 'fixture';
    await assert.rejects(purge(binding), /attachment/);
    assert.deepEqual(mutations, ['sandbox']);
    await assert.rejects(purge(binding), /receipt lost/);
    await purge(binding);
    assert.deepEqual(mutations, ['sandbox', 'volume']);
});

test('project deletion ledger', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bento-project-deletion-'));
    const path = join(dir, 'ledger.sqlite');
    let store = new Store(path);
    const sql = new DatabaseSync(path);
    try {
        const owner = 'owner-a';
        const project = store.createProject(owner, 'project', readme, 'import')
            .project.id;
        const begin = (operation = randomUUID()) =>
            store.beginProjectDeletion(owner, project, operation);
        assert.deepEqual(begin(), {
            state: 'denied',
            code: 'project_importing',
        });
        store.importResult(project, 'ready');
        const { run } = store.addRun(owner, project, 'run', 'original prompt');
        const denied = randomUUID();
        for (const status of [
            'queued',
            'running',
            'recovering',
            'cancelling',
            'needs_review',
        ]) {
            sql.prepare('UPDATE runs SET status=? WHERE id=?').run(
                status,
                run.id,
            );
            assert.deepEqual(
                begin(status === 'queued' ? denied : randomUUID()),
                {
                    state: 'denied',
                    code: 'project_busy',
                },
            );
        }
        sql.prepare(
            "UPDATE runs SET status='succeeded', diff='' WHERE id=?",
        ).run(run.id);
        assert.deepEqual(begin(denied), {
            state: 'denied',
            code: 'project_busy',
        });
        const hold = randomUUID();
        assert.deepEqual(store.acquireFileDeleteHold(owner, project, hold), {
            state: 'held',
        });
        assert.deepEqual(begin(), {
            state: 'denied',
            code: 'project_busy',
        });
        store.releaseFileDeleteHold(owner, project, hold);
        assert.deepEqual(store.projectDeletionImpact(owner, project), {
            runCount: 1,
            diffCount: 1,
            blockers: [],
        });
        assert.equal(store.diff(owner, project, run.id), '');
        const operation = randomUUID();
        assert.throws(
            () => store.projectDeletionBinding(owner, project, operation),
            { status: 404 },
        );
        assert.deepEqual(begin(operation), { state: 'deleting' });
        assert.throws(() => store.addRun(owner, project, 'new', 'new prompt'), {
            code: 'project_busy',
        });
        assert.throws(
            () => store.addRun(owner, project, 'run', 'original prompt'),
            { code: 'project_busy' },
        );
        assert.throws(
            () => store.createProject(owner, 'project', readme, 'import'),
            { status: 404 },
        );
        assert.throws(
            () => store.beginProjectDeletion('owner-b', project, operation),
            { status: 404 },
        );
        assert.throws(
            () => store.beginProjectDeletion('owner-b', project, randomUUID()),
            { status: 404 },
        );
        assert.throws(() => begin(), { code: 'idempotency_conflict' });
        assert.deepEqual(store.projects(owner), []);
        assert.throws(() => store.diff(owner, project, run.id), {
            status: 404,
        });
        assert.throws(() => store.cancelQueuedRun(owner, project, run.id), {
            status: 404,
        });
        assert.throws(
            () => store.acquireFileDeleteHold(owner, project, randomUUID()),
            { status: 404 },
        );

        store.close();
        store = new Store(path);
        assert.deepEqual(begin(operation), { state: 'deleting' });
        const binding = store.projectDeletionBinding(owner, project, operation);
        assert.throws(() => store.purgeProject(binding), {
            code: 'project_busy',
        });
        assert.throws(() => store.purgeProject(binding, randomUUID()), {
            status: 404,
        });
        assert.throws(
            () =>
                store.purgeProject({ ...binding, volume: 'other' }, operation),
            { status: 404 },
        );
        sql.exec(
            "CREATE TRIGGER fail_purge BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END",
        );
        assert.throws(
            () => store.purgeProject(binding, operation),
            /fixture rollback/,
        );
        assert.deepEqual(store.projectRunIds(project), [run.id]);
        assert.deepEqual(begin(operation), { state: 'deleting' });
        sql.exec('DROP TRIGGER fail_purge');
        store.purgeProject(binding, operation);
        assert.deepEqual(store.projectRunIds(project), []);
        assert.deepEqual(begin(operation), { state: 'deleted' });
        assert.throws(() => store.projectDeletionImpact(owner, project), {
            status: 404,
        });
        assert.throws(
            () => store.beginProjectDeletion('owner-b', project, operation),
            { status: 404 },
        );
    } finally {
        sql.close();
        store.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('file deletion hold fences Run admission', async () => {
    const state = await mkdtemp(join(tmpdir(), 'bento-file-hold-'));
    const database = join(state, 'execution.sqlite');
    let store = new Store(database);
    let server: ReturnType<typeof executionHttp> | undefined;
    async function listen() {
        server = executionHttp(
            store,
            testToken,
            () => {},
            async () => false,
            (...args) => store.cancelQueuedRun(...args),
            async () => {
                throw new Error('Unexpected project deletion');
            },
        );
        const listening = once(server, 'listening');
        server.listen(0, '127.0.0.1');
        await listening;
        const address = server.address();
        assert(address && typeof address !== 'string');
        return 'http://127.0.0.1:' + address.port;
    }
    async function closeServer() {
        if (!server) return;
        await new Promise<void>((resolve, reject) => {
            server!.close((error) => (error ? reject(error) : resolve()));
            server!.closeAllConnections();
        });
        server = undefined;
    }
    try {
        const owner = 'account-a';
        const projectId = store.addProject(owner, 'Fixture', []).id;
        store.importResult(projectId, 'ready');
        const path = '/' + projectId;
        const holds = path + '/file-deletion-holds/';
        const first = store.addRun(owner, projectId, 'first', 'First').run.id;
        const denied = holds + randomUUID();
        const held = holds + randomUUID();
        const url = await listen();
        const api = client(url);
        assert.equal(
            (await client(url, 'account-b')(held, 'POST')).status,
            404,
        );
        assert.deepEqual((await api(denied, 'POST')).json(), {
            state: 'denied',
        });
        store.status(first, 'succeeded', 'Done', 'fixture diff');
        assert.deepEqual((await api(denied, 'POST')).json(), {
            state: 'denied',
        });
        assert.deepEqual((await api(held, 'POST')).json(), {
            state: 'held',
        });
        assert.equal(
            (await api(path + '/runs', 'POST', { prompt: 'Second' }, 'second'))
                .status,
            409,
        );
        assert.equal(
            (
                await api(path + '/runs', 'POST', { prompt: 'First' }, 'first')
            ).json().id,
            first,
        );
        assert.equal(
            (await api(path + '/runs/' + first)).json().status,
            'succeeded',
        );
        assert.equal(
            (await api(path + '/runs/' + first + '/diff')).text,
            'fixture diff',
        );

        await closeServer();
        store.close();
        store = new Store(database);
        const reopened = client(await listen());
        assert.equal(
            (
                await reopened(
                    path + '/runs',
                    'POST',
                    { prompt: 'Second' },
                    'second',
                )
            ).status,
            409,
        );
        assert.deepEqual((await reopened(held, 'DELETE')).json(), {
            state: 'released',
        });
        assert.deepEqual((await reopened(held, 'POST')).json(), {
            state: 'released',
        });
        const submitted = await reopened(
            path + '/runs',
            'POST',
            { prompt: 'Second' },
            'second',
        );
        assert.equal(submitted.status, 202);
        const second = submitted.json().id;
        assert.equal(store.start(second, [], 1), true);
        assert.equal(
            store.requestRunningCancellation(owner, projectId, second, 0)
                .status,
            'cancelling',
        );
        const duringCancellation = holds + randomUUID();
        assert.deepEqual((await reopened(duringCancellation, 'POST')).json(), {
            state: 'denied',
        });
        assert.equal(store.finishCancellation(second, 0, 'cancelled'), true);
        assert.deepEqual((await reopened(duringCancellation, 'POST')).json(), {
            state: 'denied',
        });
        assert.deepEqual(
            (await reopened(holds + randomUUID(), 'POST')).json(),
            {
                state: 'held',
            },
        );
    } finally {
        await closeServer();
        store.close();
        await rm(state, { recursive: true, force: true });
    }
});
