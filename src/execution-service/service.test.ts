import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync, fsyncSync, writeSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PersistenceFence } from '../openshell/persistence-fence.ts';
import { SingleHostExecution } from '../openshell/single-host.ts';
import { localHost } from './local.ts';
import { completedTurn } from './dsh-worker.ts';
import { serveExecution } from './service.ts';
import type { ExecutionHost, FileText, WorkerRequest } from './types.ts';
import { processWorker, reserveOperation } from './worker.ts';

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
            args: [
                '--experimental-strip-types',
                testFile,
                '--effect-worker',
                state,
            ],
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

if (process.argv[2] === '--effect-worker') {
    await effectWorker(process.argv[3] ?? '');
} else if (process.argv[2] === '--crash-controller') {
    await crashController(process.argv[3] ?? '');
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
            [
                '--experimental-strip-types',
                testFile,
                '--crash-controller',
                state,
            ],
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
        } finally {
            controller.kill('SIGKILL');
            await exited;
            await service?.close();
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
