import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PersistenceFence } from '@/apps/orchestrator/orchestrator-execution-host/src/openshell/persistence-fence.ts';
import { SingleHostExecution } from '@/apps/orchestrator/orchestrator-execution-host/src/openshell/single-host.ts';
import { localHost } from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/local.ts';
import { Store } from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/store/index.ts';
import { snapshotSha256 } from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/service.ts';
import {
    type ExecutionHost,
    type TaskVolumeStopObservation,
    type WorkerRequest,
} from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/types.ts';
import {
    testToken,
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

const controllerFixtureFile = fileURLToPath(
    new URL('./fixtures/controller.ts', import.meta.url),
);

test('worker exits after an fsynced effect, controller is killed, recovery fences without replay', async () => {
    const state = await mkdtemp(join(tmpdir(), 'bento-recovery-test-'));
    const controller = spawn(
        process.execPath,
        [
            ...process.execArgv,
            controllerFixtureFile,
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
            (await restarted(pa + '/runs', 'POST', { prompt: 'new' }, 'new'))
                .status,
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
        await Promise.all([service.reviewRun(proof), service.reviewRun(proof)]);
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
    const state = await mkdtemp(join(tmpdir(), 'bento-unconfirmed-recovery-'));
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
                        controllerFixtureFile,
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
                let closureFault:
                    'absent' | 'writer' | 'restore' | 'running' | undefined;
                const observedHost: ExecutionHost = {
                    ...host,
                    async observeTaskVolumeStopped(...args) {
                        if (closureFault === 'absent') return null;
                        const observation =
                            await host.observeTaskVolumeStopped!(...args);
                        if (!observation || !closureFault) return observation;
                        const fault = {
                            writer: { volumeWriters: 1 },
                            restore: { restoreIdle: false },
                            running: { sandboxStopped: false },
                        }[closureFault];
                        return {
                            ...observation,
                            ...fault,
                        } as unknown as TaskVolumeStopObservation;
                    },
                };
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
                        : observedHost,
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
                    if (decision === 'unconfirmed') {
                        for (const rejected of [
                            'absent',
                            'writer',
                            'restore',
                            'running',
                        ] as const) {
                            closureFault = rejected;
                            await assert.rejects(
                                service.closeTaskRun(closure),
                                { code: 'review_unavailable' },
                            );
                            assert.equal(service.readTaskClosure(runId), null);
                            assert.equal(
                                (await call(runPath)).body.run.status,
                                'needs_review',
                            );
                            assert.equal(
                                (await call('/account/purge', 'POST')).body
                                    .complete,
                                false,
                            );
                        }
                        closureFault = undefined;
                    }
                    await Promise.all([
                        service.closeTaskRun(closure),
                        service.closeTaskRun(closure),
                    ]);
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
