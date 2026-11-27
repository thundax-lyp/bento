import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
    localEnvironmentVersion,
    localHost,
} from '@/apps/orchestrator/src/execution-service/local.ts';
import { Store } from '@/apps/orchestrator/src/execution-service/store/index.ts';
import {
    type ExecutionHost,
    type WorkerRequest,
} from '@/apps/orchestrator/src/execution-service/types.ts';
import { prewarmedWorker } from '@/apps/orchestrator/src/execution-service/warm-worker.ts';
import {
    testToken,
    barrier,
    fixtureSdk,
    client,
    until,
    project,
    submit,
    rpc,
    operation,
    sdk,
    start,
} from './fixtures/service.ts';

test('business writes wait for a concurrent dispatch transaction', async () => {
    const state = await mkdtemp(join(tmpdir(), 'bento-dispatch-contention-'));
    const file = join(state, 'business.sqlite');
    const store = new Store(file);
    const writer = new Worker(
        `
            const { DatabaseSync } = require('node:sqlite');
            const { parentPort, workerData } = require('node:worker_threads');
            const db = new DatabaseSync(workerData);
            db.exec('BEGIN IMMEDIATE');
            parentPort.postMessage('locked');
            parentPort.once('message', () => {
                setTimeout(() => {
                    db.exec('COMMIT');
                    db.close();
                    parentPort.close();
                }, 250);
            });
        `,
        { eval: true, workerData: file },
    );
    try {
        assert.deepEqual(await once(writer, 'message'), ['locked']);
        writer.postMessage('release');
        const { id } = store.addProject('tenant', 'Project', []);
        assert.equal(store.project('tenant', id).status, 'importing');
    } finally {
        await writer.terminate();
        store.close();
        await rm(state, { recursive: true, force: true });
    }
});

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
        assert.equal(store.findRun(a0).status, 'recovering');
        assert.equal(store.findRun(b0).status, 'queued');
        assert.equal(store.dispatchReserved(b0), true);
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
                [binary, '-test.run=^TestTemporalFairDispatchControlProcess$']
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
                import { localHost } from ${JSON.stringify(new URL('../../src/execution-service/local.ts', import.meta.url).href)};
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
                fileURLToPath(
                    new URL(
                        '../../src/execution-service/start.ts',
                        import.meta.url,
                    ),
                ),
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
                            new Error('Execution entry exited before listening')
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
                    join(state, 'volume', a4.slice(1), 'volume', 'README.md'),
                    'utf8',
                ),
                '# Fixture\n',
            );
            assert(controller.pid);
            controller.kill('SIGTERM');
            assert.deepEqual(await within(closed, 'execution entry shutdown'), [
                0,
                null,
            ]);
        } catch (error) {
            if (controller.pid) controller.kill('SIGKILL');
            await within(closed, 'execution entry killed');
            throw new Error(
                'Fair dispatch execution entry failed\n' + stderr.toString(),
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
        assert.equal((await restarted(first + '/diff')).text, original.text);
        assert.equal(trace.length, 4);
    } finally {
        release.resolve();
        await service.close();
        await rm(state, { recursive: true, force: true });
    }
});
