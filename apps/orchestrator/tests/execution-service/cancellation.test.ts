import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { localHost } from '@/apps/orchestrator/src/execution-service/local.ts';
import { Store } from '@/apps/orchestrator/src/execution-service/store.ts';
import {
    type ExecutionHost,
    type WorkerRequest,
} from '@/apps/orchestrator/src/execution-service/types.ts';
import { reserveOperation } from '@/apps/worker/protocol.ts';
import {
    barrier,
    client,
    until,
    project,
    submit,
    rpc,
    operation,
    start,
} from './fixtures/service.ts';

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
            (await client(service.url, 'account-b')(run + '/cancel', 'POST'))
                .status,
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
        assert.equal((await api(run + '/cancel', 'POST')).text, response.text);
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
        assert.throws(() => store.addRun('A', project, 'second', 'prompt'), {
            status: 409,
        });
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
                    await reserveOperation(request, 'cancelled-tool', 'effect'),
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
            (await a(pa + '/runs', 'POST', { prompt: 'noop' }, 'other')).status,
            409,
        );
        const old = fixture.trace[0];
        assert(old);
        assert.equal((await rpc(old, 'flush')).status, 403);
        assert.equal((await operation(old)).status, 403);

        fixture.confirmSandboxStop();
        await fixture.sandboxStopped.promise;
        assert.equal((await a(run)).json().status, 'cancelling');
        assert.equal((await a(run + '/cancel', 'POST')).text, accepted.text);
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
