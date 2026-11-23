import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { localHost } from '@/apps/orchestrator/src/execution-service/local.ts';
import {
    executionBindingDigest,
    sha256Digest,
    type ExecutionHost,
    type WorkerExitObservation,
    type WorkerRequest,
} from '@/apps/orchestrator/src/execution-service/types.ts';
import { barrier, fixtureSdk, start, until } from './fixtures/service.ts';
import {
    taskRetryTestClient,
    taskRetryTestInput,
} from './fixtures/task-retry.ts';

async function scenario(t: TestContext, fault: string, mode = 'cancel') {
    const state = await mkdtemp(join(tmpdir(), 'bento-sdk-retry-'));
    const root = join(state, 'volume');
    const base = localHost(root);
    const exits = new Map<string, WorkerExitObservation>();
    const partial = barrier();
    const release = barrier();
    let calls = 0;
    let restores = 0;
    let observations = 0;
    let source: WorkerRequest | undefined;
    const host: ExecutionHost = {
        ...base,
        sdk: {
            ...fixtureSdk,
            ...(fault === 'no decoder'
                ? {}
                : {
                      decodeExecEvent: () => ({
                          kind: 'exit' as const,
                          code: 0,
                      }),
                  }),
        },
        async observeWorkerExit(_binding, runId) {
            return fault === 'no exit' ? null : (exits.get(runId) ?? null);
        },
        async stopped(binding) {
            return source && fault === 'sandbox not stopped'
                ? false
                : base.stopped(binding);
        },
        taskRecovery: {
            ...base.taskRecovery!,
            async observeSdkRetrySafety(binding, runId, generation) {
                observations++;
                if (fault === 'null') return null;
                if (fault === 'throws')
                    throw new Error('Observation unavailable');
                const exit = exits.get(runId);
                assert(exit);
                const observation = {
                    ...exit,
                    observedAt: new Date().toISOString(),
                    workspaceOnly: true,
                    unknownOperations: 0,
                };
                if (fault === 'session') observation.sessionId = randomUUID();
                if (fault === 'run') observation.runId = randomUUID();
                if (fault === 'generation') observation.generation--;
                if (fault === 'tenant')
                    observation.bindingDigest = executionBindingDigest({
                        ...binding,
                        tenant: 'foreign',
                    });
                if (fault === 'volume')
                    observation.bindingDigest = executionBindingDigest({
                        ...binding,
                        volume: randomUUID(),
                    });
                if (fault === 'sandbox')
                    observation.bindingDigest = executionBindingDigest({
                        ...binding,
                        sandbox: randomUUID(),
                    });
                if (fault === 'exit mismatch')
                    observation.exitedAt = new Date(
                        Date.parse(exit.exitedAt) - 1,
                    ).toISOString();
                if (fault === 'invalid exit') observation.exitedAt = 'invalid';
                if (fault === 'invalid observation')
                    observation.observedAt = 'invalid';
                if (fault === 'future observation')
                    observation.observedAt = new Date(
                        Date.now() + 60_000,
                    ).toISOString();
                if (fault === 'before exit')
                    observation.observedAt = new Date(
                        Date.parse(exit.exitedAt) - 1,
                    ).toISOString();
                if (fault === 'external effect')
                    observation.workspaceOnly = false;
                if (fault === 'unknown count')
                    observation.unknownOperations = 1;
                if (fault === 'history handle' || fault === 'history batch') {
                    const db = new DatabaseSync(join(state, 'history.sqlite'));
                    try {
                        if (fault === 'history handle')
                            db.prepare(
                                'INSERT INTO sessions(id,header,inherited,epoch,owner,handle) VALUES(?,?,0,?,?,?) ON CONFLICT(id) DO UPDATE SET handle=excluded.handle',
                            ).run(
                                binding.session,
                                JSON.stringify({
                                    id: binding.session,
                                    version: 4,
                                    createdAt: Date.now(),
                                    isSeeded: false,
                                }),
                                generation + 1,
                                'fault-observer',
                                'unsettled',
                            );
                        else
                            db.prepare(
                                'INSERT OR IGNORE INTO batch_intents(id,epoch,batch,payload) VALUES(?,?,?,?)',
                            ).run(binding.session, generation, 'pending', '[]');
                    } finally {
                        db.close();
                    }
                }
                if (fault === 'authority changed') {
                    const db = new DatabaseSync(
                        join(state, 'authority.sqlite'),
                    );
                    try {
                        db.prepare(
                            'UPDATE execution_sessions SET capability=? WHERE session=?',
                        ).run('unexpected', binding.session);
                    } finally {
                        db.close();
                    }
                }
                return observation;
            },
            async restoreTask(...args) {
                restores++;
                return base.taskRecovery!.restoreTask(...args);
            },
        },
        async worker(request, signal, slot, onExit) {
            if (request.mode !== 'execute')
                return base.worker(request, signal, slot, onExit);
            calls++;
            if (calls === 3) {
                assert(source);
                assert.deepEqual(request.binding, source.binding);
                assert.equal(
                    request.grant.generation,
                    source.grant.generation + 1,
                );
            }
            try {
                const result = await base.worker(request, signal, slot);
                const path = join(root, request.binding.project, 'task-volume');
                if (calls === 1) {
                    await writeFile(join(path, 'prior.txt'), 'prior\n');
                } else if (calls === 2) {
                    source = request;
                    await writeFile(join(path, 'partial.txt'), 'partial\n');
                    if (fault === 'unknown ledger') {
                        const db = new DatabaseSync(
                            join(state, 'authority.sqlite'),
                        );
                        try {
                            db.prepare(
                                'INSERT INTO operations VALUES(?,?,?,?,?)',
                            ).run(
                                request.binding.session,
                                request.grant.generation,
                                randomUUID(),
                                'unknown-input',
                                'UNKNOWN',
                            );
                        } finally {
                            db.close();
                        }
                    }
                    partial.resolve();
                    if (mode === 'fail') {
                        await release.promise;
                        throw new Error(
                            'Intentional interruption after partial write',
                        );
                    }
                    await delay(30_000, undefined, { signal });
                }
                return result;
            } finally {
                exits.set(request.grant.run, {
                    sessionId: request.binding.session,
                    runId: request.grant.run,
                    generation: request.grant.generation,
                    bindingDigest: executionBindingDigest(request.binding),
                    exitedAt: new Date().toISOString(),
                });
                onExit?.();
            }
        },
    };
    if (fault === 'no observer') delete host.observeWorkerExit;
    if (fault === 'no method') delete host.taskRecovery!.observeSdkRetrySafety;
    let controller = await start(state, host);
    t.after(async () => {
        release.resolve();
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
        'Task ready',
    );
    const first = await api(
        path + '/runs',
        'POST',
        { prompt: 'noop' },
        randomUUID(),
    );
    const prior = path + '/runs/' + first.json().run.id;
    await until(
        () => api(prior),
        (r) => r.json().run.status === 'succeeded',
        'Prior result',
    );
    const results = [
        '/results',
        '/results/1/diff?view=incremental',
        '/results/1/diff?view=cumulative',
    ];
    const original = await Promise.all(
        results.map(async (suffix) => (await api(prior + suffix)).text),
    );
    const second = await api(
        path + '/runs',
        'POST',
        { prompt: 'noop' },
        randomUUID(),
    );
    const runId = second.json().run.id;
    const run = path + '/runs/' + runId;
    await partial.promise;
    assert(source);
    if (mode === 'fail') release.resolve();
    else assert.equal((await api(run + '/cancel', 'POST')).status, 200);
    const denied = fault !== 'complete';
    const staysCancelling = ['no exit', 'sandbox not stopped'].includes(fault);
    let lastStatus = '';
    const terminal = await until(
        async () => {
            const response = await api(run);
            lastStatus = response.text;
            return response;
        },
        (r) =>
            r.json().run.status ===
            (staysCancelling
                ? 'cancelling'
                : denied
                  ? 'needs_review'
                  : mode === 'fail'
                    ? 'failed'
                    : 'cancelled'),
        'SDK stop result',
    ).catch((error) => {
        throw new Error(error.message + ': ' + lastStatus);
    });
    if (staysCancelling) await delay(100);
    const key = randomUUID();
    const retry = await api(run + '/retry', 'POST', undefined, key);
    if (denied) {
        assert.equal(retry.status, 409, retry.text);
        assert.equal(
            (
                await api(
                    path + '/runs',
                    'POST',
                    { prompt: 'noop' },
                    randomUUID(),
                )
            ).status,
            409,
        );
        assert.equal(restores, 0);
        const db = new DatabaseSync(join(state, 'business.sqlite'), {
            readOnly: true,
        });
        try {
            assert.equal(
                db.prepare('SELECT count(*) AS n FROM stop_proofs').get()?.n,
                0,
            );
            assert.equal(
                db.prepare('SELECT count(*) AS n FROM retry_attempts').get()?.n,
                0,
            );
        } finally {
            db.close();
        }
        assert.equal(calls, 2);
        assert(
            (await base.snapshot(source.binding)).some(
                (f) => f.path === 'partial.txt',
            ),
        );
        if (
            [
                'no decoder',
                'no observer',
                'no method',
                'no exit',
                'sandbox not stopped',
                'unknown ledger',
            ].includes(fault)
        )
            assert.equal(observations, 0);
    } else {
        assert.equal(terminal.json().run.retryReason, null);
        assert.equal(retry.status, 202, retry.text);
        const receipt = retry.json().retry;
        const replay = await api(run + '/retry', 'POST', undefined, key);
        assert.equal(replay.status, 200);
        assert.equal(replay.json().retry.id, receipt.id);
        assert.equal(replay.json().retry.runId, receipt.runId);
        const newRun = path + '/runs/' + receipt.runId;
        await until(
            () => api(newRun),
            (r) => r.status === 200 && r.json().run.status === 'succeeded',
            'Retried SDK Task',
        );
        assert.equal(calls, 3);
        assert.equal(restores, 1);
        assert.equal((await api(path + '/runs')).json().items.length, 3);
        assert.deepEqual(await base.snapshot(source.binding), [
            { path: 'README.md', text: '# Fixture\n' },
            { path: 'prior.txt', text: 'prior\n' },
        ]);
        const db = new DatabaseSync(join(state, 'business.sqlite'), {
            readOnly: true,
        });
        try {
            const proof = db
                .prepare(
                    'SELECT canonicalJson,sha256 FROM stop_proofs WHERE runId=?',
                )
                .get(runId)!;
            assert.equal(
                sha256Digest(proof.canonicalJson as string),
                proof.sha256,
            );
            const value = JSON.parse(proof.canonicalJson as string);
            assert.equal(
                value.bindingDigest,
                executionBindingDigest(source.binding),
            );
            assert.equal(value.oldGeneration, source.grant.generation);
            assert.equal(value.newGeneration, source.grant.generation + 1);
            assert.equal(value.workerExitedAt, exits.get(runId)!.exitedAt);
            assert.equal(
                db.prepare('SELECT count(*) AS n FROM retry_attempts').get()?.n,
                1,
            );
        } finally {
            db.close();
        }
        await controller.close();
        controller = await start(state, host);
        const after = await api(run + '/retry', 'POST', undefined, key);
        assert.equal(after.status, 200);
        assert.equal(after.json().retry.runId, receipt.runId);
        assert.equal(calls, 3);
    }
    assert.deepEqual(
        await Promise.all(
            results.map(async (suffix) => (await api(prior + suffix)).text),
        ),
        original,
    );
}

for (const mode of ['cancel', 'fail'])
    test(
        'trusted SDK complete stop proof permits one retry after ' + mode,
        { timeout: 15_000 },
        (t) => scenario(t, 'complete', mode),
    );

for (const fault of [
    'no decoder',
    'no observer',
    'no method',
    'no exit',
    'sandbox not stopped',
    'null',
    'throws',
    'session',
    'run',
    'generation',
    'tenant',
    'sandbox',
    'volume',
    'exit mismatch',
    'invalid exit',
    'invalid observation',
    'future observation',
    'before exit',
    'external effect',
    'unknown count',
    'unknown ledger',
    'history handle',
    'history batch',
    'authority changed',
])
    test(
        'SDK retry rejects ' + fault + ' without proof, restore or dispatch',
        { timeout: 15_000 },
        (t) => scenario(t, fault),
    );
