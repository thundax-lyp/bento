import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { constants, openSync, closeSync, fsyncSync, writeSync } from 'node:fs';
import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    readlink,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { backup, DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PersistenceFence } from '../openshell/persistence-fence.ts';
import { SingleHostExecution } from '../openshell/single-host.ts';
import { executionHttp } from './http.ts';
import { dockerOpenShellPurge } from './docker-openshell-purge.ts';
import { localEnvironmentVersion, localHost } from './local.ts';
import { commandHost } from './command-host.ts';
import { completedTurn } from '@/apps/worker/dsh-worker.ts';
import { Store } from './store.ts';
import { serveExecution, snapshotSha256 } from './service.ts';
import {
    TaskRestoreEvidenceConflict,
    executionBindingDigest,
    type ExecutionHost,
    type FileText,
    type WorkerRequest,
} from './types.ts';
import { processWorker } from './worker.ts';
import { reserveOperation } from '@/apps/worker/protocol.ts';
import { prewarmedWorker } from './warm-worker.ts';

const testToken = 'fixture-only-bento-service-bearer';
const testFile = fileURLToPath(import.meta.url);
const readme = [{ path: 'README.md', text: '# Fixture\n' }];
function barrier() {
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
const fixtureSdk = {
    upstream: new URL('https://127.0.0.1:1'),
    credentials: {
        ca: Buffer.alloc(0),
        cert: Buffer.alloc(0),
        key: Buffer.alloc(0),
    },
    workspace: 'default',
    decode: () => {
        throw new Error('Denied probes should not reach the decoder');
    },
};

type ResponseBody = {
    id: string;
    status: string;
    sessionId: string;
    projects?: { id: string }[];
};
function client(url: string, owner = 'account-a', token = testToken) {
    return async (
        path: string,
        method = 'GET',
        body?: unknown,
        key?: string,
    ) => {
        const response = await fetch(url + '/v1/projects' + path, {
            method,
            headers: {
                authorization: 'Bearer ' + token,
                'x-bento-owner-id': owner,
                ...(body === undefined
                    ? {}
                    : { 'content-type': 'application/json' }),
                ...(key === undefined ? {} : { 'idempotency-key': key }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(5000),
        });
        const type = response.headers.get('content-type');
        const text = await response.text();
        return {
            status: response.status,
            type,
            text,
            json: () => JSON.parse(text) as ResponseBody,
        };
    };
}

async function until<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    label: string,
) {
    for (let i = 0; i < 250; i++) {
        const value = await read();
        if (done(value)) return value;
        await delay(20);
    }
    throw new Error('Timed out: ' + label);
}

async function project(
    api: ReturnType<typeof client>,
    files: FileText[] = readme,
) {
    const created = await api('', 'POST', { name: 'Text project', files });
    assert.equal(created.status, 201);
    const path = '/' + created.json().id;
    await until(
        () => api(path),
        (r) => r.json().status === 'ready',
        'project ready',
    );
    return path;
}

async function submit(
    api: ReturnType<typeof client>,
    projectPath: string,
    prompt: string,
    key: string,
) {
    const response = await api(projectPath + '/runs', 'POST', { prompt }, key);
    assert.equal(response.status, 202);
    return projectPath + '/runs/' + response.json().id;
}

async function rpc(
    request: WorkerRequest,
    method: string,
    fields: object = {},
) {
    return fetch(new URL('/rpc', request.persistenceUrl), {
        method: 'POST',
        headers: { authorization: 'Bearer ' + request.grant.token },
        body: JSON.stringify({ method, id: request.grant.session, ...fields }),
        signal: AbortSignal.timeout(5000),
    });
}

async function operation(request: WorkerRequest) {
    return fetch(new URL('/operations', request.operationUrl), {
        method: 'POST',
        headers: { authorization: 'Bearer ' + request.grant.token },
        body: JSON.stringify({ id: 'forbidden', input: 'probe' }),
        signal: AbortSignal.timeout(5000),
    });
}

async function sdk(request: WorkerRequest) {
    assert(request.gateway);
    const transport = connect(request.gateway);
    return new Promise<string>((resolve, reject) => {
        const call = transport.request({
            ':method': 'POST',
            ':path': '/openshell.v1.OpenShell/ExecSandbox',
            'content-type': 'application/grpc',
            authorization: 'Bearer ' + request.grant.token,
        });
        const timeout = setTimeout(
            () => transport.destroy(new Error('SDK probe timed out')),
            3000,
        );
        transport.once('error', reject);
        transport.once('close', () => clearTimeout(timeout));
        call.once('error', reject);
        call.once('response', (headers) => {
            resolve(String(headers['grpc-status']));
            transport.destroy();
        });
        call.resume();
        call.end(Buffer.alloc(5));
    });
}

async function start(state: string, host: ExecutionHost) {
    return serveExecution({
        state,
        host,
        token: testToken,
        retryMs: 20,
        workerTimeoutMs: 15_000,
    });
}

async function effectWorker(state: string) {
    const parts: Buffer[] = [];
    for await (const part of process.stdin) parts.push(part as Buffer);
    const request = JSON.parse(
        Buffer.concat(parts).toString('utf8'),
    ) as WorkerRequest;
    assert.equal(request.mode, 'execute');
    const created = await rpc(request, 'create', {
        header: {
            id: request.grant.session,
            version: 4,
            createdAt: Date.now(),
            isSeeded: false,
        },
    });
    assert.equal(created.status, 200);
    const result = (await created.json()) as {
        ok: boolean;
        value: { key: string };
    };
    assert(result.ok);
    await writeFile(
        join(state, 'old-grant.json'),
        JSON.stringify({ request, key: result.value.key }),
        { mode: 0o600 },
    );
    assert.equal(
        await reserveOperation(request, 'fault-effect', 'append'),
        true,
    );
    const file = openSync(
        join(state, 'volume', request.binding.project, 'volume', 'README.md'),
        'a',
    );
    writeSync(file, 'once\n');
    fsyncSync(file);
    closeSync(file);
    process.exit(73);
}

async function crashController(state: string) {
    const base = localHost(join(state, 'volume'));
    const service = await start(state, {
        ...base,
        sdk: fixtureSdk,
        worker: processWorker({
            command: process.execPath,
            args: [...process.execArgv, testFile, '--effect-worker', state],
        }),
        async stop(binding) {
            await base.stop(binding);
            await writeFile(join(state, 'stop-observed'), '');
            throw new Error('Lost stop acknowledgment');
        },
        async stopped() {
            return false;
        },
    });
    process.stdout.write(service.url + '\n');
}

async function projectDeleteControlFixture(counter: string) {
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
        const { id, method } = JSON.parse(line) as {
            id: string;
            method: string;
        };
        let result: { value: unknown } | { error: string } = { value: null };
        if (method === 'purge') {
            const count =
                Number(await readFile(counter, 'utf8').catch(() => '0')) + 1;
            await writeFile(counter, String(count));
            result =
                count === 2
                    ? { error: 'Unconfirmed workflow deletion' }
                    : { value: count >= 3 };
        } else if (method === 'choose') {
            result = { value: '' };
        } else if (method !== 'start' && method !== 'close') {
            result = { error: 'Unexpected control method' };
        }
        process.stdout.write(JSON.stringify({ id, ...result }) + '\n');
        if (method === 'close') break;
    }
}

async function taskCrashController(state: string, fault: string) {
    const base = localHost(join(state, 'volume'));
    const service = await start(state, {
        ...base,
        taskRecovery: {
            ...base.taskRecovery!,
            async retryObservation(...args) {
                if (fault === 'after-authority') process.exit(79);
                return base.taskRecovery!.retryObservation(...args);
            },
        },
        async worker(request, signal, slot) {
            if (request.mode !== 'execute')
                return base.worker(request, signal, slot);
            if (fault === 'before-write') {
                assert(
                    await reserveOperation(
                        request,
                        'local-demo',
                        request.prompt!,
                        signal,
                    ),
                );
                process.exit(79);
            }
            if (fault === 'before-receipt') {
                // The fixture write reaches the volume but cannot save its evidence.
                await writeFile(
                    join(state, 'volume', request.binding.project, 'writes'),
                    'receipt fault',
                );
                await base.worker(request, signal, slot).catch(() => {});
                process.exit(79);
            }
            await base.worker(request, signal, slot);
            if (fault === 'before-authority') process.exit(79);
            // The host exit and write receipts exist; there is no successful Run receipt.
            return 'review';
        },
    });
    process.stdout.write(service.url + '\n');
}

if (process.argv[2] === '--effect-worker') {
    await effectWorker(process.argv[3] ?? '');
} else if (process.argv[2] === '--project-delete-control-fixture') {
    await projectDeleteControlFixture(process.argv[3] ?? '');
} else if (process.argv[2] === '--crash-controller') {
    await crashController(process.argv[3] ?? '');
} else if (process.argv[2] === '--task-crash-controller') {
    await taskCrashController(process.argv[3] ?? '', process.argv[4] ?? '');
} else {
    test('DSH completion and UNKNOWN use the structured event shapes', () => {
        const completed = {
            type: 'turn/end',
            data: { turn: 2, reason: { kind: 'completed' } },
        };
        const interrupted = {
            type: 'turn/end',
            data: { turn: 1, reason: { kind: 'interrupted' } },
        };
        const unknown = {
            type: 'tool/result',
            data: {
                error: {
                    name: 'ToolOutcomeUnknownError',
                    code: 'TOOL_OUTCOME_UNKNOWN',
                },
            },
        };
        assert.equal(completedTurn([completed]), true);
        assert.equal(completedTurn([interrupted]), false);
        assert.equal(completedTurn([unknown, completed]), false);
        assert.equal(completedTurn([]), false);
    });
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
            sql.prepare("UPDATE runs SET diff='' WHERE id=?").run(
                run.json().id,
            );
            sql.close();
            assert.deepEqual((await a(target + '/deletion')).json(), {
                runCount: 1,
                diffCount: 1,
                blockers: [],
            });
            assert.equal((await a(runPath + '/diff')).text, '');
            assert.equal(
                (await a(target, 'DELETE', undefined, key)).status,
                409,
            );
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
            assert.equal(
                (await a(target, 'DELETE', undefined, 'bad')).status,
                400,
            );
            const duplicate = await fetch(
                service.url + '/v1/projects' + target,
                {
                    method: 'DELETE',
                    headers: [
                        ['Authorization', 'Bearer ' + testToken],
                        ['X-Bento-Owner-Id', 'account-a'],
                        ['Idempotency-Key', operation],
                        ['Idempotency-Key', randomUUID()],
                    ],
                },
            );
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
                const response = await fetch(
                    service.url + '/v1/account/purge',
                    {
                        method: 'POST',
                        headers: {
                            Authorization: 'Bearer ' + testToken,
                            'X-Bento-Owner-Id': 'account-a',
                        },
                    },
                );
                await response.json();
                return response.status;
            };
            try {
                const api = client(service.url);
                const target = await project(api);
                const other = await project(api);
                const operation = randomUUID();
                if (deletionFirst) {
                    const deleting = api(
                        target,
                        'DELETE',
                        undefined,
                        operation,
                    );
                    await entered.promise;
                    assert.equal(await accountPurge(), 202);
                    assert.match(
                        (await api(other, 'DELETE', undefined, randomUUID()))
                            .text,
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
                        (await api(target, 'DELETE', undefined, operation))
                            .text,
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
                        (
                            await reopened(
                                other,
                                'DELETE',
                                undefined,
                                randomUUID(),
                            )
                        ).text,
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

    const temporalBinary = process.env.BENTO_TEST_TEMPORAL_BINARY;
    test(
        'Temporal Activity retries a completed Run without repeating its effect',
        { timeout: 25_000, skip: !temporalBinary },
        async () => {
            assert(temporalBinary);
            const state = await mkdtemp(
                join(tmpdir(), 'bento-temporal-retry-'),
            );
            const controlEnv = process.env.BENTO_GO_CONTROL;
            const reportEnv = process.env.BENTO_TEST_TEMPORAL_REPORT;
            const reportPath = join(state, 'report.json');
            let service: Awaited<ReturnType<typeof serveExecution>> | undefined;
            try {
                const wrapper = join(state, 'control');
                const quote = (value: string) =>
                    "'" + value.replaceAll("'", "'\"'\"'") + "'";
                await writeFile(
                    wrapper,
                    '#!/bin/sh\nexec ' +
                        [
                            temporalBinary,
                            '-test.run=^TestTemporalRetryControlProcess$',
                        ]
                            .map(quote)
                            .join(' ') +
                        '\n',
                    { mode: 0o700 },
                );
                process.env.BENTO_GO_CONTROL = wrapper;
                process.env.BENTO_TEST_TEMPORAL_REPORT = reportPath;
                const base = localHost(join(state, 'volume'));
                let workerCalls = 0;
                service = await serveExecution({
                    state,
                    host: {
                        ...base,
                        async worker(request, signal) {
                            workerCalls++;
                            return base.worker(request, signal);
                        },
                    },
                    token: testToken,
                    retryMs: 20,
                    workerTimeoutMs: 15_000,
                    temporal: { address: 'fixture', taskQueue: 'fixture' },
                });
                const api = client(service.url);
                const target = await project(api);
                const run = await submit(api, target, 'retry effect', 'retry');
                const runId = run.split('/').at(-1);
                const deadline = performance.now() + 12_000;
                let report: unknown;
                for (;;) {
                    try {
                        report = JSON.parse(await readFile(reportPath, 'utf8'));
                        break;
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                            throw error;
                        if (performance.now() >= deadline)
                            throw new Error(
                                `Timed out after 12 seconds waiting for Temporal report for Run ${runId}`,
                                { cause: error },
                            );
                        await delay(20);
                    }
                }
                assert.deepEqual(report, {
                    runId,
                    replyIds: ['go-1', 'go-2'],
                });
                const detail = await api(run);
                assert.equal(detail.status, 200);
                assert.equal(detail.json().status, 'succeeded');
                const diff = await api(run + '/diff');
                assert.equal(diff.status, 200);
                assert.equal(diff.text.match(/^\+retry effect$/gm)?.length, 1);
                assert.equal(
                    await readFile(
                        join(
                            state,
                            'volume',
                            target.slice(1),
                            'volume',
                            'README.md',
                        ),
                        'utf8',
                    ),
                    '# Fixture\nretry effect\n',
                );
                assert.equal(workerCalls, 1);
            } finally {
                try {
                    await service?.close();
                } finally {
                    if (controlEnv === undefined)
                        delete process.env.BENTO_GO_CONTROL;
                    else process.env.BENTO_GO_CONTROL = controlEnv;
                    if (reportEnv === undefined)
                        delete process.env.BENTO_TEST_TEMPORAL_REPORT;
                    else process.env.BENTO_TEST_TEMPORAL_REPORT = reportEnv;
                    await rm(state, { recursive: true, force: true });
                }
            }
        },
    );

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
                    testFile,
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
                (await client(service.url)(path, 'DELETE', undefined, key))
                    .status,
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
                    if (++attachmentChecks === 1)
                        return ok('attached-container');
                    if (attachmentChecks === 2)
                        throw new Error(
                            'Cannot confirm attachment has cleared',
                        );
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
            const project = store.createProject(
                owner,
                'project',
                readme,
                'import',
            ).project.id;
            const begin = (operation = randomUUID()) =>
                store.beginProjectDeletion(owner, project, operation);
            assert.deepEqual(begin(), {
                state: 'denied',
                code: 'project_importing',
            });
            store.importResult(project, 'ready');
            const { run } = store.addRun(
                owner,
                project,
                'run',
                'original prompt',
            );
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
            assert.deepEqual(
                store.acquireFileDeleteHold(owner, project, hold),
                { state: 'held' },
            );
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
            assert.throws(
                () => store.addRun(owner, project, 'new', 'new prompt'),
                { code: 'project_busy' },
            );
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
                () =>
                    store.beginProjectDeletion(
                        'owner-b',
                        project,
                        randomUUID(),
                    ),
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
            const binding = store.projectDeletionBinding(
                owner,
                project,
                operation,
            );
            assert.throws(() => store.purgeProject(binding), {
                code: 'project_busy',
            });
            assert.throws(() => store.purgeProject(binding, randomUUID()), {
                status: 404,
            });
            assert.throws(
                () =>
                    store.purgeProject(
                        { ...binding, volume: 'other' },
                        operation,
                    ),
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
            const first = store.addRun(owner, projectId, 'first', 'First').run
                .id;
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
                (
                    await api(
                        path + '/runs',
                        'POST',
                        { prompt: 'Second' },
                        'second',
                    )
                ).status,
                409,
            );
            assert.equal(
                (
                    await api(
                        path + '/runs',
                        'POST',
                        { prompt: 'First' },
                        'first',
                    )
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
            assert.deepEqual(
                (await reopened(duringCancellation, 'POST')).json(),
                {
                    state: 'denied',
                },
            );
            assert.equal(
                store.finishCancellation(second, 0, 'cancelled'),
                true,
            );
            assert.deepEqual(
                (await reopened(duringCancellation, 'POST')).json(),
                {
                    state: 'denied',
                },
            );
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

    test('queued cancellation store', async () => {
        const state = await mkdtemp(join(tmpdir(), 'bento-cancel-store-'));
        const file = join(state, 'business.sqlite');
        let store = new Store(file);
        const newRun = () => {
            const { id: project } = store.addProject('A', 'Project', []);
            store.importResult(project, 'ready');
            return {
                project,
                run: store.addRun('A', project, 'key', 'prompt').run.id,
            };
        };
        try {
            const first = newRun();
            const cancel = () =>
                store.cancelQueuedRun('A', first.project, first.run);
            const cancelled = cancel();
            assert.equal(cancelled.status, 'cancelled');
            assert.equal(store.reserveDispatch(first.run, 1), false);
            assert.equal(store.start(first.run, [], 1), false);
            assert.deepEqual(store.dispatchSnapshot(1).queued, []);
            assert.deepEqual(store.schedulableRuns(), []);
            store.close();
            store = new Store(file);
            assert.deepEqual(cancel(), cancelled);
            const second = newRun();
            assert.equal(store.reserveDispatch(second.run, 1), true);
            assert.equal(
                store.cancelQueuedRun('A', second.project, second.run).status,
                'cancelled',
            );
            assert.equal(store.dispatchReserved(second.run), true);
            assert.deepEqual(store.dispatchSnapshot(1).occupied, []);
            assert.deepEqual(store.schedulableRuns(), []);
            assert.equal(store.start(second.run, [], 1), false);
            const third = newRun();
            assert.equal(store.start(third.run, [], 1), true);
            assert.throws(
                () => store.cancelQueuedRun('A', third.project, third.run),
                { status: 409 },
            );
            assert.equal(store.findRun(third.run).status, 'running');
        } finally {
            store.close();
            await rm(state, { recursive: true, force: true });
        }
    });

    test('queued cancellation HTTP', { timeout: 15_000 }, async () => {
        const state = await mkdtemp(join(tmpdir(), 'bento-cancel-http-'));
        const base = localHost(join(state, 'volume'));
        const snapshotStarted = barrier(),
            releaseSnapshot = barrier();
        const workerStarted = barrier(),
            releaseWorker = barrier();
        const prompts: (string | undefined)[] = [];
        let target = '';
        let blocked = false;
        let workerSignal: AbortSignal | undefined;
        const service = await start(state, {
            ...base,
            async snapshot(binding) {
                if (binding.project === target && !blocked) {
                    blocked = true;
                    snapshotStarted.resolve();
                    await releaseSnapshot.promise;
                    throw new Error('late snapshot error');
                }
                return base.snapshot(binding);
            },
            async worker(request, signal) {
                prompts.push(request.prompt);
                workerSignal = signal;
                workerStarted.resolve();
                await releaseWorker.promise;
                return base.worker(request, signal);
            },
        });
        try {
            const api = client(service.url);
            const a = await project(api);
            const b = await project(api);
            target = a.slice(1);
            const run = await submit(api, a, 'cancel-me', 'first');
            await snapshotStarted.promise;
            assert.equal((await api(run)).json().status, 'queued');
            assert.equal(
                (
                    await client(service.url, 'account-b')(
                        run + '/cancel',
                        'POST',
                    )
                ).status,
                404,
            );
            assert.equal(
                (
                    await api(
                        b + '/runs/' + run.split('/').at(-1) + '/cancel',
                        'POST',
                    )
                ).status,
                404,
            );
            const response = await api(run + '/cancel', 'POST');
            assert.equal(response.status, 200);
            assert.equal(response.json().status, 'cancelled');
            assert.equal(
                (await api(run + '/cancel', 'POST')).text,
                response.text,
            );
            assert.equal((await api(run)).text, response.text);
            assert.equal((await api(run + '/diff')).status, 409);
            releaseSnapshot.resolve();
            const next = await submit(api, a, 'noop', 'second');
            await workerStarted.promise;
            assert.deepEqual(prompts, ['noop']);
            assert.equal((await api(next + '/cancel', 'POST')).status, 409);
            assert.equal((await api(next)).json().status, 'running');
            assert.equal(workerSignal?.aborted, false);
            releaseWorker.resolve();
            await until(
                () => api(next),
                (r) => r.json().status === 'succeeded',
                'next Run succeeds',
            );
            assert.equal((await api(run)).json().status, 'cancelled');
        } finally {
            releaseSnapshot.resolve();
            releaseWorker.resolve();
            await service.close();
            await rm(state, { recursive: true, force: true });
        }
    });

    test('running cancellation ledger', async () => {
        const state = await mkdtemp(join(tmpdir(), 'bento-cancel-ledger-'));
        const file = join(state, 'business.sqlite');
        let store = new Store(file);
        try {
            const { id: project } = store.addProject('A', 'Project', []);
            store.importResult(project, 'ready');
            const id = store.addRun('A', project, 'first', 'prompt').run.id;
            assert(store.start(id, [], 1));
            const cancel = () =>
                store.requestRunningCancellation('A', project, id, 1);
            const intent = cancel();
            assert.equal(intent.status, 'cancelling');
            assert.deepEqual(
                store.dispatchSnapshot(1).occupied.map((row) => ({ ...row })),
                [{ owner: 'A', status: 'cancelling' }],
            );
            assert.throws(
                () => store.addRun('A', project, 'second', 'prompt'),
                { status: 409 },
            );
            store.received(id);
            assert.equal(store.findRun(id).receipt, 0);
            assert.deepEqual(cancel(), intent);
            store.close();
            store = new Store(file);
            assert.deepEqual(cancel(), intent);
            assert.deepEqual(store.schedulableRuns(), [id]);
            assert.equal(store.finishCancellation(id, 1, 'cancelled'), false);
            store.markCancellationWorkerClosed(id, 1);
            assert.equal(store.finishCancellation(id, 1, 'cancelled'), true);
            assert.deepEqual(store.dispatchSnapshot(1).occupied, []);
            const next = store.addRun('A', project, 'second', 'prompt').run.id;
            assert(store.start(next, [], 1));
            store.received(next);
            const completed = store.findRun(next);
            assert.throws(
                () => store.requestRunningCancellation('A', project, next, 2),
                { status: 409 },
            );
            assert.deepEqual(store.findRun(next), completed);
        } finally {
            store.close();
            await rm(state, { recursive: true, force: true });
        }
    });

    test('running cancellation stop', { timeout: 15_000 }, async () => {
        const state = await mkdtemp(join(tmpdir(), 'bento-running-cancel-'));
        const base = localHost(join(state, 'volume'));
        const running = barrier();
        let workers = 0;
        const service = await start(state, {
            ...base,
            supportsRunningCancellation: true,
            async worker(_request, signal, _slot, onWorkerExit) {
                workers++;
                running.resolve();
                await delay(60_000, undefined, { signal }).catch(() => {});
                onWorkerExit?.();
                return 'review';
            },
        });
        try {
            const api = client(service.url);
            const target = await project(api);
            const run = await submit(api, target, 'noop', 'first');
            await running.promise;
            assert.equal((await api(run)).json().status, 'running');
            const response = await api(run + '/cancel', 'POST');
            assert.equal(response.status, 200);
            assert.equal(response.json().status, 'cancelling');
            await until(
                () => api(run),
                (value) => value.json().status === 'cancelled',
                'cancelled',
            );
            assert.equal((await api(run + '/diff')).status, 409);
            assert.equal(workers, 1);
        } finally {
            await service.close();
            await rm(state, { recursive: true, force: true });
        }
    });

    async function cancellationFault(
        options: { unknown?: boolean; blockedStop?: boolean } = {},
    ) {
        const state = await mkdtemp(join(tmpdir(), 'bento-cancel-fault-'));
        const base = localHost(join(state, 'volume'));
        const entered = barrier();
        const workerSettled = barrier();
        const sandboxStopped = barrier();
        const trace: WorkerRequest[] = [];
        let stopConfirmed = !options.blockedStop;
        let stopCalls = 0;
        let releaseExit: (() => void) | undefined;
        const host: ExecutionHost = {
            ...base,
            supportsRunningCancellation: true,
            async worker(request, signal, _slot, onWorkerExit) {
                trace.push(request);
                if (request.prompt !== 'cancel target')
                    return base.worker(request, signal);
                if (options.unknown) {
                    assert.equal(
                        await reserveOperation(
                            request,
                            'cancelled-tool',
                            'effect',
                        ),
                        true,
                    );
                }
                entered.resolve();
                await delay(60_000, undefined, { signal }).catch(() => {});
                releaseExit = onWorkerExit;
                workerSettled.resolve();
                return 'review';
            },
            async stop(binding) {
                stopCalls++;
                await base.stop(binding);
            },
            async stopped(binding) {
                if (!stopConfirmed) return false;
                return base.stopped(binding);
            },
            async running(binding) {
                const result = await base.running(binding);
                if (result.running) sandboxStopped.resolve();
                return result;
            },
        };
        let service = await start(state, host);
        return {
            get url() {
                return service.url;
            },
            trace,
            entered,
            workerSettled,
            sandboxStopped,
            confirmSandboxStop() {
                stopConfirmed = true;
            },
            observeWorkerExit() {
                assert(
                    releaseExit,
                    'Worker must have returned before observing exit',
                );
                releaseExit();
            },
            get stopCalls() {
                return stopCalls;
            },
            close: () => service.close(),
            async reopen() {
                service = await start(state, host);
            },
            async dispose() {
                await service.close();
                await rm(state, { recursive: true, force: true });
            },
        };
    }

    test('cancellation fault keeps the slot', { timeout: 15_000 }, async () => {
        const fixture = await cancellationFault({ blockedStop: true });
        try {
            const a = client(fixture.url);
            const b = client(fixture.url, 'account-b');
            const pa = await project(a),
                pb = await project(b);
            const run = await submit(a, pa, 'cancel target', 'first');
            await fixture.entered.promise;
            const next = await submit(b, pb, 'noop', 'next');
            const accepted = await a(run + '/cancel', 'POST');
            assert.equal(accepted.status, 200);
            assert.equal(accepted.json().status, 'cancelling');
            await fixture.workerSettled.promise;
            assert.equal((await a(run)).json().status, 'cancelling');
            assert.equal((await b(next)).json().status, 'queued');
            assert.equal(
                (await a(pa + '/runs', 'POST', { prompt: 'noop' }, 'other'))
                    .status,
                409,
            );
            const old = fixture.trace[0];
            assert(old);
            assert.equal((await rpc(old, 'flush')).status, 403);
            assert.equal((await operation(old)).status, 403);

            fixture.confirmSandboxStop();
            await fixture.sandboxStopped.promise;
            assert.equal((await a(run)).json().status, 'cancelling');
            assert.equal(
                (await a(run + '/cancel', 'POST')).text,
                accepted.text,
            );
            assert.equal((await b(next)).json().status, 'queued');
            assert.equal(fixture.trace.length, 1);
            assert.equal(fixture.stopCalls, 1);

            fixture.observeWorkerExit();
            await until(
                () => a(run),
                (r) => r.json().status === 'cancelled',
                'cancellation terminates',
            );
            await until(
                () => b(next),
                (r) => r.json().status === 'succeeded',
                'next Run receives slot',
            );
            assert.deepEqual(
                fixture.trace.map((request) => request.prompt),
                ['cancel target', 'noop'],
            );
        } finally {
            await fixture.dispose();
        }
    });

    test(
        'cancellation fault preserves unknown effects',
        { timeout: 15_000 },
        async () => {
            const fixture = await cancellationFault({ unknown: true });
            try {
                const api = client(fixture.url);
                const target = await project(api);
                const run = await submit(api, target, 'cancel target', 'first');
                await fixture.entered.promise;
                assert.equal(
                    (await api(run + '/cancel', 'POST')).json().status,
                    'cancelling',
                );
                await fixture.workerSettled.promise;
                fixture.observeWorkerExit();
                const result = await until(
                    () => api(run),
                    (r) => r.json().status === 'needs_review',
                    'unknown effect needs review',
                );
                assert.equal(
                    (await api(run + '/cancel', 'POST')).text,
                    result.text,
                );
                assert.equal((await api(run + '/diff')).status, 409);
                assert.equal(
                    (
                        await api(
                            target + '/runs',
                            'POST',
                            { prompt: 'noop' },
                            'next',
                        )
                    ).status,
                    409,
                );
                assert.deepEqual(
                    fixture.trace.map((request) => request.mode),
                    ['execute'],
                );
            } finally {
                await fixture.dispose();
            }
        },
    );

    test(
        'cancellation fault ignores exit after shutdown',
        { timeout: 15_000 },
        async () => {
            const fixture = await cancellationFault();
            try {
                const api = client(fixture.url);
                const target = await project(api);
                const run = await submit(api, target, 'cancel target', 'first');
                await fixture.entered.promise;
                const accepted = await api(run + '/cancel', 'POST');
                assert.equal(accepted.json().status, 'cancelling');
                await fixture.workerSettled.promise;
                await fixture.sandboxStopped.promise;
                await fixture.close();
                assert.doesNotThrow(() => fixture.observeWorkerExit());

                await fixture.reopen();
                const restarted = client(fixture.url);
                assert.equal((await restarted(run)).text, accepted.text);
                assert.equal(
                    (await restarted(run + '/cancel', 'POST')).text,
                    accepted.text,
                );
                assert.equal(
                    (
                        await restarted(
                            target + '/runs',
                            'POST',
                            { prompt: 'noop' },
                            'next',
                        )
                    ).status,
                    409,
                );
                assert.equal(fixture.trace.length, 1);
                assert.equal(fixture.stopCalls, 1);
            } finally {
                await fixture.dispose();
            }
        },
    );

    test('tenant queue limits and selected reservations survive restart and count recovery', async () => {
        const state = await mkdtemp(join(tmpdir(), 'bento-fair-queue-'));
        const file = join(state, 'business.sqlite');
        let store = new Store(file, 2);
        const project = (tenant: string) => {
            const { id } = store.addProject(tenant, tenant, []);
            store.importResult(id, 'ready');
            return id;
        };
        const submit = (tenant: string, id = project(tenant)) =>
            store.addRun(tenant, id, 'key', 'prompt').run.id;
        const reserve = (id: string) => {
            assert(store.reserveDispatch(id, 2));
            assert(store.dispatchReserved(id));
        };
        const startRun = (id: string) => assert(store.start(id, [], 2));
        const done = (id: string) => store.status(id, 'succeeded', 'Complete');
        try {
            const a0 = submit('A');
            const a1 = submit('A');
            reserve(a0);
            assert.equal(store.reserveDispatch(a1, 2), false);
            startRun(a0);
            reserve(a1);
            startRun(a1);
            const a2Project = project('A');
            const a2 = submit('A', a2Project);
            const a3 = submit('A');
            const a4Project = project('A');
            assert.throws(() => submit('A', a4Project), {
                status: 429,
                code: 'tenant_queue_full',
            });
            assert.equal(submit('A', a2Project), a2);
            const b0 = submit('B');
            const c0 = submit('C');
            assert.equal(store.reserveDispatch(a2, 2), false);

            store.status(a0, 'recovering', 'Recovering');
            done(a1);
            reserve(b0);
            store.close();
            store = new Store(file, 2);
            assert.deepEqual(store.schedulableRuns(), [a0, b0]);
            assert.equal(store.reserveDispatch(a2, 2), false);
            startRun(b0);
            done(b0);
            reserve(c0);
            startRun(c0);
            done(c0);
            reserve(a2);
            assert.equal(store.dispatchReserved(a3), false);
            startRun(a2);
            const a4 = submit('A', a4Project);
            done(a0);
            reserve(a3);
            startRun(a3);
            assert.equal(store.dispatchReserved(a4), false);
            done(a2);
            reserve(a4);
        } finally {
            store.close();
            await rm(state, { recursive: true, force: true });
        }
    });

    test('aborting one warm slot preserves the other worker and replaces only the aborted slot', async () => {
        const state = await mkdtemp(join(tmpdir(), 'bento-warm-test-'));
        const dispatched = join(state, 'dispatched');
        const pool = prewarmedWorker(
            {
                command: process.execPath,
                args: [
                    '-e',
                    `
                const { createInterface } = require('node:readline');
                const { writeFileSync } = require('node:fs');
                let completed = 0;
                console.log('ready');
                (async () => {
                    for await (const line of createInterface({ input: process.stdin })) {
                        const { prompt } = JSON.parse(line);
                        if (prompt === 'block') {
                            writeFileSync(process.argv[1], '');
                            await new Promise(() => {});
                        }
                        if (Number(prompt) !== ++completed) process.exit(2);
                        console.log('completed');
                    }
                })();
            `,
                    dispatched,
                ],
            },
            2,
        );
        const lifetime = new AbortController();
        const close = pool.warmWorker(lifetime.signal);
        const run = (
            prompt: string,
            signal = lifetime.signal,
            slot = 0,
            onWorkerExit?: () => void,
        ) =>
            pool.worker(
                { mode: 'execute', prompt } as WorkerRequest,
                signal,
                slot,
                onWorkerExit,
            );
        try {
            assert.equal(await run('1'), 'completed');
            assert.equal(await run('2'), 'completed');
            assert.equal(await run('1', lifetime.signal, 1), 'completed');
            const lease = new AbortController();
            let exited = 0,
                otherExited = 0;
            const blocked = run('block', lease.signal, 0, () => {
                exited++;
            });
            await until(
                () =>
                    readFile(dispatched).then(
                        () => true,
                        () => false,
                    ),
                Boolean,
                'warm worker received request',
            );
            await assert.rejects(run('3'), /occupied/);
            assert.equal(
                await run('2', lifetime.signal, 1, () => {
                    otherExited++;
                }),
                'completed',
            );
            lease.abort();
            await assert.rejects(blocked);
            assert.equal(exited, 1);
            assert.equal(otherExited, 0);
            assert.equal(await run('3', lifetime.signal, 1), 'completed');
            assert.equal(await run('1'), 'completed');
        } finally {
            lifetime.abort();
            await close();
            await rm(state, { recursive: true, force: true });
        }
    });

    test('private project initialization replays the same project after controller restart', async () => {
        const state = await mkdtemp(join(tmpdir(), 'bento-project-replay-'));
        const host = localHost(join(state, 'volume'));
        let service = await start(state, host);
        const key = 'space-initialization-key';
        const input = { name: 'Space project', files: readme };
        try {
            const first = await client(service.url)('', 'POST', input, key);
            assert.equal(first.status, 201);
            await service.close();
            service = await start(state, host);
            const api = client(service.url);
            const retry = await api('', 'POST', input, key);
            assert.equal(retry.status, 200);
            assert.equal(retry.json().id, first.json().id);
            assert.equal(
                (await api('', 'POST', { ...input, name: 'Other input' }, key))
                    .status,
                409,
            );
            assert.deepEqual(
                (await api('')).json().projects?.map((row) => row.id),
                [first.json().id],
            );
            const otherOwner = await client(service.url, 'account-b')(
                '',
                'POST',
                input,
                key,
            );
            assert.equal(otherOwner.status, 201);
            assert.notEqual(otherOwner.json().id, first.json().id);
        } finally {
            await service.close();
            await rm(state, { recursive: true, force: true });
        }
    });

    test('restores the completed Run business ledger from an isolated backup', async (t) => {
        const root = await mkdtemp(join(tmpdir(), 'bento-ledger-restore-'));
        const original = join(root, 'source');
        const restored = join(root, 'restore');
        const source = join(original, 'business.sqlite');
        const archive = join(root, 'backup.sqlite');
        const target = join(restored, 'business.sqlite');
        const prompt = 'ledger restore fixture';
        const key = 'ledger-restore-key';
        let service: Awaited<ReturnType<typeof start>> | undefined;
        let restoreCalls = 0;
        let digest: string;
        try {
            service = await start(
                original,
                localHost(join(original, 'volume')),
            );
            const api = client(service.url);
            const projectPath = await project(api);
            const projectView = await api(projectPath);
            assert.equal(projectView.status, 200);
            assert.equal(projectView.json().status, 'ready');
            const runsPath = projectPath + '/runs';
            const accepted = await api(runsPath, 'POST', { prompt }, key);
            assert.equal(accepted.status, 202);
            const runId = accepted.json().id;
            assert(runId);
            assert(accepted.json().sessionId);
            const runPath = runsPath + '/' + runId;
            const before = await until(
                () => api(runPath),
                (r) => r.json().status === 'succeeded',
                'ledger fixture Run succeeded',
            );
            assert.equal(before.status, 200);
            assert.equal(before.json().sessionId, accepted.json().sessionId);
            const diff = await api(runPath + '/diff');
            assert.equal(diff.status, 200);
            assert.match(diff.text, /\+ledger restore fixture/);
            const replay = await api(runsPath, 'POST', { prompt }, key);
            assert.equal(replay.status, 200);
            assert.equal(replay.json().id, runId);
            assert.equal(replay.json().status, 'succeeded');

            await service.close();
            service = undefined;
            const sourceDb = new DatabaseSync(source, { readOnly: true });
            try {
                await backup(sourceDb, archive);
            } finally {
                sourceDb.close();
            }
            const archiveDb = new DatabaseSync(archive, { readOnly: true });
            try {
                assert.equal(
                    archiveDb.prepare('PRAGMA integrity_check').get()
                        ?.integrity_check,
                    'ok',
                );
                assert.deepEqual(
                    archiveDb.prepare('PRAGMA foreign_key_check').all(),
                    [],
                );
                const row = archiveDb
                    .prepare(
                        'SELECT status, receipt, key, prompt, sessionId, diff FROM runs WHERE id = ?',
                    )
                    .get(runId);
                assert(row);
                assert.deepEqual(
                    { ...row },
                    {
                        status: 'succeeded',
                        receipt: 1,
                        key,
                        prompt,
                        sessionId: accepted.json().sessionId,
                        diff: diff.text,
                    },
                );
            } finally {
                archiveDb.close();
            }

            await mkdir(restored, { mode: 0o700 });
            await copyFile(archive, target, constants.COPYFILE_EXCL);
            const sha256 = async (path: string) =>
                createHash('sha256')
                    .update(await readFile(path))
                    .digest('hex');
            digest = await sha256(archive);
            assert.equal(await sha256(target), digest);

            const fixture = localHost(join(restored, 'volume'));
            const unexpected = async (): Promise<never> => {
                restoreCalls++;
                throw new Error(
                    'Terminal ledger restore must not touch the fixture host',
                );
            };
            service = await start(restored, {
                ...fixture,
                provision: unexpected,
                snapshot: unexpected,
                start: unexpected,
                stop: unexpected,
                running: unexpected,
                stopped: unexpected,
                worker: unexpected,
            });
            const restoredApi = client(service.url);
            const restoredProject = await restoredApi(projectPath);
            assert.equal(restoredProject.status, 200);
            assert.deepEqual(restoredProject.json(), projectView.json());
            const restoredRun = await restoredApi(runPath);
            assert.equal(restoredRun.status, 200);
            assert.deepEqual(restoredRun.json(), before.json());
            const restoredDiff = await restoredApi(runPath + '/diff');
            assert.equal(restoredDiff.status, 200);
            assert.equal(restoredDiff.text, diff.text);
            assert.equal(
                (await client(service.url, 'account-b')(runPath)).status,
                404,
            );
            const restoredReplay = await restoredApi(
                runsPath,
                'POST',
                { prompt },
                key,
            );
            assert.equal(restoredReplay.status, 200);
            assert.deepEqual(restoredReplay.json(), replay.json());
            const conflict = await restoredApi(
                runsPath,
                'POST',
                { prompt: 'different fixture input' },
                key,
            );
            assert.equal(conflict.status, 409);
            assert.equal(
                JSON.parse(conflict.text).error.code,
                'idempotency_conflict',
            );
            const list = await restoredApi(runsPath);
            assert.equal(list.status, 200);
            assert.deepEqual(JSON.parse(list.text), { runs: [replay.json()] });

            await service.close();
            service = undefined;
            assert.equal(restoreCalls, 0);
            assert.equal(await sha256(archive), digest);
        } finally {
            try {
                await service?.close();
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        }
        t.diagnostic('business.sqlite SHA-256 ' + digest);
    });

    test('restores stopped execution state and continues fenced session history', async (t) => {
        const root = await mkdtemp(
            join(tmpdir(), 'bento-execution-state-restore-'),
        );
        const source = join(root, 'source');
        const archive = join(root, 'backup');
        const restored = join(root, 'restore');
        const names = [
            'business.sqlite',
            'authority.sqlite',
            'history.sqlite',
        ] as const;
        const batches = [
            '00000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000002',
        ] as const;
        const prompt = 'restore-source';
        const idempotencyKey = 'restore-source-key';
        let service: Awaited<ReturnType<typeof start>> | undefined;
        let sourceGrant: { request: WorkerRequest; key: string } | undefined;
        let nextRequest: WorkerRequest | undefined;
        let sourceCalls = 0;
        let restoreCalls = 0;
        let workerFailure: { error: unknown } | undefined;

        const turn = (number: number) => {
            const seq = (number - 1) * 2;
            return [
                {
                    type: 'turn/start',
                    seq,
                    time: 1700000000001 + seq,
                    data: { turn: number },
                },
                {
                    type: 'turn/end',
                    seq: seq + 1,
                    time: 1700000000002 + seq,
                    data: { turn: number, reason: { kind: 'completed' } },
                },
            ];
        };
        const events = [turn(1), turn(2)] as const;
        const receipts = batches.map((batch, index) => ({
            epoch: index + 1,
            batch,
            digest: createHash('sha256')
                .update(JSON.stringify(events[index]))
                .digest('hex'),
            first: index * 2,
            count: 2,
        }));
        const header = (id: string) => ({
            id,
            version: 4,
            createdAt: 1700000000000,
            isSeeded: false,
        });
        const sha256 = async (path: string) =>
            createHash('sha256')
                .update(await readFile(path))
                .digest('hex');

        async function call<T = unknown>(
            request: WorkerRequest,
            method: string,
            fields: object = {},
        ): Promise<T> {
            const response = await rpc(request, method, fields);
            assert.equal(response.status, 200, method);
            const result = (await response.json()) as { ok: boolean; value: T };
            assert.equal(result.ok, true, method);
            return result.value;
        }

        async function commitTurn(
            request: WorkerRequest,
            key: string,
            index: 0 | 1,
        ) {
            const fields = {
                key,
                batch: batches[index],
                events: events[index],
            };
            await call(request, 'stage', fields);
            assert.deepEqual(
                await call(request, 'append', fields),
                receipts[index],
            );
            assert.deepEqual(
                await call(request, 'append', fields),
                receipts[index],
            );
            assert.deepEqual(await call(request, 'reconcile', { key }), {
                outcome: 'already-committed',
                receipt: receipts[index],
            });
            await call(request, 'flush', { key });
            await call(request, 'close', { key });
        }

        function fixture(
            state: string,
            execute: (request: WorkerRequest) => Promise<void>,
        ): ExecutionHost {
            return {
                ...localHost(join(state, 'volume')),
                async worker(request) {
                    try {
                        assert.equal(request.mode, 'execute');
                        await execute(request);
                        return 'completed';
                    } catch (error) {
                        workerFailure ??= { error };
                        throw error;
                    }
                },
            };
        }

        async function completed(
            api: ReturnType<typeof client>,
            runPath: string,
        ) {
            const response = await until(
                () => api(runPath),
                (value) => {
                    if (workerFailure) throw workerFailure.error;
                    return value.json().status === 'succeeded';
                },
                'restored fixture Run succeeded',
            );
            assert.equal(response.status, 200);
            return response.json();
        }

        function inspect(
            state: string,
            binding: WorkerRequest['binding'],
            runIds: string[],
            epoch: 1 | 2,
        ) {
            const read = (
                name: (typeof names)[number],
                query: (db: DatabaseSync) => void,
            ) => {
                const db = new DatabaseSync(join(state, name), {
                    readOnly: true,
                });
                try {
                    if (state === archive) {
                        assert.equal(
                            db.prepare('PRAGMA integrity_check').get()
                                ?.integrity_check,
                            'ok',
                        );
                        assert.deepEqual(
                            db.prepare('PRAGMA foreign_key_check').all(),
                            [],
                        );
                    }
                    query(db);
                } finally {
                    db.close();
                }
            };
            read('business.sqlite', (db) => {
                const projects = db
                    .prepare(
                        'SELECT owner AS tenant, id AS project, sessionId AS session, sandbox, volume FROM projects',
                    )
                    .all();
                assert.deepEqual(
                    projects.map((row) => ({ ...row })),
                    [binding],
                );
                const runs = db
                    .prepare(
                        'SELECT id, projectId, sessionId, status, receipt FROM runs ORDER BY rowid',
                    )
                    .all();
                assert.deepEqual(
                    runs.map((row) => ({ ...row })),
                    runIds.map((id) => ({
                        id,
                        projectId: binding.project,
                        sessionId: binding.session,
                        status: 'succeeded',
                        receipt: 1,
                    })),
                );
            });
            read('authority.sqlite', (db) => {
                const rows = db
                    .prepare('SELECT * FROM execution_sessions')
                    .all();
                assert.deepEqual(
                    rows.map((row) => ({ ...row })),
                    [
                        {
                            ...binding,
                            generation: epoch + 1,
                            state: 'READY',
                            run: null,
                            capability: null,
                            expires: null,
                        },
                    ],
                );
            });
            read('history.sqlite', (db) => {
                const sessions = db
                    .prepare(
                        'SELECT id, header, epoch, owner, handle, next, revision, inherited, materialized FROM sessions',
                    )
                    .all();
                assert.deepEqual(
                    sessions.map((row) => ({
                        ...row,
                        header: JSON.parse(String(row.header)),
                    })),
                    [
                        {
                            id: binding.session,
                            header: header(binding.session),
                            epoch,
                            owner: 'bento:revoked',
                            handle: null,
                            next: epoch * 2,
                            revision: epoch,
                            inherited: 0,
                            materialized: 1,
                        },
                    ],
                );
                const storedEvents = db
                    .prepare('SELECT id, seq, event FROM events ORDER BY seq')
                    .all();
                assert.deepEqual(
                    storedEvents.map((row) => ({
                        ...row,
                        event: JSON.parse(String(row.event)),
                    })),
                    events
                        .slice(0, epoch)
                        .flat()
                        .map((event) => ({
                            id: binding.session,
                            seq: event.seq,
                            event,
                        })),
                );
                const storedReceipts = db
                    .prepare('SELECT * FROM batch_receipts ORDER BY epoch')
                    .all();
                assert.deepEqual(
                    storedReceipts.map((row) => ({ ...row })),
                    receipts.slice(0, epoch).map((receipt) => ({
                        id: binding.session,
                        ...receipt,
                    })),
                );
                assert.deepEqual(
                    db.prepare('SELECT * FROM batch_intents').all(),
                    [],
                );
            });
        }

        try {
            service = await start(
                source,
                fixture(source, async (request) => {
                    sourceCalls++;
                    assert.equal(request.grant.generation, 1);
                    const { key } = await call<{ key: string }>(
                        request,
                        'create',
                        {
                            header: header(request.grant.session),
                        },
                    );
                    sourceGrant = { request, key };
                    await commitTurn(request, key, 0);
                }),
            );
            const api = client(service.url);
            const projectPath = await project(api);
            const runPath = await submit(
                api,
                projectPath,
                prompt,
                idempotencyKey,
            );
            const sourceDetail = await completed(api, runPath);
            assert.equal(sourceCalls, 1);
            assert(sourceGrant);
            const old = sourceGrant;
            const binding = old.request.binding;
            const runsPath = projectPath + '/runs';
            const replay = await api(
                runsPath,
                'POST',
                { prompt },
                idempotencyKey,
            );
            assert.equal(replay.status, 200);
            const sourceReplay = replay.json();
            assert.equal(sourceReplay.id, sourceDetail.id);
            assert.equal(sourceReplay.status, 'succeeded');
            await service.close();
            service = undefined;

            await mkdir(archive, { mode: 0o700 });
            for (const name of names) {
                const db = new DatabaseSync(join(source, name), {
                    readOnly: true,
                });
                try {
                    await backup(db, join(archive, name));
                } finally {
                    db.close();
                }
            }
            inspect(archive, binding, [sourceDetail.id], 1);
            await mkdir(restored, { mode: 0o700 });
            const digests = new Map<string, string>();
            for (const name of names) {
                const backupPath = join(archive, name);
                const target = join(restored, name);
                const digest = await sha256(backupPath);
                digests.set(name, digest);
                await copyFile(backupPath, target, constants.COPYFILE_EXCL);
                assert.equal(await sha256(target), digest);
            }
            const volume = join('volume', binding.project, 'volume');
            const data = await readFile(join(source, volume, 'README.md'));
            assert.deepEqual(data, Buffer.from('# Fixture\n'));
            await mkdir(join(restored, volume), {
                recursive: true,
                mode: 0o700,
            });
            const restoredFile = join(restored, volume, 'README.md');
            await writeFile(restoredFile, data, { flag: 'wx', mode: 0o600 });
            assert.deepEqual(await readFile(restoredFile), data);

            service = await start(
                restored,
                fixture(restored, async (request) => {
                    restoreCalls++;
                    nextRequest = request;
                    assert.deepEqual(request.binding, binding);
                    assert.equal(request.grant.generation, 2);
                    const stale = { ...request, grant: old.request.grant };
                    assert.equal(
                        (
                            await rpc(stale, 'append', {
                                key: old.key,
                                batch: batches[0],
                                events: events[0],
                            })
                        ).status,
                        403,
                    );
                    assert.equal(
                        (await rpc(stale, 'flush', { key: old.key })).status,
                        403,
                    );
                    assert.equal(
                        (await rpc(stale, 'close', { key: old.key })).status,
                        403,
                    );
                    assert.deepEqual(await call(request, 'stat'), {
                        header: header(binding.session),
                        eventCount: 2,
                        revision: '1',
                        formatStatus: 'current',
                    });
                    const { key } = await call<{ key: string }>(
                        request,
                        'open',
                        { access: 'write' },
                    );
                    assert.deepEqual(await call(request, 'read', { key }), {
                        eventState: 'detached',
                        events: events[0],
                    });
                    await commitTurn(request, key, 1);
                }),
            );
            const restoredApi = client(service.url);
            const restoredDetail = await restoredApi(runPath);
            assert.equal(restoredDetail.status, 200);
            assert.deepEqual(restoredDetail.json(), sourceDetail);
            const restoredReplay = await restoredApi(
                runsPath,
                'POST',
                { prompt },
                idempotencyKey,
            );
            assert.equal(restoredReplay.status, 200);
            assert.deepEqual(restoredReplay.json(), sourceReplay);
            const nextPath = await submit(
                restoredApi,
                projectPath,
                'restore-next',
                'restore-next-key',
            );
            assert.notEqual(nextPath, runPath);
            const nextDetail = await completed(restoredApi, nextPath);
            assert.equal(restoreCalls, 1);
            assert(nextRequest);
            assert.equal(nextRequest.grant.run, nextDetail.id);
            const list = await restoredApi(runsPath);
            assert.equal(list.status, 200);
            const { runs } = JSON.parse(list.text) as { runs: ResponseBody[] };
            assert.deepEqual(
                runs.map(({ id }) => id).sort(),
                [sourceDetail.id, nextDetail.id].sort(),
            );
            await service.close();
            service = undefined;
            inspect(restored, binding, [sourceDetail.id, nextDetail.id], 2);
            for (const [name, digest] of digests) {
                assert.equal(await sha256(join(archive, name)), digest);
                t.diagnostic(name + ' SHA-256 ' + digest);
            }
        } finally {
            try {
                await service?.close();
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        }
    });

    test('a completed Run retries capture after restart without rerunning its worker', async () => {
        const state = await mkdtemp(join(tmpdir(), 'bento-capture-retry-'));
        const base = localHost(join(state, 'volume'));
        let calls = 0;
        let failCapture = false;
        const host: ExecutionHost = {
            ...base,
            async worker(request, signal) {
                calls++;
                const result = await base.worker(request, signal);
                failCapture = calls === 1;
                return result;
            },
            async snapshot(binding) {
                if (failCapture)
                    throw new Error('Snapshot temporarily unavailable');
                return base.snapshot(binding);
            },
        };
        let service = await start(state, host);
        try {
            const first = client(service.url);
            const path = await project(first);
            const run = await submit(first, path, 'first change', 'first');
            await until(
                () => first(run),
                (r) => r.json().status === 'needs_review',
                'capture failed',
            );
            await service.close();
            failCapture = false;
            service = await start(state, host);
            const api = client(service.url);
            await until(
                () => api(run),
                (r) => r.json().status === 'succeeded',
                'capture retried',
            );
            assert.match((await api(run + '/diff')).text, /\+first change/);
            assert.equal(calls, 1);
            const next = await submit(api, path, 'next change', 'next');
            await until(
                () => api(next),
                (r) => r.json().status === 'succeeded',
                'next Run completed',
            );
        } finally {
            await service.close();
            await rm(state, { recursive: true, force: true });
        }
    });

    test('documented startup installs trusted review and waits for its cleanup', async () => {
        const state = await mkdtemp(join(tmpdir(), 'bento-start-review-'));
        const module = join(state, 'review.mjs');
        const marker = join(state, 'review-result');
        await writeFile(
            module,
            `
            import { writeFile } from 'node:fs/promises';
            export default function install(reviewRun) {
                const review = reviewRun({ failedGeneration: 0 }).then(
                    () => 'unexpected approval',
                    (error) => error.message,
                );
                return async () => writeFile(process.env.BENTO_TEST_REVIEW_RESULT, await review);
            }
        `,
        );
        const controller = spawn(
            process.execPath,
            [
                ...process.execArgv,
                fileURLToPath(new URL('./start.ts', import.meta.url)),
                '--local',
            ],
            {
                env: {
                    ...process.env,
                    BENTO_STATE_DIR: state,
                    BENTO_EXECUTION_ENVIRONMENT_VERSION:
                        localEnvironmentVersion,
                    BENTO_SERVICE_BEARER: testToken,
                    BENTO_PORT: '0',
                    BENTO_REVIEW_MODULE: module,
                    BENTO_TEST_REVIEW_RESULT: marker,
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );
        const closed = once(controller, 'close');
        const lines = createInterface({ input: controller.stdout });
        try {
            const [url] = await Promise.race([
                once(lines, 'line'),
                closed.then(() => {
                    throw new Error(
                        'Execution service exited before listening',
                    );
                }),
            ]);
            assert.equal((await client(url)('')).status, 200);
            controller.kill('SIGTERM');
            assert.deepEqual(await closed, [0, null]);
            assert.equal(
                await readFile(marker, 'utf8'),
                'Invalid review proof',
            );
        } finally {
            controller.kill('SIGKILL');
            await closed;
            lines.close();
            await rm(state, { recursive: true, force: true });
        }
    });

    test(
        'execution entry enforces two-slot tenant fairness and queue backpressure',
        { timeout: 65_000, skip: !process.env.BENTO_TEST_FAIR_BINARY },
        async () => {
            const binary = process.env.BENTO_TEST_FAIR_BINARY;
            const state = process.env.BENTO_TEST_FAIR_DIR;
            assert(binary && state);
            const wrapper = join(state, 'control');
            const module = join(state, 'host.mjs');
            const quote = (value: string) =>
                "'" + value.replaceAll("'", "'\"'\"'") + "'";
            await writeFile(
                wrapper,
                '#!/bin/sh\nexec ' +
                    [
                        binary,
                        '-test.run=^TestTemporalFairDispatchControlProcess$',
                    ]
                        .map(quote)
                        .join(' ') +
                    '\n',
                { mode: 0o700 },
            );
            await writeFile(
                module,
                `
                import { linkSync, unlinkSync, writeFileSync } from 'node:fs';
                import { access } from 'node:fs/promises';
                import { join } from 'node:path';
                import { setTimeout as delay } from 'node:timers/promises';
                import { localHost } from ${JSON.stringify(new URL('./local.ts', import.meta.url).href)};
                export default function ({ state }) {
                    const base = localHost(join(state, 'volume'));
                    let sequence = 0;
                    let active = 0;
                    let peak = 0;
                    return {
                        ...base,
                        workerSlots: 2,
                        warmWorker: () => async () => {},
                        sdk: {
                            upstream: new URL('https://127.0.0.1:1'),
                            credentials: { ca: Buffer.alloc(0), cert: Buffer.alloc(0), key: Buffer.alloc(0) },
                            workspace: 'default',
                            decode() { throw new Error('Unexpected SDK call'); },
                        },
                        async worker(request, signal, slot) {
                            const { prompt, mode, grant, binding } = request;
                            if (mode !== 'execute' || !['A0','A1','A2','A3','B0'].includes(prompt))
                                throw new Error('Unexpected fair dispatch Worker request');
                            const entered = join(state, 'entered-' + prompt);
                            const temporary = entered + '.tmp-' + ++sequence;
                            active++;
                            peak = Math.max(peak, active);
                            try {
                                writeFileSync(temporary, JSON.stringify({
                                    sequence, active, peak, slot, run: grant.run,
                                    tenant: binding.tenant, project: binding.project,
                                }), { flag: 'wx' });
                                try {
                                    linkSync(temporary, entered);
                                } catch (error) {
                                    if (error.code === 'EEXIST')
                                        writeFileSync(join(state, 'duplicate-' + prompt), '');
                                    throw error;
                                } finally {
                                    unlinkSync(temporary);
                                }
                                const deadline = performance.now() + 35_000;
                                while (performance.now() < deadline) {
                                    signal.throwIfAborted();
                                    try {
                                        await access(join(state, 'release-' + prompt));
                                    } catch (error) {
                                        if (error.code !== 'ENOENT') throw error;
                                        await delay(20, undefined, { signal });
                                        continue;
                                    }
                                    return await base.worker(request, signal, slot);
                                }
                                throw new Error('Worker release timed out: ' + prompt);
                            } finally {
                                active--;
                            }
                        },
                    };
                }
                `,
            );
            const controller = spawn(
                process.execPath,
                [
                    ...process.execArgv,
                    fileURLToPath(new URL('./start.ts', import.meta.url)),
                ],
                {
                    detached: false,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: {
                        ...Object.fromEntries(
                            Object.entries(process.env).filter(
                                ([key]) => !key.startsWith('BENTO_'),
                            ),
                        ),
                        BENTO_STATE_DIR: state,
                        BENTO_EXECUTION_ENVIRONMENT_VERSION:
                            localEnvironmentVersion,
                        BENTO_SERVICE_BEARER: testToken,
                        BENTO_BIND_HOST: '127.0.0.1',
                        BENTO_PORT: '0',
                        BENTO_HOST_MODULE: module,
                        BENTO_TENANT_QUEUE_LIMIT: '2',
                        BENTO_GO_CONTROL: wrapper,
                        BENTO_TEST_FAIR_DIR: state,
                        BENTO_TEMPORAL_ADDRESS: 'fixture',
                        BENTO_TEMPORAL_NAMESPACE: 'default',
                        BENTO_TEMPORAL_TASK_QUEUE: 'fair-dispatch',
                    },
                },
            );
            let stderr = Buffer.alloc(0);
            controller.stderr.on('data', (chunk: Buffer) => {
                stderr = Buffer.concat([stderr, chunk]).subarray(-8192);
            });
            let spawnError: Error | undefined;
            controller.once('error', (error) => {
                spawnError = error;
            });
            const closed = new Promise<unknown[]>((resolve) => {
                controller.once('close', (...result) => resolve(result));
            });
            const lines = createInterface({ input: controller.stdout });
            async function within<T>(promise: Promise<T>, label: string) {
                const timer = new AbortController();
                try {
                    return await Promise.race([
                        promise,
                        delay(5000, undefined, { signal: timer.signal }).then(
                            () => {
                                throw new Error('Timed out: ' + label);
                            },
                        ),
                    ]);
                } finally {
                    timer.abort();
                }
            }
            const marker = async (name: string) => {
                try {
                    return await readFile(join(state, name), 'utf8');
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                        return undefined;
                    throw error;
                }
            };
            const release = (name: string) =>
                writeFile(join(state, 'release-' + name), '', { flag: 'wx' });
            try {
                const [url] = await within(
                    Promise.race([
                        once(lines, 'line'),
                        closed.then(() => {
                            throw (
                                spawnError ??
                                new Error(
                                    'Execution entry exited before listening',
                                )
                            );
                        }),
                    ]),
                    'execution entry listening',
                );
                const a = client(url, 'fair-a');
                const b = client(url, 'fair-b');
                const a0 = await project(a);
                const a1 = await project(a);
                const a2 = await project(a);
                const a3 = await project(a);
                const a4 = await project(a);
                const b0 = await project(b);
                async function entered(
                    name: string,
                    run: string,
                    tenant: string,
                    sequence: number,
                    slot: number,
                    active: number,
                ) {
                    const content = await until(
                        () => marker('entered-' + name),
                        (value) => value !== undefined,
                        name + ' entered',
                    );
                    assert(content);
                    const [, project, , id] = run.split('/');
                    assert.deepEqual(JSON.parse(content), {
                        sequence,
                        active,
                        peak: active,
                        slot,
                        run: id,
                        tenant,
                        project,
                    });
                }
                const runA0 = await submit(a, a0, 'A0', 'A0');
                await entered('A0', runA0, 'fair-a', 1, 0, 1);
                const runA1 = await submit(a, a1, 'A1', 'A1');
                await entered('A1', runA1, 'fair-a', 2, 1, 2);
                assert.equal((await a(runA0)).json().status, 'running');
                assert.equal((await a(runA1)).json().status, 'running');

                const runA2 = await submit(a, a2, 'A2', 'A2');
                const runA3 = await submit(a, a3, 'A3', 'A3');
                const rejected = await a(
                    a4 + '/runs',
                    'POST',
                    { prompt: 'A4' },
                    'A4',
                );
                assert.equal(rejected.status, 429);
                assert.equal(
                    JSON.parse(rejected.text).error.code,
                    'tenant_queue_full',
                );
                const empty = await a(a4 + '/runs');
                assert.equal(empty.status, 200);
                assert.deepEqual(empty.json(), { runs: [] });
                const replay = await a(
                    a2 + '/runs',
                    'POST',
                    { prompt: 'A2' },
                    'A2',
                );
                assert.equal(replay.status, 200);
                assert.equal(replay.json().id, runA2.split('/').at(-1));
                const runB0 = await submit(b, b0, 'B0', 'B0');
                assert.equal((await a(runA2)).json().status, 'queued');
                assert.equal((await a(runA3)).json().status, 'queued');
                assert.equal((await b(runB0)).json().status, 'queued');

                await release('A0');
                await entered('B0', runB0, 'fair-b', 3, 0, 2);
                assert.equal((await a(runA1)).json().status, 'running');
                assert.equal((await a(runA2)).json().status, 'queued');
                assert.equal((await a(runA3)).json().status, 'queued');
                await release('B0');
                await entered('A2', runA2, 'fair-a', 4, 0, 2);
                assert.equal((await a(runA1)).json().status, 'running');
                await release('A2');
                await entered('A3', runA3, 'fair-a', 5, 0, 2);
                assert.equal((await a(runA1)).json().status, 'running');
                await release('A3');
                await release('A1');

                const accepted = [
                    [a, runA0, a0, 'A0'],
                    [a, runA1, a1, 'A1'],
                    [a, runA2, a2, 'A2'],
                    [a, runA3, a3, 'A3'],
                    [b, runB0, b0, 'B0'],
                ] as const;
                for (const [api, run, target, prompt] of accepted) {
                    await until(
                        () => api(run),
                        (response) =>
                            response.status === 200 &&
                            response.json().status === 'succeeded',
                        prompt + ' succeeded',
                    );
                    const done = await until(
                        () => marker('done-' + run.split('/').at(-1)),
                        (value) => value !== undefined,
                        prompt + ' Workflow done',
                    );
                    assert.equal(done, '');
                    assert.equal(
                        await readFile(
                            join(
                                state,
                                'volume',
                                target.slice(1),
                                'volume',
                                'README.md',
                            ),
                            'utf8',
                        ),
                        '# Fixture\n' + prompt + '\n',
                    );
                }
                const names = await readdir(state);
                assert.deepEqual(
                    names.filter((name) => name.startsWith('entered-')).sort(),
                    [
                        'entered-A0',
                        'entered-A1',
                        'entered-A2',
                        'entered-A3',
                        'entered-B0',
                    ],
                );
                assert.deepEqual(
                    names.filter((name) => name.startsWith('duplicate-')),
                    [],
                );
                assert.equal(
                    await readFile(
                        join(
                            state,
                            'volume',
                            a4.slice(1),
                            'volume',
                            'README.md',
                        ),
                        'utf8',
                    ),
                    '# Fixture\n',
                );
                assert(controller.pid);
                controller.kill('SIGTERM');
                assert.deepEqual(
                    await within(closed, 'execution entry shutdown'),
                    [0, null],
                );
            } catch (error) {
                if (controller.pid) controller.kill('SIGKILL');
                await within(closed, 'execution entry killed');
                throw new Error(
                    'Fair dispatch execution entry failed\n' +
                        stderr.toString(),
                    { cause: error },
                );
            } finally {
                lines.close();
            }
        },
    );

    test('private HTTP, three-account FIFO, next generation and immutable diff across restart', async () => {
        const state = await mkdtemp(join(tmpdir(), 'bento-http-test-'));
        const base = localHost(join(state, 'volume'));
        const firstStarted = barrier();
        const release = barrier();
        const trace: WorkerRequest[] = [];
        const host: ExecutionHost = {
            ...base,
            sdk: fixtureSdk,
            async worker(request, signal) {
                trace.push(request);
                if (request.prompt === 'line one') {
                    firstStarted.resolve();
                    await release.promise;
                }
                return base.worker(request, signal);
            },
        };
        let service = await start(state, host);
        try {
            await assert.rejects(start(state, host));
            const a = client(service.url);
            const b = client(service.url, 'account-b');
            const c = client(service.url, 'account-c');
            assert.equal(
                (await client(service.url, 'account-a', 'wrong')('')).status,
                401,
            );
            for (const path of [
                '/a',
                'a//b',
                '../a',
                'a/./b',
                'a\\b',
                'a/.git/b',
                'a/\u0001b',
            ]) {
                assert.equal(
                    (
                        await a('', 'POST', {
                            name: 'invalid',
                            files: [{ path, text: '' }],
                        })
                    ).status,
                    400,
                );
            }
            for (const paths of [
                ['a', 'a'],
                ['a', 'a/b'],
            ]) {
                assert.equal(
                    (
                        await a('', 'POST', {
                            name: 'invalid',
                            files: paths.map((path) => ({ path, text: '' })),
                        })
                    ).status,
                    400,
                );
            }
            assert.equal(
                (
                    await a('', 'POST', {
                        name: 'large',
                        files: [{ path: 'a', text: '文'.repeat(350_000) }],
                    })
                ).status,
                413,
            );
            const pa = await project(a);
            const pb = await project(b);
            const pc = await project(c);
            assert.deepEqual(
                (await a('')).json().projects?.map(({ id }) => '/' + id),
                [pa],
            );
            const first = await submit(a, pa, '  line one  ', 'same');
            await firstStarted.promise;
            const second = await submit(b, pb, 'noop', 'same');
            const third = await submit(c, pc, 'line three', 'same');
            assert.equal((await b(second)).json().status, 'queued');
            assert.equal((await c(third)).json().status, 'queued');
            assert.equal(
                (await a(pa + '/runs', 'POST', { prompt: 'other' }, 'other'))
                    .status,
                409,
            );
            assert.equal(
                (await a(pa + '/runs', 'POST', { prompt: 'different' }, 'same'))
                    .status,
                409,
            );
            const replay = await a(
                pa + '/runs',
                'POST',
                { prompt: 'line one' },
                'same',
            );
            assert.equal(replay.status, 200);
            assert(first.endsWith('/' + replay.json().id));
            assert.equal((await a(first + '/diff')).status, 409);
            for (const path of [pa, pa + '/runs', first, first + '/diff']) {
                assert.equal((await b(path)).status, 404);
            }
            assert.equal((await b(pa + '/runs', 'POST', {}, 'x')).status, 404);
            release.resolve();
            for (const [api, path] of [
                [a, first],
                [b, second],
                [c, third],
            ] as const) {
                await until(
                    () => api(path),
                    (r) => r.json().status === 'succeeded',
                    'run succeeded',
                );
            }
            assert.deepEqual(
                trace.map((r) => r.binding.tenant),
                ['account-a', 'account-b', 'account-c'],
            );
            const old = trace[0];
            assert(old);
            assert.equal((await rpc(old, 'flush')).status, 403);
            assert.equal((await operation(old)).status, 403);
            assert.equal(await sdk(old), '16');
            const empty = await b(second + '/diff');
            assert.equal(empty.status, 200);
            assert.equal(empty.text, '');
            const original = await a(first + '/diff');
            assert.equal(original.type, 'text/plain; charset=utf-8');
            assert.match(original.text, /\+line one/);
            const next = await submit(a, pa, 'line two', 'next');
            await until(
                () => a(next),
                (r) => r.json().status === 'succeeded',
                'next generation succeeded',
            );
            const fourth = trace[3];
            assert(fourth && fourth.grant.generation > old.grant.generation);
            assert.equal(fourth.grant.session, old.grant.session);
            assert.equal((await rpc(old, 'append')).status, 403);
            const newer = (await a(next + '/diff')).text;
            assert.match(newer, /\+line two/);
            assert.doesNotMatch(newer, /\+line one/);
            assert.equal((await a(first + '/diff')).text, original.text);

            await service.close();
            service = await start(state, host);
            const restarted = client(service.url);
            const retry = await restarted(
                pa + '/runs',
                'POST',
                { prompt: 'line one' },
                'same',
            );
            assert.equal(retry.status, 200);
            assert.equal(retry.json().status, 'succeeded');
            assert.equal(
                (await restarted(first + '/diff')).text,
                original.text,
            );
            assert.equal(trace.length, 4);
        } finally {
            release.resolve();
            await service.close();
            await rm(state, { recursive: true, force: true });
        }
    });

    test('worker exits after an fsynced effect, controller is killed, recovery fences without replay', async () => {
        const state = await mkdtemp(join(tmpdir(), 'bento-recovery-test-'));
        const controller = spawn(
            process.execPath,
            [...process.execArgv, testFile, '--crash-controller', state],
            { stdio: ['ignore', 'pipe', 'ignore'] },
        );
        const exited = new Promise<void>((resolve) =>
            controller.once('close', () => resolve()),
        );
        let service: Awaited<ReturnType<typeof start>> | undefined;
        try {
            const lines = createInterface({ input: controller.stdout });
            const [url] = await lines[Symbol.asyncIterator]()
                .next()
                .then(({ value }) => [value as string]);
            assert(url);
            const api = client(url);
            const pa = await project(api);
            const queuedApi = client(url, 'queued-account');
            const queuedProject = await project(queuedApi);
            const run = await submit(api, pa, 'change once', 'crash');
            await until(
                () =>
                    readFile(join(state, 'stop-observed')).then(
                        () => true,
                        () => false,
                    ),
                Boolean,
                'stop dispatched',
            );
            assert.equal((await api(run)).json().status, 'recovering');
            const queuedRun = await submit(
                queuedApi,
                queuedProject,
                'noop',
                'queued',
            );
            assert.equal((await queuedApi(queuedRun)).json().status, 'queued');
            const { request: old, key } = JSON.parse(
                await readFile(join(state, 'old-grant.json'), 'utf8'),
            ) as { request: WorkerRequest; key: string };
            for (const method of ['open', 'append', 'flush', 'close'])
                assert.equal((await rpc(old, method, { key })).status, 403);
            assert.equal((await operation(old)).status, 403);
            assert.equal(await sdk(old), '16');
            controller.kill('SIGKILL');
            await exited;

            const base = localHost(join(state, 'volume'));
            const recoveries: WorkerRequest[] = [];
            service = await start(state, {
                ...base,
                sdk: fixtureSdk,
                async worker(request, signal) {
                    if (request.binding.tenant === 'queued-account')
                        return base.worker(request, signal);
                    recoveries.push(request);
                    assert.equal(request.mode, 'recover');
                    assert.equal(request.prompt, undefined);
                    assert.equal((await operation(request)).status, 403);
                    assert.equal(await sdk(request), '16');
                    return base.worker(request, signal);
                },
            });
            const restarted = client(service.url);
            const reviewed = await until(
                () => restarted(run),
                (r) => r.json().status === 'needs_review',
                'review after takeover',
            );
            assert.match(reviewed.text, /outcome is unknown/);
            const blockedDeletion = await restarted(
                pa,
                'DELETE',
                undefined,
                randomUUID(),
            );
            assert.equal(blockedDeletion.status, 409);
            assert.match(blockedDeletion.text, /project_busy/);
            await until(
                () => client(service!.url, 'queued-account')(queuedRun),
                (r) => r.json().status === 'succeeded',
                'persisted queue resumes after restart',
            );
            assert.equal(recoveries.length, 1);
            const [next] = recoveries;
            assert(next);
            assert.equal(next.grant.generation, old.grant.generation + 1);
            const stale = { ...next, grant: old.grant };
            assert.equal((await rpc(stale, 'append', { key })).status, 403);
            assert.equal((await operation(stale)).status, 403);
            assert.equal(await sdk(stale), '16');
            assert.equal((await restarted(run + '/diff')).status, 409);
            assert.equal(
                (
                    await restarted(
                        pa + '/runs',
                        'POST',
                        { prompt: 'change once' },
                        'crash',
                    )
                ).status,
                200,
            );
            assert.equal(
                (
                    await restarted(
                        pa + '/runs',
                        'POST',
                        { prompt: 'new' },
                        'new',
                    )
                ).status,
                409,
            );
            assert.deepEqual(await base.snapshot(old.binding), [
                { path: 'README.md', text: '# Fixture\nonce\n' },
            ]);
            const proof = {
                runId: old.grant.run,
                failedGeneration: old.grant.generation,
                readyGeneration: next.grant.generation + 1,
                stableOperationId: 'fault-effect',
                expectedSnapshotSha256: snapshotSha256([
                    { path: 'README.md', text: '# Fixture\nonce\n' },
                ]),
            };
            assert.equal(
                (await restarted(run + '/review', 'POST', proof)).status,
                404,
            );
            await assert.rejects(
                service.reviewRun({
                    ...proof,
                    readyGeneration: proof.readyGeneration + 1,
                }),
                /not awaiting/,
            );
            await assert.rejects(
                service.reviewRun({
                    ...proof,
                    expectedSnapshotSha256: '0'.repeat(64),
                }),
                /does not match/,
            );
            await Promise.all([
                service.reviewRun(proof),
                service.reviewRun(proof),
            ]);
            const patch = await restarted(run + '/diff');
            assert.equal(patch.status, 200);
            assert.equal(patch.text.match(/^\+once$/gm)?.length, 1);
            await assert.rejects(
                service.reviewRun({
                    ...proof,
                    expectedSnapshotSha256: '0'.repeat(64),
                }),
                /different review/,
            );
            const ledger = new DatabaseSync(join(state, 'authority.sqlite'), {
                readOnly: true,
            });
            try {
                assert.deepEqual(
                    ledger
                        .prepare('SELECT state FROM operations')
                        .all()
                        .map((row) => row.state),
                    ['UNKNOWN'],
                );
            } finally {
                ledger.close();
            }
            assert.equal(
                (await restarted(pa, 'DELETE', undefined, randomUUID())).status,
                204,
            );
            assert.equal((await restarted(run)).status, 404);
            assert.equal((await restarted(run + '/diff')).status, 404);
        } finally {
            controller.kill('SIGKILL');
            await exited;
            await service?.close();
            await rm(state, { recursive: true, force: true });
        }
    });

    test('attempted recovery without a recovered receipt cannot publish a verified diff', async () => {
        const state = await mkdtemp(
            join(tmpdir(), 'bento-unconfirmed-recovery-'),
        );
        const base = localHost(join(state, 'volume'));
        const service = await start(state, {
            ...base,
            async worker(request, signal) {
                if (request.mode === 'recover') return 'completed';
                await base.worker(request, signal);
                return 'review';
            },
        });
        try {
            const api = client(service.url);
            const path = await project(api);
            const run = await submit(api, path, 'once', 'unconfirmed');
            const pending = await until(
                () => api(run),
                (r) => r.json().status === 'needs_review',
                'unconfirmed recovery',
            );
            await assert.rejects(
                service.reviewRun({
                    runId: pending.json().id,
                    failedGeneration: 1,
                    readyGeneration: 3,
                    stableOperationId: 'local-demo',
                    expectedSnapshotSha256: snapshotSha256([
                        { path: 'README.md', text: '# Fixture\nonce\n' },
                    ]),
                }),
                /not awaiting/,
            );
            assert.equal((await api(run + '/diff')).status, 409);
        } finally {
            await service.close();
            await rm(state, { recursive: true, force: true });
        }
    });

    test('takeover before history creation and fail-closed on stale epoch or SQLite failure', async () => {
        const state = await mkdtemp(join(tmpdir(), 'bento-empty-history-'));
        const base = localHost(join(state, 'volume'));
        const binding = {
            tenant: 'a',
            project: 'p',
            session: 's',
            sandbox: 'box',
            volume: 'volume',
        };
        const history = join(state, 'history.sqlite');
        const control = new SingleHostExecution(
            { authority: join(state, 'authority.sqlite'), history },
            base,
        );
        const server = control.persistenceIngress();
        const fence = new PersistenceFence(history);
        try {
            await new Promise<void>((resolve) =>
                server.listen(0, '127.0.0.1', resolve),
            );
            const address = server.address();
            assert(address && typeof address !== 'string');
            const persistenceUrl = 'http://127.0.0.1:' + address.port;
            control.bind(binding, await base.provision(binding, []));
            const first = control.admit(binding.session, 1, 'first', 5000);
            await control.takeover(binding.session, 1);
            const second = control.admit(binding.session, 2, 'second', 5000);
            const prior = {
                mode: 'execute' as const,
                binding,
                grant: first,
                persistenceUrl,
                operationUrl: '',
            };
            const header = {
                id: binding.session,
                version: 4,
                createdAt: Date.now(),
                isSeeded: false,
            };
            assert.equal((await rpc(prior, 'create', { header })).status, 403);
            const response = await rpc({ ...prior, grant: second }, 'create', {
                header,
            });
            assert.equal(response.status, 200);
            assert.equal(((await response.json()) as { ok: boolean }).ok, true);
            assert.throws(
                () => fence.revoke(binding.session, 1, 'first'),
                /CAS denied/,
            );
            assert.throws(
                () => fence.grant(binding.session, 3, 'wrong'),
                /CAS denied/,
            );
            assert.equal(fence.isRevoked(binding.session, 1), false);
            const db = new DatabaseSync(history);
            try {
                db.exec('ALTER TABLE sessions RENAME TO unavailable');
                assert.throws(
                    () => fence.revoke(binding.session, 2, 'second'),
                    /no such table/,
                );
                assert.throws(
                    () => fence.grant(binding.session, 2, 'second'),
                    /no such table/,
                );
                assert.throws(
                    () => fence.isRevoked(binding.session, 2),
                    /no such table/,
                );
            } finally {
                db.close();
            }
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            fence.close();
            control.close();
            await rm(state, { recursive: true, force: true });
        }
    });
}

test('Task input, Run, and source deletion share a durable transaction boundary', async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'bento-task-store-'));
    const path = join(folder, 'business.sqlite');
    let store = new Store(path, 1);
    t.after(async () => {
        store.close();
        await rm(folder, { recursive: true, force: true });
    });
    const owner = 'account-a';
    const taskId = randomUUID();
    const spaceId = randomUUID();
    const fileId = randomUUID();
    const creationKey = randomUUID();
    const runKey = randomUUID();
    const fileHold = randomUUID();
    const deletion = randomUUID();
    const input = {
        id: taskId,
        name: 'Text task',
        sourceSpaceId: spaceId,
        inputFiles: readme,
        inputManifest: [
            {
                fileId,
                path: readme[0]!.path,
                bytes: Buffer.byteLength(readme[0]!.text),
                sha256: createHash('sha256')
                    .update(readme[0]!.text)
                    .digest('hex'),
            },
        ],
        inputDigest: snapshotSha256(readme),
    };
    const version = 'sha256:' + 'a'.repeat(64);
    assert.equal(
        store.createTask(owner, creationKey, input, version).task.id,
        taskId,
    );
    assert.equal(
        store.createTask(owner, creationKey, input, version).replay,
        true,
    );
    assert.throws(
        () =>
            store.createTask(
                owner,
                creationKey,
                { ...input, name: 'Other' },
                version,
            ),
        { code: 'idempotency_conflict' },
    );
    assert.throws(() => store.task('account-b', taskId), { status: 404 });
    assert.throws(() => store.project(owner, taskId), { status: 404 });
    assert.deepEqual(store.projects(owner), []);
    assert.throws(() => store.addRun(owner, taskId, runKey, 'Legacy access'), {
        status: 404,
    });
    store.importResult(taskId, 'ready');

    assert.equal(
        store.acquireTaskInputDeleteHold(owner, spaceId, fileId, fileHold, null)
            .state,
        'held',
    );
    assert.throws(() => store.enqueueTaskRun(owner, taskId, runKey, 'First'), {
        code: 'project_busy',
    });
    assert.equal(
        store.changeTaskSourceDeletion(owner, spaceId, deletion, null, 'hold')
            .state,
        'denied',
    );
    store.close();
    store = new Store(path, 1);
    assert.equal(
        store.releaseTaskInputDeleteHold(owner, spaceId, fileId, fileHold, null)
            .state,
        'released',
    );
    assert.equal(
        store.acquireTaskInputDeleteHold(owner, spaceId, fileId, fileHold, null)
            .state,
        'released',
    );
    const sourceFirst = randomUUID();
    assert.equal(
        store.changeTaskSourceDeletion(
            owner,
            spaceId,
            sourceFirst,
            null,
            'hold',
        ).state,
        'held',
    );
    assert.equal(
        store.acquireTaskInputDeleteHold(
            owner,
            spaceId,
            fileId,
            randomUUID(),
            null,
        ).state,
        'denied',
    );
    assert.equal(
        store.changeTaskSourceDeletion(
            owner,
            spaceId,
            sourceFirst,
            null,
            'release',
        ).state,
        'released',
    );

    const run = store.enqueueTaskRun(owner, taskId, runKey, 'First').run;
    assert.equal(
        store.enqueueTaskRun(owner, taskId, runKey, 'First').run.id,
        run.id,
    );
    assert.throws(
        () => store.enqueueTaskRun(owner, taskId, runKey, 'Different'),
        { code: 'idempotency_conflict' },
    );
    assert.throws(
        () => store.enqueueTaskRun(owner, taskId, randomUUID(), 'Next'),
        { code: 'task_busy' },
    );
    assert.deepEqual(
        store.taskEvents(owner, taskId, 0).map((e) => [e.id, e.sequence]),
        [[run.id + ':user', 1]],
    );
    assert.equal(
        store.acquireTaskInputDeleteHold(
            owner,
            spaceId,
            fileId,
            randomUUID(),
            null,
        ).state,
        'denied',
    );
    assert.equal(store.start(run.id, readme, 1), true);
    const result = {
        baselineSha256: input.inputDigest,
        initialSha256: input.inputDigest,
        afterSha256: input.inputDigest,
        incremental: '',
        cumulative: '',
    };
    const first = store.publishTaskResult(run.id, result);
    assert.deepEqual(store.publishTaskResult(run.id, result), first);
    assert.throws(
        () =>
            store.publishTaskResult(run.id, {
                ...result,
                cumulative: 'changed',
            }),
        /Conflicting Task result/,
    );
    const zeroFileId = randomUUID();
    const zeroHoldId = randomUUID();
    assert.equal(
        store.acquireTaskInputDeleteHold(
            owner,
            spaceId,
            zeroFileId,
            zeroHoldId,
            null,
        ).state,
        'held',
    );
    store.drainOwner(owner);
    store.close();
    store = new Store(path, 1);
    assert.equal(
        store.acquireTaskInputDeleteHold(
            owner,
            spaceId,
            zeroFileId,
            zeroHoldId,
            null,
        ).state,
        'held',
    );
    assert.equal(
        store.releaseTaskInputDeleteHold(
            owner,
            spaceId,
            zeroFileId,
            zeroHoldId,
            null,
        ).state,
        'released',
    );
    assert.deepEqual(store.publishTaskResult(run.id, result), first);
    assert.equal(store.ownerDrained(owner), true);
});

test('settled retry receipts release the attempt reservation and preserve closure evidence', async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'bento-task-retry-'));
    const path = join(folder, 'business.sqlite');
    let store = new Store(path, 1);
    t.after(async () => {
        store.close();
        await rm(folder, { recursive: true, force: true });
    });
    const owner = 'retry-owner';
    const sourceSpaceId = randomUUID();
    const input = {
        id: randomUUID(),
        name: 'Retry task',
        sourceSpaceId,
        inputFiles: readme,
        inputManifest: [
            {
                fileId: randomUUID(),
                path: readme[0]!.path,
                bytes: Buffer.byteLength(readme[0]!.text),
                sha256: createHash('sha256')
                    .update(readme[0]!.text)
                    .digest('hex'),
            },
        ],
        inputDigest: snapshotSha256(readme),
    };
    const evidence = {
        oldGeneration: 1,
        newGeneration: 2,
        workspaceSha256: input.inputDigest,
        historySha256: input.inputDigest,
    };
    const taskId = store.createTask(owner, randomUUID(), input, 'environment-a')
        .task.id;
    store.importResult(taskId, 'ready');
    const first = store.enqueueTaskRun(
        owner,
        taskId,
        randomUUID(),
        'First',
    ).run;
    store.status(first.id, 'failed', 'Failed.');
    store.recordStopProof(first.id, '{}');
    const retryKey = randomUUID();
    const attempt = store.acceptTaskRetry(
        owner,
        taskId,
        first.id,
        retryKey,
        evidence,
    ).attempt;
    const legacy = store.addProject(owner, 'Legacy', []);
    store.importResult(legacy.id, 'ready');
    assert.throws(() => store.addRun(owner, legacy.id, randomUUID(), 'Try'), {
        code: 'tenant_queue_full',
    });
    assert.equal(
        store.advanceTaskRetry(attempt.id, 'preparing', 'workspace_restored'),
        true,
    );
    assert.equal(
        store.advanceTaskRetry(attempt.id, 'workspace_restored', 'blocked'),
        true,
    );
    store.close();
    store = new Store(path, 1);
    assert.equal(
        store.taskRetry(attempt.id).lastConfirmedPhase,
        'workspace_restored',
    );
    assert.equal(store.ownerDrained(owner), false);
    const next = store.finalizeTaskRetry(attempt.id, 'blocked');
    assert.equal(next.retryOf, first.id);
    assert.equal(
        store.acceptTaskRetry(owner, taskId, first.id, retryKey, evidence)
            .attempt.phase,
        'queued',
    );
    assert.equal(store.ownerDrained(owner), false);
    store.status(next.id, 'failed', 'Failed again.');
    assert.equal(store.ownerDrained(owner), true);
    const deletion = randomUUID();
    assert.equal(
        store.changeTaskSourceDeletion(
            owner,
            sourceSpaceId,
            deletion,
            null,
            'hold',
        ).state,
        'held',
    );
    assert.equal(
        store.changeTaskSourceDeletion(
            owner,
            sourceSpaceId,
            deletion,
            null,
            'release',
        ).state,
        'released',
    );
    store.recordStopProof(next.id, '{}');
    const blocked = store.acceptTaskRetry(
        owner,
        taskId,
        next.id,
        randomUUID(),
        evidence,
    ).attempt;
    assert.equal(
        store.advanceTaskRetry(blocked.id, 'preparing', 'blocked'),
        true,
    );
    assert.equal(store.ownerDrained(owner), false);
    assert.equal(
        store.closeBlockedTaskRetry(blocked.id, 2, 'evidence')?.evidenceDigest,
        'evidence',
    );
    assert.equal(store.taskRetry(blocked.id).phase, 'closed');
    assert.equal(store.ownerDrained(owner), true);
    assert.throws(
        () => store.enqueueTaskRun(owner, taskId, randomUUID(), 'Closed'),
        { code: 'task_not_ready' },
    );
    const cleanup = randomUUID();
    assert.equal(
        store.changeTaskSourceDeletion(
            owner,
            sourceSpaceId,
            cleanup,
            null,
            'hold',
        ).state,
        'held',
    );
    assert.equal(
        store.changeTaskSourceDeletion(
            owner,
            sourceSpaceId,
            cleanup,
            null,
            'commit',
        ).state,
        'committing',
    );
    store.close();
    store = new Store(path, 1);
    const bindings = store.taskSourceDeletionBindings(
        owner,
        sourceSpaceId,
        cleanup,
    );
    assert.deepEqual(bindings, [store.binding(next)]);
    store.purgeProject(bindings[0]!, cleanup, sourceSpaceId);
    assert.equal(
        store.finishTaskSourceDeletion(owner, sourceSpaceId, cleanup),
        true,
    );
    assert.equal(
        store.finishTaskSourceDeletion(owner, sourceSpaceId, randomUUID()),
        false,
    );
    assert.throws(
        () =>
            store.acquireTaskInputDeleteHold(
                owner,
                sourceSpaceId,
                randomUUID(),
                randomUUID(),
                null,
            ),
        { status: 404 },
    );
    assert.equal(
        store.changeTaskSourceDeletion(
            owner,
            sourceSpaceId,
            cleanup,
            null,
            'hold',
        ).state,
        'deleted',
    );
    assert.equal(
        store.readTaskRetryClosure(blocked.id)?.evidenceDigest,
        'evidence',
    );
    assert.throws(() => store.task(owner, taskId), { status: 404 });
});

test('startup requires the trusted host environment version', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'bento-task-start-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const { BENTO_EXECUTION_ENVIRONMENT_VERSION: _version, ...env } =
        process.env;
    void _version;
    for (const version of [undefined, 'sha256:' + 'f'.repeat(64)]) {
        const state = join(directory, version ? 'mismatch' : 'missing');
        const child = spawn(
            process.execPath,
            [
                ...process.execArgv,
                fileURLToPath(new URL('./start.ts', import.meta.url)),
                '--local',
            ],
            {
                env: {
                    ...env,
                    BENTO_STATE_DIR: state,
                    BENTO_SERVICE_BEARER: testToken,
                    ...(version
                        ? { BENTO_EXECUTION_ENVIRONMENT_VERSION: version }
                        : {}),
                },
                stdio: 'ignore',
            },
        );
        assert.deepEqual(await once(child, 'close'), [1, null]);
        await assert.rejects(readFile(join(state, 'business.sqlite')), {
            code: 'ENOENT',
        });
    }
});

test('command host requests the frozen environment and exposes no fixture recovery', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'bento-command-version-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const protobuf = join(directory, 'node_modules', '@bufbuild', 'protobuf');
    await mkdir(protobuf, { recursive: true });
    await writeFile(
        join(protobuf, 'index.js'),
        'module.exports = { fromBinary() {} };',
    );
    await writeFile(join(directory, 'raw.mjs'), 'export {};');
    await writeFile(join(directory, 'local-material'), 'fixture');
    const control = join(directory, 'control.cjs');
    await writeFile(
        control,
        `
        let json = '';
        process.stdin.on('data', chunk => json += chunk);
        process.stdin.on('end', () => {
            const {action,binding,environmentVersion} = JSON.parse(json);
            if (action !== 'provisionTask') process.exit(1);
            process.stdout.write(JSON.stringify({
                sandbox:binding.sandbox,volume:binding.volume,running:true,installed:true,
                environmentVersion:environmentVersion === 'bad' ? 'other' : environmentVersion,
            }));
        });
    `,
    );
    const configPath = join(directory, 'host.json');
    const settings = {
        imageDigest: 'sha256:' + '0'.repeat(64),
        policyDigest: 'sha256:' + '1'.repeat(64),
        gateway: 'https://fixture.invalid',
        workspace: 'workspace',
        ca: 'local-material',
        cert: 'local-material',
        key: 'local-material',
        sdkRaw: 'raw.mjs',
        control: { command: process.execPath, args: [control] },
        worker: { command: process.execPath, args: [control] },
    };
    await writeFile(
        configPath,
        JSON.stringify({ ...settings, imageDigest: 'invalid' }),
    );
    await assert.rejects(
        commandHost(configPath),
        /Invalid execution environment identity/,
    );
    await writeFile(configPath, JSON.stringify(settings));
    const host = await commandHost(configPath);
    assert.equal(host.environmentVersion, localEnvironmentVersion);
    assert.equal(host.taskRecovery, undefined);
    assert.equal(host.observeWorkerExit, undefined);
    const binding = {
        tenant: 'tenant',
        project: randomUUID(),
        session: randomUUID(),
        sandbox: 'sandbox',
        volume: 'volume',
    };
    const frozen = 'sha256:' + 'e'.repeat(64);
    assert.equal(
        (await host.provisionTask(binding, [], frozen)).environmentVersion,
        frozen,
    );
    await assert.rejects(
        host.provisionTask(binding, [], 'bad'),
        /observation mismatch/,
    );
});

test('fixture recovery journals a verified volume and refuses overlap with an active writer', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'bento-task-host-'));
    const server = createServer(async (req, res) => {
        for await (const chunk of req) void chunk;
        if (req.url === '/operations') {
            res.writeHead(201).end();
            return;
        }
        res.end(JSON.stringify({ ok: true, value: { key: 'fixture' } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        server.close();
        server.closeAllConnections();
        await rm(directory, { recursive: true, force: true });
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}`;
    const binding = {
        tenant: 'tenant',
        project: randomUUID(),
        session: randomUUID(),
        sandbox: 'sandbox',
        volume: 'volume',
    };
    let host = localHost(directory);
    await host.provisionTask(binding, readme, host.environmentVersion);
    const grant = (generation: number) => ({
        run: randomUUID(),
        session: binding.session,
        generation,
        token: 'fixture',
    });
    const request = (generation: number): WorkerRequest => ({
        mode: 'execute',
        binding,
        grant: grant(generation),
        persistenceUrl: url,
        operationUrl: url,
        prompt: 'edited',
    });
    const preWrite = request(1);
    await assert.rejects(host.worker(preWrite, AbortSignal.abort()));
    assert.equal(
        await host.taskRecovery!.readFixtureWriteReceipt!(
            binding,
            preWrite.grant.run,
            1,
        ),
        null,
    );
    assert.deepEqual(await host.snapshot(binding), readme);

    const writes = join(directory, binding.project, 'writes');
    await writeFile(writes, 'block receipt directory');
    const unknown = request(2);
    await assert.rejects(host.worker(unknown, new AbortController().signal));
    await rm(writes);
    assert.equal(
        await host.taskRecovery!.readFixtureWriteReceipt!(
            binding,
            unknown.grant.run,
            2,
        ),
        null,
    );
    assert.match((await host.snapshot(binding))[0]!.text, /edited\n$/);

    const run = request(3);
    const attemptId = randomUUID();
    const digest = snapshotSha256(readme);
    const marker = join(directory, binding.project, 'running');
    const beforeFailedStop = await host.snapshot(binding);
    await rm(marker);
    await mkdir(marker);
    await assert.rejects(
        host.taskRecovery!.restoreTask(binding, attemptId, readme, digest),
    );
    assert.deepEqual(await host.snapshot(binding), beforeFailedStop);
    assert.equal(
        await host.taskRecovery!.queryRestore(binding, attemptId),
        null,
    );
    await rm(marker, { recursive: true });
    await host.provisionTask(binding, readme, host.environmentVersion);
    const execution = host.worker(run, new AbortController().signal);
    await assert.rejects(
        host.taskRecovery!.restoreTask(binding, attemptId, readme, digest),
        /active writer/,
    );
    assert.equal(await execution, 'completed');
    const receipt = await host.taskRecovery!.readFixtureWriteReceipt!(
        binding,
        run.grant.run,
        3,
    );
    assert(receipt);
    assert.equal(
        receipt.fileSha256,
        createHash('sha256')
            .update((await host.snapshot(binding))[0]!.text)
            .digest('hex'),
    );
    host = localHost(directory);
    assert.deepEqual(
        await host.taskRecovery!.readFixtureWriteReceipt!(
            binding,
            run.grant.run,
            3,
        ),
        receipt,
    );
    assert(await host.observeWorkerExit!(binding, run.grant.run, 3));
    await assert.rejects(
        host.taskRecovery!.restoreTask(
            binding,
            attemptId,
            readme,
            'f'.repeat(64),
        ),
        /input digest/,
    );
    assert.deepEqual(
        await host.taskRecovery!.restoreTask(
            binding,
            attemptId,
            readme,
            digest,
        ),
        { attemptId, sha256: digest },
    );
    host = localHost(directory);
    assert.deepEqual(
        await host.taskRecovery!.queryRestore(binding, attemptId),
        { attemptId, phase: 'ready', sha256: digest },
    );
    assert.deepEqual(
        await host.taskRecovery!.restoreTask(
            binding,
            attemptId,
            readme,
            digest,
        ),
        { attemptId, sha256: digest },
    );
    assert.deepEqual(await host.snapshot(binding), readme);
});

test('prepared restore validates staging before changing the published pointer', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'bento-task-stage-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const binding = {
        tenant: 'tenant',
        project: randomUUID(),
        session: randomUUID(),
        sandbox: 'sandbox',
        volume: 'volume',
    };
    const host = localHost(directory);
    await host.provisionTask(binding, readme, host.environmentVersion);
    const root = join(directory, binding.project);
    const pointer = join(root, 'task-volume');
    const previousVolume = await readlink(pointer);
    const attemptId = randomUUID();
    const stagedVolume = 'volume-' + attemptId;
    await mkdir(join(root, stagedVolume));
    await writeFile(join(root, stagedVolume, 'README.md'), 'damaged staging');
    await mkdir(join(root, 'restores'));
    const sha256 = snapshotSha256(readme);
    await writeFile(
        join(root, 'restores', attemptId + '.json'),
        JSON.stringify({
            attemptId,
            phase: 'prepared',
            sha256,
            bindingDigest: executionBindingDigest(binding),
            previousVolume,
            stagedVolume,
        }),
    );
    const restarted = localHost(directory);
    await assert.rejects(
        restarted.taskRecovery!.restoreTask(binding, attemptId, readme, sha256),
        (error: unknown) =>
            error instanceof TaskRestoreEvidenceConflict &&
            /staging differs/.test(error.message),
    );
    assert.equal(await readlink(pointer), previousVolume);
    assert.deepEqual(await restarted.snapshot(binding), readme);
    await rm(join(root, stagedVolume), { recursive: true });
    await assert.rejects(
        restarted.taskRecovery!.restoreTask(binding, attemptId, readme, sha256),
        TaskRestoreEvidenceConflict,
    );
    assert.equal(await readlink(pointer), previousVolume);
    assert.deepEqual(await restarted.snapshot(binding), readme);
});

function taskRetryTestClient(url: () => string) {
    return async (
        path: string,
        method = 'GET',
        body?: unknown,
        key?: string,
        owner = 'account-a',
    ) => {
        const response = await fetch(url() + '/v1' + path, {
            method,
            headers: {
                authorization: 'Bearer ' + testToken,
                'x-bento-owner-id': owner,
                ...(key ? { 'idempotency-key': key } : {}),
                ...(body === undefined
                    ? {}
                    : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(5000),
        });
        const text = await response.text();
        return {
            status: response.status,
            text,
            json: () => JSON.parse(text),
        };
    };
}

function taskRetryTestInput() {
    return {
        id: randomUUID(),
        name: 'Retry task',
        sourceSpaceId: randomUUID(),
        inputFiles: readme,
        inputManifest: [
            {
                fileId: randomUUID(),
                path: 'README.md',
                bytes: Buffer.byteLength(readme[0]!.text),
                sha256: createHash('sha256')
                    .update(readme[0]!.text)
                    .digest('hex'),
            },
        ],
        inputDigest: snapshotSha256(readme),
    };
}

test(
    'SDK evidence does not enable Task retry without trusted workspace recovery',
    { timeout: 15_000 },
    async (t) => {
        for (const tracking of [false, true]) {
            await t.test(
                tracking ? 'with decoder' : 'without decoder',
                async (t) => {
                    const state = await mkdtemp(
                        join(tmpdir(), 'bento-sdk-task-guard-'),
                    );
                    const root = join(state, 'volume');
                    const base = localHost(root);
                    const written = barrier();
                    let execution: WorkerRequest | undefined;
                    let stopCalls = 0;
                    let observations = 0;
                    let restores = 0;
                    const controller = await start(state, {
                        ...base,
                        sdk: {
                            ...fixtureSdk,
                            ...(tracking
                                ? {
                                      decodeExecEvent: () => ({
                                          kind: 'exit' as const,
                                          code: 0,
                                      }),
                                  }
                                : {}),
                        },
                        async stop(binding) {
                            stopCalls++;
                            await base.stop(binding);
                        },
                        async worker(request, signal, slot, onExit) {
                            const receipt = await base.worker(
                                request,
                                signal,
                                slot,
                                onExit,
                            );
                            if (request.mode !== 'execute') return receipt;
                            execution = request;
                            // Keep this scenario's operation ledger empty while the fixture volume changes.
                            await writeFile(
                                join(
                                    root,
                                    request.binding.project,
                                    'task-volume',
                                    'partial.txt',
                                ),
                                'partial',
                            );
                            written.resolve();
                            await delay(30_000, undefined, { signal });
                            return receipt;
                        },
                        taskRecovery: {
                            ...base.taskRecovery!,
                            async retryObservation() {
                                observations++;
                                return {
                                    unknownOperations: 0,
                                    workspaceOnly: true,
                                };
                            },
                            async restoreTask(...args) {
                                restores++;
                                return base.taskRecovery!.restoreTask(...args);
                            },
                        },
                    });
                    t.after(async () => {
                        await controller.close();
                        await rm(state, { recursive: true, force: true });
                    });
                    const api = taskRetryTestClient(() => controller.url);
                    const created = await api(
                        '/tasks',
                        'POST',
                        taskRetryTestInput(),
                        randomUUID(),
                    );
                    assert.equal(created.status, 202, created.text);
                    const path = '/tasks/' + created.json().task.id;
                    await until(
                        () => api(path),
                        (r) => r.json().task.status === 'ready',
                        'SDK Task ready',
                    );
                    const started = await api(
                        path + '/runs',
                        'POST',
                        { prompt: 'noop' },
                        randomUUID(),
                    );
                    assert.equal(started.status, 202, started.text);
                    const runId = started.json().run.id as string;
                    const run = path + '/runs/' + runId;
                    await written.promise;
                    assert(execution);
                    const cancelled = await api(run + '/cancel', 'POST');
                    assert.equal(cancelled.status, 200, cancelled.text);
                    const review = await until(
                        () => api(run),
                        (r) => r.json().run.status === 'needs_review',
                        'SDK stop requires review',
                    );
                    assert.equal(review.json().run.retryReason, 'needs_review');
                    assert.equal(review.json().run.canContinue, false);
                    const retry = await api(
                        run + '/retry',
                        'POST',
                        undefined,
                        randomUUID(),
                    );
                    assert.deepEqual(
                        [
                            retry.status,
                            retry.json().error.code,
                            retry.json().error.reason,
                        ],
                        [409, 'run_not_retryable', 'needs_review'],
                    );
                    const continuation = await api(
                        path + '/runs',
                        'POST',
                        { prompt: 'continue' },
                        randomUUID(),
                    );
                    assert.equal(continuation.status, 409, continuation.text);

                    const authority = new DatabaseSync(
                        join(state, 'authority.sqlite'),
                        { readOnly: true },
                    );
                    const business = new DatabaseSync(
                        join(state, 'business.sqlite'),
                        { readOnly: true },
                    );
                    try {
                        const current = authority
                            .prepare(
                                'SELECT generation,state,run,capability FROM execution_sessions WHERE session=?',
                            )
                            .get(execution.grant.session);
                        assert.deepEqual(
                            { ...current },
                            {
                                generation: execution.grant.generation + 1,
                                state: 'READY',
                                run: null,
                                capability: null,
                            },
                        );
                        assert.equal(
                            authority
                                .prepare(
                                    'SELECT count(*) AS count FROM operations',
                                )
                                .get()?.count,
                            0,
                        );
                        const exit = business
                            .prepare(
                                'SELECT bindingDigest FROM worker_exit WHERE runId=? AND generation=?',
                            )
                            .get(runId, execution.grant.generation);
                        assert.equal(
                            exit?.bindingDigest,
                            executionBindingDigest(execution.binding),
                        );
                        assert.equal(
                            business
                                .prepare(
                                    'SELECT count(*) AS count FROM stop_proofs',
                                )
                                .get()?.count,
                            0,
                        );
                        assert.equal(
                            business
                                .prepare(
                                    'SELECT count(*) AS count FROM retry_attempts',
                                )
                                .get()?.count,
                            0,
                        );
                    } finally {
                        authority.close();
                        business.close();
                    }
                    assert.equal(stopCalls, 1);
                    assert.equal(observations, 0);
                    assert.equal(restores, 0);
                    assert.deepEqual(await base.snapshot(execution.binding), [
                        ...readme,
                        { path: 'partial.txt', text: 'partial' },
                    ]);
                },
            );
        }
    },
);

test(
    'private Task HTTP preserves earlier results across a fenced retry',
    { timeout: 15_000 },
    async (t) => {
        const state = await mkdtemp(join(tmpdir(), 'bento-task-http-'));
        const host = localHost(join(state, 'volume'));
        let performed = 0;
        let initialRestoreCalls = 0;
        let binding: WorkerRequest['binding'] | undefined;
        const written = barrier();
        let controller = await start(state, {
            ...host,
            taskRecovery: {
                ...host.taskRecovery!,
                async restoreTask() {
                    initialRestoreCalls++;
                    throw new Error('Wait for restarted controller');
                },
            },
            async worker(request, signal, slot, onExit) {
                binding = request.binding;
                const result = await host.worker(request, signal, slot, onExit);
                if (request.prompt === 'second' && ++performed === 1) {
                    written.resolve();
                    await delay(30_000, undefined, { signal });
                }
                return result;
            },
        });
        t.after(async () => {
            await controller.close();
            await rm(state, { recursive: true, force: true });
        });
        const api = taskRetryTestClient(() => controller.url);
        const createKey = randomUUID();
        const input = taskRetryTestInput();
        const { sourceSpaceId } = input;
        const { fileId } = input.inputManifest[0]!;
        const create = await api('/tasks', 'POST', input, createKey);
        assert.equal(create.status, 202, create.text);
        const id = create.json().task.id;
        const path = '/tasks/' + id;
        assert.equal(
            (await api('/tasks', 'POST', input, createKey)).status,
            200,
        );
        await until(
            () => api(path),
            (r) => r.json().task.status === 'ready',
            'Task ready',
        );
        assert.equal(
            (await api(path, 'GET', undefined, undefined, 'other')).status,
            404,
        );
        const first = await api(
            path + '/runs',
            'POST',
            { prompt: 'first' },
            randomUUID(),
        );
        assert.equal(first.status, 202, first.text);
        const firstRun = path + '/runs/' + first.json().run.id;
        await until(
            () => api(firstRun),
            (r) => r.json().run.status === 'succeeded',
            'First Task result',
        );
        const diffPath = '/results/1/diff?view=cumulative';
        const firstDiff = await api(firstRun + diffPath);
        assert.equal(firstDiff.status, 200);
        assert.match(firstDiff.text, /\+first/);
        const second = await api(
            path + '/runs',
            'POST',
            { prompt: 'second' },
            randomUUID(),
        );
        assert.equal(second.status, 202, second.text);
        const secondId = second.json().run.id;
        const secondRun = path + '/runs/' + secondId;
        await written.promise;
        const holdPath =
            '/task-sources/' +
            sourceSpaceId +
            '/files/' +
            fileId +
            '/deletion-holds/' +
            randomUUID();
        assert.equal((await api(holdPath, 'POST')).json().state, 'denied');
        const cancel = await api(secondRun + '/cancel', 'POST');
        assert.equal(cancel.status, 200, cancel.text);
        const cancelled = await until(
            () => api(secondRun),
            (r) => ['cancelled', 'needs_review'].includes(r.json().run.status),
            'Stopped second Run',
        );
        assert.equal(cancelled.json().run.status, 'cancelled', cancelled.text);
        assert.equal(cancelled.json().run.retryReason, null);
        const dbPath = join(state, 'business.sqlite');
        const fault = new DatabaseSync(dbPath);
        const proof = fault
            .prepare(
                'SELECT canonicalJson,sha256 FROM stop_proofs WHERE runId=?',
            )
            .get(secondId);
        assert(proof && typeof proof.sha256 === 'string');
        fault
            .prepare("UPDATE stop_proofs SET sha256='invalid' WHERE runId=?")
            .run(secondId);
        const denied = await api(
            secondRun + '/retry',
            'POST',
            undefined,
            randomUUID(),
        );
        assert.equal(denied.status, 409, denied.text);
        assert.equal(initialRestoreCalls, 0);
        assert.equal(denied.json().error.code, 'run_not_retryable');
        assert.equal((await api(path + '/runs')).json().items.length, 2);
        assert.equal(typeof proof.canonicalJson, 'string');
        for (const change of [
            { taskId: randomUUID() },
            { bindingDigest: 'invalid' },
            { newGeneration: 42 },
        ]) {
            const changed = JSON.stringify({
                ...JSON.parse(proof.canonicalJson as string),
                ...change,
            });
            fault
                .prepare(
                    'UPDATE stop_proofs SET canonicalJson=?,sha256=? WHERE runId=?',
                )
                .run(
                    changed,
                    createHash('sha256').update(changed).digest('hex'),
                    secondId,
                );
            const response = await api(
                secondRun + '/retry',
                'POST',
                undefined,
                randomUUID(),
            );
            assert.deepEqual(
                [response.status, response.json().error.reason],
                [409, 'stop_unconfirmed'],
            );
            assert.equal(initialRestoreCalls, 0);
        }
        fault
            .prepare(
                'UPDATE stop_proofs SET canonicalJson=?,sha256=? WHERE runId=?',
            )
            .run(proof.canonicalJson as string, proof.sha256, secondId);
        const history = new DatabaseSync(join(state, 'history.sqlite'));
        t.after(() => history.close());
        const original = history
            .prepare('SELECT * FROM history_checkpoints WHERE runId=?')
            .get(secondId);
        assert(original);
        const removeCheckpoint = history.prepare(
            'DELETE FROM history_checkpoints WHERE runId=?',
        );
        const restoreCheckpoint = history.prepare(
            'INSERT INTO history_checkpoints VALUES (?,?,?,?,?)',
        );
        const replaceOriginalCheckpoint = () =>
            restoreCheckpoint.run(
                secondId,
                original.sessionId!,
                original.authorityGeneration!,
                original.body!,
                original.sha256!,
            );
        assert(binding);
        const workspaceBefore = snapshotSha256(await host.snapshot(binding));
        for (const faultType of ['missing', 'corrupt']) {
            if (faultType === 'missing') removeCheckpoint.run(secondId);
            else
                history
                    .prepare(
                        "UPDATE history_checkpoints SET body='{}' WHERE runId=?",
                    )
                    .run(secondId);

            assert.equal(
                (await api(secondRun)).json().run.retryReason,
                'checkpoint_unavailable',
            );
            const rejected = await api(
                secondRun + '/retry',
                'POST',
                undefined,
                randomUUID(),
            );
            assert.deepEqual(
                [
                    rejected.status,
                    rejected.json().error.code,
                    rejected.json().error.reason,
                ],
                [409, 'run_not_retryable', 'checkpoint_unavailable'],
            );
            assert.equal(
                fault
                    .prepare(
                        'SELECT id FROM retry_attempts WHERE sourceRunId=?',
                    )
                    .get(secondId),
                undefined,
            );
            assert.equal((await api(path + '/runs')).json().items.length, 2);
            assert.equal(
                snapshotSha256(await host.snapshot(binding)),
                workspaceBefore,
            );
            assert.equal(initialRestoreCalls, 0);
            removeCheckpoint.run(secondId);
            replaceOriginalCheckpoint();
        }
        fault.close();
        const retryKey = randomUUID();
        const retry = await api(
            secondRun + '/retry',
            'POST',
            undefined,
            retryKey,
        );
        assert.equal(retry.status, 202, retry.text);
        await controller.close();
        const reopened = localHost(join(state, 'volume'));
        let restoreCalls = 0;
        controller = await start(state, {
            ...reopened,
            taskRecovery: {
                ...reopened.taskRecovery!,
                async restoreTask(...args) {
                    restoreCalls++;
                    await reopened.taskRecovery!.restoreTask(...args);
                    throw new Error('Fixture lost its restore response');
                },
            },
        });
        const replay = await api(
            secondRun + '/retry',
            'POST',
            undefined,
            retryKey,
        );
        assert.equal(replay.status, 200, replay.text);
        assert.equal(replay.json().retry.runId, retry.json().retry.runId);
        const retried = path + '/runs/' + retry.json().retry.runId;
        await until(
            () => api(retried),
            (r) => r.status === 200 && r.json().run.status === 'succeeded',
            'Retried Task result',
        );
        const total = await api(retried + diffPath);
        assert.equal(total.status, 200, total.text);
        assert.match(total.text, /\+first/);
        assert.match(total.text, /\+second/);
        assert.equal(total.text.match(/\+second/g)?.length, 1);
        assert.equal(restoreCalls, 1);
        removeCheckpoint.run(secondId);
        const replayAfterLoss = await api(
            secondRun + '/retry',
            'POST',
            undefined,
            retryKey,
        );
        assert.equal(replayAfterLoss.status, 200, replayAfterLoss.text);
        assert.deepEqual(replayAfterLoss.json().retry, {
            ...retry.json().retry,
            state: 'queued',
        });
        assert.equal(restoreCalls, 1);
        replaceOriginalCheckpoint();
        assert.equal((await api(firstRun + diffPath)).text, firstDiff.text);
        const events = (await api(path + '/events')).json().items;
        assert.equal(events.length, 3);
        assert.equal(
            events.some((event: object) => 'key' in event),
            false,
        );
        const deletion = '/task-sources/' + sourceSpaceId;
        const operation = randomUUID();
        assert.equal(
            (
                await api(
                    deletion + '?phase=hold',
                    'DELETE',
                    undefined,
                    operation,
                )
            ).json().state,
            'held',
        );
        const afterHold =
            '/task-sources/' +
            sourceSpaceId +
            '/files/' +
            randomUUID() +
            '/deletion-holds/' +
            randomUUID();
        assert.equal((await api(afterHold, 'POST')).json().state, 'denied');
        assert.equal((await api('/account/drain', 'POST')).status, 204);
        assert.equal(
            (
                await api(
                    deletion + '?phase=commit',
                    'DELETE',
                    undefined,
                    operation,
                )
            ).status,
            204,
        );
        assert.equal((await api(path)).status, 404);
    },
);

test(
    'Task retry blocks when its history checkpoint disappears before workspace restore',
    { timeout: 20_000 },
    async (t) => {
        for (const fault of [
            'missing checkpoint',
            'corrupt session header',
        ] as const) {
            await t.test(fault, async (t) => {
                const state = await mkdtemp(
                    join(tmpdir(), 'bento-retry-history-'),
                );
                const base = localHost(join(state, 'volume'));
                let binding: WorkerRequest['binding'] | undefined;
                let queries = 0;
                let restoreCalls = 0;
                const controller = await start(state, {
                    ...base,
                    async worker(request, signal, slot, exit) {
                        const result = await base.worker(
                            request,
                            signal,
                            slot,
                            exit,
                        );
                        if (request.mode === 'execute') {
                            binding = request.binding;
                            // The fixture closes an empty draft without materializing it.
                            const created = await rpc(request, 'create', {
                                header: {
                                    id: request.grant.session,
                                    version: 4,
                                    createdAt: Date.now(),
                                    isSeeded: false,
                                },
                            });
                            assert.equal(created.status, 200);
                            const { key } = (await created.json()).value as {
                                key: string;
                            };
                            assert.equal(
                                (await rpc(request, 'flush', { key })).status,
                                200,
                            );
                            assert.equal(
                                (await rpc(request, 'close', { key })).status,
                                200,
                            );
                            return 'review';
                        }
                        return result;
                    },
                    taskRecovery: {
                        ...base.taskRecovery!,
                        async queryRestore(...args) {
                            if (++queries === 1) {
                                assert(binding && sourceRunId);
                                const history = new DatabaseSync(
                                    join(state, 'history.sqlite'),
                                );
                                try {
                                    const result =
                                        fault === 'missing checkpoint'
                                            ? history
                                                  .prepare(
                                                      'DELETE FROM history_checkpoints WHERE runId=?',
                                                  )
                                                  .run(sourceRunId)
                                            : history
                                                  .prepare(
                                                      "UPDATE sessions SET header='{' WHERE id=?",
                                                  )
                                                  .run(binding.session);
                                    assert.equal(result.changes, 1);
                                } finally {
                                    history.close();
                                }
                            }
                            return base.taskRecovery!.queryRestore(...args);
                        },
                        async restoreTask(...args) {
                            restoreCalls++;
                            return base.taskRecovery!.restoreTask(...args);
                        },
                    },
                });
                t.after(async () => {
                    await controller.close();
                    await rm(state, { recursive: true, force: true });
                });
                const api = taskRetryTestClient(() => controller.url);
                const created = await api(
                    '/tasks',
                    'POST',
                    taskRetryTestInput(),
                    randomUUID(),
                );
                assert.equal(created.status, 202, created.text);
                const taskPath = '/tasks/' + created.json().task.id;
                const runs = taskPath + '/runs';
                await until(
                    () => api(taskPath),
                    (r) => r.json().task.status === 'ready',
                    'Task ready',
                );
                const first = await api(
                    runs,
                    'POST',
                    { prompt: 'write before failing' },
                    randomUUID(),
                );
                assert.equal(first.status, 202, first.text);
                const sourceRunId = first.json().run.id as string;
                const runPath = runs + '/' + sourceRunId;
                const failed = await until(
                    () => api(runPath),
                    (r) => r.json().run.status === 'failed',
                    'Run failed safely',
                );
                assert.equal(failed.json().run.retryReason, null);
                assert(binding);
                const workspaceBefore = snapshotSha256(
                    await base.snapshot(binding),
                );
                const history = new DatabaseSync(
                    join(state, 'history.sqlite'),
                    { readOnly: true },
                );
                try {
                    assert.equal(
                        history
                            .prepare(
                                'SELECT body FROM history_checkpoints WHERE runId=?',
                            )
                            .get(sourceRunId)?.body,
                        '{"kind":"absent"}',
                    );
                } finally {
                    history.close();
                }

                const key = randomUUID();
                const retry = () =>
                    api(runPath + '/retry', 'POST', undefined, key);
                const accepted = await retry();
                assert.equal(accepted.status, 202, accepted.text);
                const blocked = await until(
                    retry,
                    (r) =>
                        r.status === 200 && r.json().retry.state === 'blocked',
                    'Retry blocked',
                );
                const attempt = accepted.json().retry;
                assert.deepEqual(blocked.json().retry, {
                    ...attempt,
                    state: 'blocked',
                });
                assert.equal(
                    (await api(runs + '/' + attempt.runId)).status,
                    404,
                );
                assert.deepEqual(
                    (await api(taskPath)).json().task.reconciliation,
                    {
                        attemptId: attempt.id,
                        state: 'blocked',
                        reason: 'restore_conflict',
                    },
                );
                const business = new DatabaseSync(
                    join(state, 'business.sqlite'),
                    { readOnly: true },
                );
                try {
                    assert.equal(
                        business
                            .prepare(
                                'SELECT lastConfirmedPhase FROM retry_attempts WHERE id=?',
                            )
                            .get(attempt.id)?.lastConfirmedPhase,
                        'preparing',
                    );
                } finally {
                    business.close();
                }
                assert.equal(queries, 1);
                assert.equal(restoreCalls, 0);
                assert.equal(
                    snapshotSha256(await base.snapshot(binding)),
                    workspaceBefore,
                );
            });
        }
    },
);

test(
    'Task operation reconciliation stays conservative across four controller crash boundaries',
    { timeout: 30_000 },
    async (t) => {
        for (const [fault, decision] of [
            ['before-write', 'failed'],
            ['before-receipt', 'failed'],
            ['before-receipt', 'unconfirmed'],
            ['before-authority', 'failed'],
            ['after-authority', 'failed'],
        ] as const) {
            const label =
                decision === 'unconfirmed' ? fault + ' unconfirmed' : fault;
            await t.test(label, async (t) => {
                const state = await mkdtemp(
                    join(tmpdir(), 'bento-task-crash-'),
                );
                const child = spawn(
                    process.execPath,
                    [
                        ...process.execArgv.filter(
                            (arg) => !arg.startsWith('--test-name-pattern='),
                        ),
                        '--test-name-pattern=^$',
                        testFile,
                        '--task-crash-controller',
                        state,
                        fault,
                    ],
                    { stdio: ['ignore', 'pipe', 'pipe'] },
                );
                const closed = once(child, 'close');
                const lines = createInterface({ input: child.stdout });
                const controllers: Awaited<ReturnType<typeof start>>[] = [];
                t.after(async () => {
                    child.kill('SIGKILL');
                    await closed;
                    lines.close();
                    for (const controller of controllers)
                        await controller.close();
                    await rm(state, { recursive: true, force: true });
                });
                const [address] = await Promise.race([
                    once(lines, 'line'),
                    closed.then(() => {
                        throw new Error('Fixture exited before listening');
                    }),
                ]);
                let root = address as string;
                async function call(
                    path: string,
                    method = 'GET',
                    body?: unknown,
                    key?: string,
                ) {
                    const res = await fetch(root + '/v1' + path, {
                        method,
                        headers: {
                            authorization: 'Bearer ' + testToken,
                            'x-bento-owner-id': 'account-a',
                            ...(key ? { 'idempotency-key': key } : {}),
                            ...(body === undefined
                                ? {}
                                : { 'content-type': 'application/json' }),
                        },
                        ...(body === undefined
                            ? {}
                            : { body: JSON.stringify(body) }),
                        signal: AbortSignal.timeout(5000),
                    });
                    return { status: res.status, body: await res.json() };
                }
                const created = await call(
                    '/tasks',
                    'POST',
                    {
                        id: null,
                        name: 'Task',
                        sourceSpaceId: null,
                        inputFiles: [],
                        inputManifest: [],
                        inputDigest: snapshotSha256([]),
                    },
                    randomUUID(),
                );
                assert.equal(created.status, 202);
                const id = created.body.task.id;
                const path = '/tasks/' + id;
                await until(
                    () => call(path),
                    (res) => res.body.task.status === 'ready',
                    'Fixture Task ready',
                );
                const submitted = await call(
                    path + '/runs',
                    'POST',
                    { prompt: 'append once' },
                    randomUUID(),
                );
                assert.equal(submitted.status, 202);
                const runId = submitted.body.run.id;
                const runPath = path + '/runs/' + runId;
                assert.deepEqual(await closed, [79, null]);
                const authority = new DatabaseSync(
                    join(state, 'authority.sqlite'),
                );
                const authoritativeOperation = () =>
                    authority.prepare('SELECT state FROM operations').get()
                        ?.state;
                assert.equal(
                    authoritativeOperation(),
                    fault === 'after-authority' ? 'SUCCEEDED' : 'UNKNOWN',
                );
                const business = new DatabaseSync(
                    join(state, 'business.sqlite'),
                );
                const host = localHost(join(state, 'volume'));
                const binds = new Store(join(state, 'business.sqlite'));
                const binding = binds.binding(binds.findRun(runId));
                binds.close();
                const outcome = await host.observeWorkerExit!(
                    binding,
                    runId,
                    1,
                );
                assert.equal(!!outcome, fault !== 'before-write');
                assert.equal(
                    business
                        .prepare('SELECT count(*) AS count FROM worker_exit')
                        .get()?.count,
                    fault === 'after-authority' ? 1 : 0,
                );
                assert.equal(
                    business
                        .prepare('SELECT count(*) AS count FROM stop_proofs')
                        .get()?.count,
                    0,
                );
                let allowCleanup = false;
                const service = await start(
                    state,
                    fault === 'before-authority'
                        ? {
                              ...host,
                              taskRecovery: {
                                  ...host.taskRecovery!,
                                  async queryRestore(_binding, attemptId) {
                                      return {
                                          attemptId,
                                          phase: 'ready',
                                          sha256: 'f'.repeat(64),
                                      };
                                  },
                              },
                              async observeRetryCleanup(...args) {
                                  return allowCleanup
                                      ? host.observeRetryCleanup!(...args)
                                      : null;
                              },
                          }
                        : host,
                );
                controllers.push(service);
                root = service.url;
                const safe =
                    fault === 'before-authority' || fault === 'after-authority';
                const final = await until(
                    () => call(runPath),
                    (res) =>
                        ['failed', 'needs_review'].includes(
                            res.body.run.status,
                        ),
                    'Recovered crash evidence',
                );
                assert.equal(
                    final.body.run.status,
                    safe ? 'failed' : 'needs_review',
                );
                assert.equal(
                    authoritativeOperation(),
                    safe ? 'SUCCEEDED' : 'UNKNOWN',
                );
                assert.equal(
                    business
                        .prepare('SELECT count(*) AS count FROM stop_proofs')
                        .get()?.count,
                    safe ? 1 : 0,
                );
                assert.equal(
                    (await host.snapshot(binding))[0]?.text,
                    fault === 'before-write' ? undefined : 'append once\n',
                );
                if (!safe) {
                    const retry = await call(
                        runPath + '/retry',
                        'POST',
                        undefined,
                        randomUUID(),
                    );
                    assert.deepEqual(
                        [
                            retry.status,
                            retry.body.error.code,
                            retry.body.error.reason,
                        ],
                        [409, 'run_not_retryable', 'needs_review'],
                    );
                    assert.equal(
                        business
                            .prepare(
                                'SELECT count(*) AS count FROM retry_attempts',
                            )
                            .get()?.count,
                        0,
                    );
                }
                if (fault === 'before-write') {
                    await assert.rejects(
                        service.closeTaskRun({
                            runId,
                            decision: 'unconfirmed',
                            expectedGeneration: 3,
                        }),
                        { code: 'review_unavailable' },
                    );
                }
                if (fault === 'before-receipt') {
                    const blocked = await call('/account/purge', 'POST');
                    assert.equal(blocked.status, 202);
                    assert.equal(blocked.body.complete, false);
                    assert.equal(
                        (await call(runPath)).body.run.status,
                        'needs_review',
                    );
                    assert.equal(
                        (await host.snapshot(binding))[0]?.text,
                        'append once\n',
                    );
                    assert.equal(service.readTaskClosure(runId), null);

                    const closure = { runId, decision, expectedGeneration: 3 };
                    await service.closeTaskRun(closure);
                    const closedRun = await call(runPath);
                    assert.equal(closedRun.body.run.status, 'failed');
                    if (decision === 'failed') {
                        assert.equal(
                            closedRun.body.run.retryReason,
                            'stop_unconfirmed',
                        );
                    } else {
                        assert.equal(
                            (await call(path)).body.task.closedReason,
                            'unconfirmed',
                        );
                        assert.equal(
                            (
                                await call(
                                    path + '/runs',
                                    'POST',
                                    { prompt: 'new write' },
                                    randomUUID(),
                                )
                            ).status,
                            409,
                        );
                    }
                    const audit = service.readTaskClosure(runId);
                    assert.ok(audit);
                    assert.equal(audit.runId, runId);
                    assert.equal(audit.decision, decision);
                    assert.equal(
                        audit.authorityGeneration,
                        closure.expectedGeneration,
                    );
                    assert.match(audit.stopDigest as string, /^[a-f0-9]{64}$/);
                    assert.ok(
                        Number.isFinite(Date.parse(audit.closedAt as string)),
                    );

                    await service.closeTaskRun(closure);
                    assert.deepEqual(service.readTaskClosure(runId), audit);
                    await assert.rejects(
                        service.closeTaskRun({
                            ...closure,
                            decision:
                                decision === 'failed'
                                    ? 'unconfirmed'
                                    : 'failed',
                        }),
                        { code: 'review_unavailable' },
                    );
                    await assert.rejects(
                        service.closeTaskRun({
                            ...closure,
                            expectedGeneration: 4,
                        }),
                        { code: 'review_unavailable' },
                    );

                    await service.close();
                    assert.equal(controllers.pop(), service);
                    const reopened = await start(
                        state,
                        localHost(join(state, 'volume')),
                    );
                    controllers.push(reopened);
                    root = reopened.url;
                    assert.deepEqual(reopened.readTaskClosure(runId), audit);
                    const purged = await call('/account/purge', 'POST');
                    assert.equal(purged.status, 200);
                    assert.equal(purged.body.complete, true);
                    assert.equal((await call(path)).status, 404);
                    assert.equal((await call(runPath)).status, 404);
                    await assert.rejects(
                        readdir(join(state, 'volume', binding.project)),
                        { code: 'ENOENT' },
                    );
                    assert.equal(
                        authority
                            .prepare(
                                'SELECT 1 FROM execution_sessions WHERE session=?',
                            )
                            .get(binding.session),
                        undefined,
                    );
                    const history = new DatabaseSync(
                        join(state, 'history.sqlite'),
                        { readOnly: true },
                    );
                    try {
                        assert.equal(
                            history
                                .prepare('SELECT 1 FROM sessions WHERE id=?')
                                .get(binding.session),
                            undefined,
                        );
                    } finally {
                        history.close();
                    }
                    assert.deepEqual(reopened.readTaskClosure(runId), audit);
                    const replay = await call('/account/purge', 'POST');
                    assert.equal(replay.status, 200);
                    assert.equal(replay.body.complete, true);
                }
                if (fault === 'before-authority') {
                    const key = randomUUID();
                    const accepted = await call(
                        runPath + '/retry',
                        'POST',
                        undefined,
                        key,
                    );
                    assert.equal(accepted.status, 202);
                    const attemptId = accepted.body.retry.id;
                    await until(
                        () => call(runPath + '/retry', 'POST', undefined, key),
                        (res) => res.body.retry?.state === 'blocked',
                        'Rejected recovery observation',
                    );
                    assert.equal(
                        (await call('/account/purge', 'POST')).body.complete,
                        false,
                    );
                    assert.equal(
                        await service.reconcileTaskRetry({
                            attemptId,
                            expectedGeneration: 2,
                        }),
                        'pending',
                    );
                    await assert.rejects(
                        service.closeTaskRetry({
                            attemptId,
                            expectedGeneration: 2,
                        }),
                        { code: 'review_unavailable' },
                    );
                    assert.equal(service.readTaskRetryClosure(attemptId), null);
                    allowCleanup = true;
                    await service.closeTaskRetry({
                        attemptId,
                        expectedGeneration: 2,
                    });
                    assert.equal(
                        (await call(runPath + '/retry', 'POST', undefined, key))
                            .body.retry.state,
                        'closed',
                    );
                    assert.equal(
                        (await call(path)).body.task.closedReason,
                        'unconfirmed',
                    );
                    assert.equal(
                        (await call('/account/purge', 'POST')).body.complete,
                        true,
                    );
                    assert.equal(
                        service.readTaskRetryClosure(attemptId)
                            ?.authorityGeneration,
                        2,
                    );
                }
                authority.close();
                business.close();
            });
        }
    },
);

test('startup registers the six trusted review callbacks only in process', async (t) => {
    const state = await mkdtemp(join(tmpdir(), 'bento-task-review-module-'));
    const module = join(state, 'review.mjs');
    const marker = join(state, 'review-callbacks');
    await writeFile(
        module,
        `
        import { writeFile } from 'node:fs/promises';
        export default function install(...callbacks) {
            const types = callbacks.map(callback => typeof callback);
            if (callbacks[2]('missing') !== null || callbacks[4]('missing') !== null)
                throw new Error('Unexpected audit receipt');
            return () => writeFile(process.env.BENTO_TEST_REVIEW_RESULT,JSON.stringify(types));
        }
    `,
    );
    const child = spawn(
        process.execPath,
        [
            ...process.execArgv,
            fileURLToPath(new URL('./start.ts', import.meta.url)),
            '--local',
        ],
        {
            env: {
                ...process.env,
                BENTO_STATE_DIR: state,
                BENTO_SERVICE_BEARER: testToken,
                BENTO_PORT: '0',
                BENTO_EXECUTION_ENVIRONMENT_VERSION: localEnvironmentVersion,
                BENTO_REVIEW_MODULE: module,
                BENTO_TEST_REVIEW_RESULT: marker,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    const closed = once(child, 'close');
    const lines = createInterface({ input: child.stdout });
    t.after(async () => {
        child.kill('SIGKILL');
        await closed;
        lines.close();
        await rm(state, { recursive: true, force: true });
    });
    const [url] = await Promise.race([
        once(lines, 'line'),
        closed.then(() => {
            throw new Error('Review fixture failed to start');
        }),
    ]);
    for (const endpoint of [
        '/v1/tasks/closure',
        '/v1/task-retries/reconcile',
        '/api/tasks/closure',
    ]) {
        const res = await fetch(url + endpoint, {
            headers: {
                authorization: 'Bearer ' + testToken,
                'x-bento-owner-id': 'account-a',
            },
        });
        assert.equal(res.status, 404);
    }
    child.kill('SIGTERM');
    assert.deepEqual(await closed, [0, null]);
    assert.deepEqual(
        JSON.parse(await readFile(marker, 'utf8')),
        Array(6).fill('function'),
    );
});

test(
    'uncertain retries yield to other Tasks and a damaged staging journal is durably blocked',
    { timeout: 25_000 },
    async (t) => {
        const state = await mkdtemp(join(tmpdir(), 'bento-retry-fairness-'));
        const root = join(state, 'volume');
        const base = localHost(root);
        const executed = new Set<string>();
        const fault: { taskId?: string } = {};
        let deferRestore = true;
        let transientCalls = 0;
        let transientQueries = 0;
        const host: ExecutionHost = {
            ...base,
            async worker(request, signal, slot, exit) {
                const result = await base.worker(request, signal, slot, exit);
                if (
                    request.prompt === 'noop' &&
                    fault.taskId !== undefined &&
                    request.binding.project !== fault.taskId &&
                    executed.has(request.binding.project)
                )
                    return result;
                if (
                    request.mode === 'execute' &&
                    !executed.has(request.binding.project)
                ) {
                    executed.add(request.binding.project);
                    return 'review';
                }
                return result;
            },
            taskRecovery: {
                ...base.taskRecovery!,
                async queryRestore(...args) {
                    if (args[0].project === fault.taskId) transientQueries++;
                    return base.taskRecovery!.queryRestore(...args);
                },
                async restoreTask(...args) {
                    if (args[0].project === fault.taskId) {
                        transientCalls++;
                        if (deferRestore)
                            throw new Error('Fixture restore response unknown');
                    }
                    return base.taskRecovery!.restoreTask(...args);
                },
            },
        };
        let controller = await start(state, host);
        t.after(async () => {
            await controller.close();
            await rm(state, { recursive: true, force: true });
        });
        async function api(
            path: string,
            method = 'GET',
            body?: unknown,
            key?: string,
        ) {
            const response = await fetch(controller.url + '/v1' + path, {
                method,
                headers: {
                    authorization: 'Bearer ' + testToken,
                    'x-bento-owner-id': 'account-a',
                    ...(key ? { 'idempotency-key': key } : {}),
                    ...(body === undefined
                        ? {}
                        : { 'content-type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(5000),
            });
            return { status: response.status, body: await response.json() };
        }
        const workspaceSha256 = snapshotSha256([]);
        async function create() {
            const response = await api(
                '/tasks',
                'POST',
                {
                    id: null,
                    name: 'Task',
                    sourceSpaceId: null,
                    inputFiles: [],
                    inputManifest: [],
                    inputDigest: workspaceSha256,
                },
                randomUUID(),
            );
            assert.equal(response.status, 202);
            const id = response.body.task.id as string;
            const path = '/tasks/' + id;
            await until(
                () => api(path),
                (r) => r.body.task.status === 'ready',
                'New Task ready',
            );
            return { id, path };
        }
        async function run(path: string) {
            const response = await api(
                path + '/runs',
                'POST',
                { prompt: 'noop' },
                randomUUID(),
            );
            assert.equal(response.status, 202);
            return path + '/runs/' + response.body.run.id;
        }
        const first = await create();
        fault.taskId = first.id;
        const firstRun = await run(first.path);
        await until(
            () => api(firstRun),
            (r) => r.body.run.status === 'failed',
            'First Task failed safely',
        );
        const key = randomUUID();
        const retry = () => api(firstRun + '/retry', 'POST', undefined, key);
        const firstAttempt = await retry();
        assert.equal(firstAttempt.status, 202);
        const attemptId = firstAttempt.body.retry.id as string;
        await until(
            async () => transientCalls,
            (n) => n >= 2,
            'Original attempt queried again',
        );
        assert.equal((await retry()).body.retry.state, 'preparing');
        assert(transientQueries >= 2);

        const second = await create();
        const secondRun = await run(second.path);
        await until(
            () => api(secondRun),
            (r) => r.body.run.status === 'failed',
            'Second Task failed safely',
        );
        const secondAttempt = await api(
            secondRun + '/retry',
            'POST',
            undefined,
            randomUUID(),
        );
        assert.equal(secondAttempt.status, 202);
        const other = await create();
        executed.add(other.id);
        const otherRun = await run(other.path);
        await until(
            () => api(otherRun),
            (r) => r.body.run.status === 'succeeded',
            'Independent Task progressed',
        );
        const secondRetry =
            second.path + '/runs/' + secondAttempt.body.retry.runId;
        await until(
            () => api(secondRetry),
            (r) => r.status === 200 && r.body.run.status === 'succeeded',
            'Second retry progressed',
        );

        const store = new Store(join(state, 'business.sqlite'));
        const binding = store.binding(
            store.findRun(firstRun.split('/').at(-1)!),
        );
        store.close();
        const directory = join(root, binding.project);
        const pointer = join(directory, 'task-volume');
        const previousVolume = await readlink(pointer);
        const stagedVolume = 'volume-' + attemptId;
        await mkdir(join(directory, stagedVolume));
        await writeFile(
            join(directory, stagedVolume, 'damaged.txt'),
            Buffer.from([0xff]),
        );
        await mkdir(join(directory, 'restores'));
        await writeFile(
            join(directory, 'restores', attemptId + '.json'),
            JSON.stringify({
                attemptId,
                phase: 'prepared',
                sha256: workspaceSha256,
                bindingDigest: executionBindingDigest(binding),
                previousVolume,
                stagedVolume,
            }),
        );
        deferRestore = false;
        await until(
            retry,
            (r) => r.body.retry.state === 'blocked',
            'Deterministic conflict became blocked',
        );
        assert.equal(await readlink(pointer), previousVolume);
        const callsAtBlock = transientCalls;
        await controller.close();
        controller = await start(state, {
            ...host,
            observeRetryCleanup: async () => null,
        });
        assert.equal((await retry()).body.retry.state, 'blocked');
        const reopenedStore = new Store(join(state, 'business.sqlite'));
        assert.equal(
            reopenedStore.taskRetry(attemptId).lastConfirmedPhase,
            'preparing',
        );
        reopenedStore.close();
        assert.equal(
            await controller.reconcileTaskRetry({
                attemptId,
                expectedGeneration: 2,
            }),
            'pending',
        );
        await assert.rejects(
            controller.closeTaskRetry({ attemptId, expectedGeneration: 2 }),
            { code: 'review_unavailable' },
        );
        assert.equal(controller.readTaskRetryClosure(attemptId), null);
        assert.equal(transientCalls, callsAtBlock);
        await controller.close();
        controller = await start(state, host);
        await controller.closeTaskRetry({ attemptId, expectedGeneration: 2 });
        assert.equal((await retry()).body.retry.state, 'closed');
        assert.equal(
            controller.readTaskRetryClosure(attemptId)?.authorityGeneration,
            2,
        );
        assert.equal(await readlink(pointer), previousVolume);
    },
);

test(
    'Task event projection deduplicates retries and rejects stale grants and private fields',
    { timeout: 15_000 },
    async (t) => {
        const state = await mkdtemp(join(tmpdir(), 'bento-task-projection-'));
        const base = localHost(join(state, 'volume'));
        const requests: WorkerRequest[] = [];
        const canary = 'fixture-credential-must-not-project';
        async function project(request: WorkerRequest, items: unknown[]) {
            assert(request.publicEventsUrl);
            const response = await fetch(request.publicEventsUrl, {
                method: 'POST',
                headers: {
                    authorization: 'Bearer ' + request.grant.token,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ items }),
                signal: AbortSignal.timeout(3000),
            });
            await response.body?.cancel();
            return response.status;
        }
        const service = await start(state, {
            ...base,
            async worker(request, signal, slot, exit) {
                if (request.mode === 'execute' && request.publicEventsUrl) {
                    requests.push(request);
                    assert.equal(
                        await project(request, [
                            {
                                offset: 0,
                                kind: 'agent_reply',
                                text: canary,
                                privateDiagnostic: { marker: canary },
                            },
                        ]),
                        403,
                    );
                    const items = [
                        { offset: 0, kind: 'agent_reply', text: '任务结果' },
                        { offset: 1, kind: 'command', text: '确定性检查' },
                        {
                            offset: 10,
                            kind: 'check',
                            name: 'fixture check',
                            status: 'passed',
                            output: 'ok',
                        },
                    ];
                    assert.equal(await project(request, items), 200);
                    assert.equal(await project(request, items), 200);
                    assert.equal(
                        await project(request, [
                            { offset: 2, kind: 'step', text: 'out of order' },
                            {
                                offset: 11,
                                kind: 'step',
                                text: 'must not commit',
                            },
                        ]),
                        403,
                    );
                    assert.equal(await project(request, [items[0]!]), 200);

                    assert.equal(
                        await project(request, [
                            {
                                offset: 0,
                                kind: 'agent_reply',
                                text: 'conflict',
                            },
                        ]),
                        403,
                    );
                    const result = await base.worker(
                        request,
                        signal,
                        slot,
                        exit,
                    );
                    assert.equal(
                        await project(request, [
                            { offset: 3, kind: 'step', text: 'late' },
                        ]),
                        403,
                    );
                    return result;
                }
                return base.worker(request, signal, slot, exit);
            },
        });
        t.after(async () => {
            await service.close();
            await rm(state, { recursive: true, force: true });
        });
        async function api(
            path: string,
            method = 'GET',
            body?: unknown,
            key?: string,
        ) {
            const response = await fetch(service.url + '/v1' + path, {
                method,
                headers: {
                    authorization: 'Bearer ' + testToken,
                    'x-bento-owner-id': 'account-a',
                    ...(key ? { 'idempotency-key': key } : {}),
                    ...(body === undefined
                        ? {}
                        : { 'content-type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(5000),
            });
            const text = await response.text();
            return { status: response.status, text, body: JSON.parse(text) };
        }
        async function create() {
            const task = await api(
                '/tasks',
                'POST',
                {
                    id: null,
                    name: 'Projected Task',
                    sourceSpaceId: null,
                    inputFiles: [],
                    inputManifest: [],
                    inputDigest: snapshotSha256([]),
                },
                randomUUID(),
            );
            assert.equal(task.status, 202, task.text);
            const path = '/tasks/' + task.body.task.id;
            await until(
                () => api(path),
                (r) => r.body.task.status === 'ready',
                'Projected Task ready',
            );
            return path;
        }
        async function run(task: string) {
            const response = await api(
                task + '/runs',
                'POST',
                { prompt: 'noop' },
                randomUUID(),
            );
            assert.equal(response.status, 202, response.text);
            const path = task + '/runs/' + response.body.run.id;
            await until(
                () => api(path),
                (r) => r.body.run.status === 'succeeded',
                'Projected Run published',
            );
            const result = await api(path + '/results');
            assert.equal(result.body.result.summary, '任务结果');
            assert.equal(result.text.includes(canary), false);
            for (const view of ['incremental', 'cumulative']) {
                const patches = [];
                for (const download of ['', '&download=1']) {
                    const response = await fetch(
                        service.url +
                            '/v1' +
                            path +
                            '/results/1/diff?view=' +
                            view +
                            download,
                        {
                            headers: {
                                authorization: 'Bearer ' + testToken,
                                'x-bento-owner-id': 'account-a',
                            },
                            signal: AbortSignal.timeout(5000),
                        },
                    );
                    assert.equal(response.status, 200);
                    const bytes = Buffer.from(await response.arrayBuffer());
                    assert.equal(bytes.includes(canary), false);
                    patches.push(bytes);
                }
                assert.deepEqual(patches[0], patches[1]);
            }
            assert.deepEqual(result.body.result.checks, [
                { name: 'fixture check', status: 'passed', output: 'ok' },
            ]);
        }
        const task = await create();
        await run(task);
        await run(task);
        const separate = await create();
        await run(separate);
        assert.equal(requests[0]!.grant.session, requests[1]!.grant.session);
        assert.notEqual(requests[0]!.grant.session, requests[2]!.grant.session);
        assert.equal(
            await project(requests[0]!, [
                { offset: 10, kind: 'step', text: 'old' },
            ]),
            403,
        );
        const { body, text } = await api(task + '/events');
        assert.deepEqual(
            body.items.map((event: { sequence: number }) => event.sequence),
            [1, 2, 3, 4, 5, 6, 7, 8],
        );
        assert.equal(
            body.items.filter(
                (event: { kind: string }) => event.kind === 'check',
            ).length,
            2,
        );
        assert.equal(text.includes(canary), false);
        assert.equal((await api(separate + '/events')).body.items.length, 4);
    },
);

test(
    'Task terminal results preserve four checks, empty bytes and unavailable gates across reopen',
    { timeout: 15_000 },
    async (t) => {
        const state = await mkdtemp(join(tmpdir(), 'bento-terminal-results-'));
        const base = localHost(join(state, 'volume'));
        const blocked = barrier();
        const checks = [
            { name: '通过检查', status: 'passed', output: '安全通过摘要' },
            { name: '失败检查', status: 'failed', output: '安全失败摘要' },
            { name: '未运行检查', status: 'not_run', output: null },
            {
                name: '无法运行检查',
                status: 'unavailable',
                output: '安全不可用摘要',
            },
        ];
        const host: ExecutionHost = {
            ...base,
            async worker(request, signal, slot, exit) {
                if (request.mode === 'execute') {
                    if (request.prompt === 'blocked') await blocked.promise;
                    assert(request.publicEventsUrl);
                    const response = await fetch(request.publicEventsUrl, {
                        method: 'POST',
                        headers: {
                            authorization: 'Bearer ' + request.grant.token,
                            'content-type': 'application/json',
                        },
                        body: JSON.stringify({
                            items: checks.map((check, offset) => ({
                                offset,
                                kind: 'check',
                                ...check,
                            })),
                        }),
                        signal: AbortSignal.timeout(3000),
                    });
                    assert.equal(response.status, 200);
                    await response.body?.cancel();
                }
                return base.worker(
                    request.prompt === 'blocked'
                        ? { ...request, prompt: 'noop' }
                        : request,
                    signal,
                    slot,
                    exit,
                );
            },
        };
        let service = await start(state, host);
        t.after(async () => {
            blocked.resolve();
            await service.close();
            await rm(state, { recursive: true, force: true });
        });
        async function api(
            path: string,
            owner = 'account-a',
            method = 'GET',
            body?: unknown,
        ) {
            return fetch(service.url + '/v1' + path, {
                method,
                headers: {
                    authorization: 'Bearer ' + testToken,
                    'x-bento-owner-id': owner,
                    ...(body === undefined
                        ? {}
                        : {
                              'content-type': 'application/json',
                              'idempotency-key': randomUUID(),
                          }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(5000),
            });
        }
        async function json(path: string) {
            const response = await api(path);
            assert.equal(response.status, 200);
            return response.json();
        }
        async function create(prompt: string) {
            const response = await api('/tasks', 'account-a', 'POST', {
                id: null,
                name: 'Terminal fixture',
                sourceSpaceId: null,
                inputFiles: [],
                inputManifest: [],
                inputDigest: snapshotSha256([]),
            });
            assert.equal(response.status, 202);
            const task = (await response.json()).task.id as string;
            const root = '/tasks/' + task;
            await until(
                () => json(root),
                (value) => value.task.status === 'ready',
                'terminal Task ready',
            );
            const run = await api(root + '/runs', 'account-a', 'POST', {
                prompt,
            });
            assert.equal(run.status, 202);
            return { root, path: root + '/runs/' + (await run.json()).run.id };
        }
        async function capture(path: string, empty: boolean) {
            const { result } = await json(path + '/results');
            assert.equal(result.version, 1);
            assert.equal(result.runId, path.split('/').at(-1));
            assert.deepEqual(result.checks, checks);
            const patches: Record<string, string> = {};
            for (const view of ['incremental', 'cumulative'] as const) {
                const preview = await api(
                    path + '/results/1/diff?view=' + view,
                );
                const download = await api(
                    path + '/results/1/diff?view=' + view + '&download=1',
                );
                assert.equal(preview.status, 200);
                assert.equal(download.status, 200);
                assert.match(
                    preview.headers.get('content-type') ?? '',
                    /^text\/plain/,
                );
                assert.equal(
                    download.headers.get('content-disposition'),
                    'attachment; filename="changes.patch"',
                );
                const bytes = Buffer.from(await preview.arrayBuffer());
                assert.deepEqual(
                    bytes,
                    Buffer.from(await download.arrayBuffer()),
                );
                assert.equal(bytes.length === 0, empty);
                assert.equal(
                    createHash('sha256').update(bytes).digest('hex'),
                    result[view + 'Sha256'],
                );
                patches[view] = bytes.toString('utf8');
                assert.equal(
                    (
                        await api(
                            path + '/results/1/diff?view=' + view,
                            'account-b',
                        )
                    ).status,
                    404,
                );
            }
            assert.equal(
                (await api(path + '/results', 'account-b')).status,
                404,
            );
            return { result, patches };
        }
        const empty = await create('noop');
        await until(
            () => json(empty.path),
            (value) => value.run.status === 'succeeded',
            'empty result published',
        );
        const beforeEmpty = await capture(empty.path, true);
        const changed = await create('fixture change');
        await until(
            () => json(changed.path),
            (value) => value.run.status === 'succeeded',
            'nonempty result published',
        );
        const beforeChanged = await capture(changed.path, false);
        for (const { root } of [empty, changed]) {
            const { items } = await json(root + '/events');
            assert.deepEqual(
                items
                    .filter((event: { kind: string }) => event.kind === 'check')
                    .map((event: { check: unknown }) => event.check),
                checks,
            );
        }
        const pending = await create('blocked');
        await until(
            () => json(pending.path),
            (value) => value.run.status === 'running',
            'pending Run running',
        );
        assert.equal((await json(pending.path)).run.resultVersion, null);
        for (const suffix of [
            '/results',
            '/results/1/diff?view=cumulative',
            '/results/1/diff?view=incremental&download=1',
        ]) {
            const unavailable = await api(pending.path + suffix);
            assert.equal(unavailable.status, 409);
            assert.equal(
                (await unavailable.json()).error.code,
                'diff_unavailable',
            );
        }
        blocked.resolve();
        await until(
            () => json(pending.path),
            (value) => value.run.status === 'succeeded',
            'barrier released',
        );
        await service.close();
        service = await start(state, host);
        assert.deepEqual(await capture(empty.path, true), beforeEmpty);
        assert.deepEqual(await capture(changed.path, false), beforeChanged);
    },
);
