import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { localHost } from '@orchestrator/execution-service/local.ts';
import { Store } from '@orchestrator/execution-service/store/index.ts';
import { snapshotSha256 } from '@orchestrator/execution-service/service.ts';
import {
    executionBindingDigest,
    type ExecutionHost,
    type WorkerRequest,
} from '@orchestrator/execution-service/types.ts';
import { testToken, barrier, until, rpc, start } from './fixtures/service.ts';
import {
    taskRetryTestClient,
    taskRetryTestInput,
} from './fixtures/task-retry.ts';

test(
    'Task retry rejects unavailable Workspace checkpoints before admission',
    { timeout: 20_000 },
    async (t) => {
        for (const fault of [
            'missing',
            'invalid JSON',
            'wrong digest',
            'invalid files',
        ]) {
            await t.test(fault, async (t) => {
                const state = await mkdtemp(
                    join(tmpdir(), 'bento-retry-workspace-'),
                );
                const base = localHost(join(state, 'volume'));
                let binding: WorkerRequest['binding'] | undefined;
                let restores = 0;
                const controller = await start(state, {
                    ...base,
                    async worker(request, signal, slot, exit) {
                        const result = await base.worker(
                            request,
                            signal,
                            slot,
                            exit,
                        );
                        binding = request.binding;
                        return request.prompt === 'partial failure'
                            ? 'review'
                            : result;
                    },
                    taskRecovery: {
                        ...base.taskRecovery!,
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
                const task = '/tasks/' + created.json().task.id;
                await until(
                    () => api(task),
                    (r) => r.json().task.status === 'ready',
                    'Task ready',
                );
                const first = await api(
                    task + '/runs',
                    'POST',
                    { prompt: 'prior success' },
                    randomUUID(),
                );
                assert.equal(first.status, 202, first.text);
                const prior = task + '/runs/' + first.json().run.id;
                await until(
                    () => api(prior),
                    (r) => r.json().run.status === 'succeeded',
                    'Prior result',
                );
                const oldResult = (await api(prior + '/results')).text;
                const oldDiff = (
                    await api(prior + '/results/1/diff?view=cumulative')
                ).text;
                const submitted = await api(
                    task + '/runs',
                    'POST',
                    { prompt: 'partial failure' },
                    randomUUID(),
                );
                assert.equal(submitted.status, 202, submitted.text);
                const source = submitted.json().run.id;
                const run = task + '/runs/' + source;
                const failed = await until(
                    () => api(run),
                    (r) => r.json().run.status === 'failed',
                    'Safe failure',
                );
                assert.equal(failed.json().run.retryReason, null);
                assert(binding);
                const volume = snapshotSha256(await base.snapshot(binding));
                const history = new DatabaseSync(
                    join(state, 'history.sqlite'),
                    { readOnly: true },
                );
                const business = new DatabaseSync(
                    join(state, 'business.sqlite'),
                );
                t.after(() => {
                    history.close();
                    business.close();
                });
                const historyState = () => [
                    history.prepare('SELECT * FROM sessions ORDER BY id').all(),
                    history
                        .prepare('SELECT * FROM events ORDER BY id,seq')
                        .all(),
                    history
                        .prepare(
                            'SELECT * FROM history_checkpoints ORDER BY runId',
                        )
                        .all(),
                    history
                        .prepare(
                            'SELECT * FROM history_restores ORDER BY attemptId',
                        )
                        .all(),
                ];
                const before = historyState();
                if (fault === 'missing') {
                    business
                        .prepare(
                            'DELETE FROM task_run_checkpoints WHERE runId=?',
                        )
                        .run(source);
                } else {
                    const body =
                        fault === 'invalid JSON'
                            ? '{'
                            : fault === 'invalid files'
                              ? JSON.stringify([
                                    { path: '../escape', text: 'invalid' },
                                ])
                              : '[]';
                    business
                        .prepare(
                            'UPDATE task_run_checkpoints SET workspace=? WHERE runId=?',
                        )
                        .run(body, source);
                    if (fault === 'invalid files')
                        business
                            .prepare(
                                'UPDATE task_run_checkpoints SET workspaceSha256=? WHERE runId=?',
                            )
                            .run(
                                createHash('sha256').update(body).digest('hex'),
                                source,
                            );
                }
                await t.test(
                    'public reason and rejected request preserve state',
                    async () => {
                        assert.equal(
                            (await api(run)).json().run.retryReason,
                            'checkpoint_unavailable',
                        );
                        const denied = await api(
                            run + '/retry',
                            'POST',
                            undefined,
                            randomUUID(),
                        );
                        assert.deepEqual(
                            [
                                denied.status,
                                denied.json().error.code,
                                denied.json().error.reason,
                            ],
                            [
                                409,
                                'run_not_retryable',
                                'checkpoint_unavailable',
                            ],
                        );
                        assert.equal(
                            business
                                .prepare(
                                    'SELECT count(*) AS n FROM retry_attempts',
                                )
                                .get()?.n,
                            0,
                        );
                        assert.equal(
                            (await api(task + '/runs')).json().items.length,
                            2,
                        );
                        assert.equal(
                            snapshotSha256(await base.snapshot(binding!)),
                            volume,
                        );
                        assert.deepEqual(historyState(), before);
                        assert.equal(
                            (await api(prior + '/results')).text,
                            oldResult,
                        );
                        assert.equal(
                            (
                                await api(
                                    prior + '/results/1/diff?view=cumulative',
                                )
                            ).text,
                            oldDiff,
                        );
                        assert.equal(restores, 0);
                    },
                );
            });
        }
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
    'Task retry blocks after checkpoint admission and remains blocked across restart',
    { timeout: 20_000 },
    async (t) => {
        for (const checkpoint of ['workspace', 'history']) {
            const faults =
                checkpoint === 'workspace'
                    ? ['missing', 'corrupt', 'invalid files']
                    : ['missing', 'corrupt'];
            for (const fault of faults) {
                await t.test(checkpoint + ' ' + fault, async (t) => {
                    const state = await mkdtemp(
                        join(tmpdir(), 'bento-retry-admitted-'),
                    );
                    const base = localHost(join(state, 'volume'));
                    const held = barrier();
                    const release = barrier();
                    let queries = 0;
                    let restores = 0;
                    let binding: WorkerRequest['binding'] | undefined;
                    const host: ExecutionHost = {
                        ...base,
                        async worker(request, signal, slot, exit) {
                            const result = await base.worker(
                                request,
                                signal,
                                slot,
                                exit,
                            );
                            binding = request.binding;
                            return request.prompt === 'partial failure'
                                ? 'review'
                                : result;
                        },
                        taskRecovery: {
                            ...base.taskRecovery!,
                            async queryRestore(...args) {
                                queries++;
                                held.resolve();
                                await release.promise;
                                return base.taskRecovery!.queryRestore(...args);
                            },
                            async restoreTask(...args) {
                                restores++;
                                return base.taskRecovery!.restoreTask(...args);
                            },
                        },
                    };
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
                    const task = '/tasks/' + created.json().task.id;
                    const runs = task + '/runs';
                    await until(
                        () => api(task),
                        (r) => r.json().task.status === 'ready',
                        'Task ready',
                    );
                    const first = await api(
                        runs,
                        'POST',
                        { prompt: 'prior success' },
                        randomUUID(),
                    );
                    assert.equal(first.status, 202, first.text);
                    const prior = runs + '/' + first.json().run.id;
                    await until(
                        () => api(prior),
                        (r) => r.json().run.status === 'succeeded',
                        'Prior result',
                    );
                    const priorResult = (await api(prior + '/results')).text;
                    const priorDiff = (
                        await api(prior + '/results/1/diff?view=cumulative')
                    ).text;
                    const next = await api(
                        runs,
                        'POST',
                        { prompt: 'partial failure' },
                        randomUUID(),
                    );
                    assert.equal(next.status, 202, next.text);
                    const source = next.json().run.id;
                    const run = runs + '/' + source;
                    const failed = await until(
                        () => api(run),
                        (r) => r.json().run.status === 'failed',
                        'Safe failure',
                    );
                    assert.equal(failed.json().run.retryReason, null);
                    assert(binding);
                    const volumeBefore = snapshotSha256(
                        await base.snapshot(binding),
                    );
                    const history = new DatabaseSync(
                        join(state, 'history.sqlite'),
                    );
                    const business = new DatabaseSync(
                        join(state, 'business.sqlite'),
                    );
                    t.after(() => {
                        history.close();
                        business.close();
                    });
                    const historyState = () => [
                        history
                            .prepare('SELECT * FROM sessions ORDER BY id')
                            .all(),
                        history
                            .prepare('SELECT * FROM events ORDER BY id,seq')
                            .all(),
                        history
                            .prepare(
                                'SELECT * FROM history_restores ORDER BY attemptId',
                            )
                            .all(),
                    ];
                    const historyBefore = historyState();
                    const key = randomUUID();
                    const retry = () =>
                        api(run + '/retry', 'POST', undefined, key);
                    const accepted = await retry();
                    assert.equal(accepted.status, 202, accepted.text);
                    const attempt = accepted.json().retry;
                    await held.promise;
                    assert.equal(
                        business
                            .prepare(
                                'SELECT phase FROM retry_attempts WHERE id=?',
                            )
                            .get(attempt.id)?.phase,
                        'preparing',
                    );
                    const target =
                        checkpoint === 'workspace' ? business : history;
                    const table =
                        checkpoint === 'workspace'
                            ? 'task_run_checkpoints'
                            : 'history_checkpoints';
                    const column =
                        checkpoint === 'workspace' ? 'workspace' : 'body';
                    const mutation =
                        fault === 'missing'
                            ? target
                                  .prepare(
                                      'DELETE FROM ' + table + ' WHERE runId=?',
                                  )
                                  .run(source)
                            : target
                                  .prepare(
                                      'UPDATE ' +
                                          table +
                                          ' SET ' +
                                          column +
                                          '=? WHERE runId=?',
                                  )
                                  .run(
                                      fault === 'invalid files'
                                          ? JSON.stringify([
                                                {
                                                    path: '../escape',
                                                    text: 'invalid',
                                                },
                                            ])
                                          : '{',
                                      source,
                                  );
                    assert.equal(mutation.changes, 1);
                    release.resolve();
                    const blocked = await until(
                        retry,
                        (r) =>
                            r.status === 200 &&
                            r.json().retry.state === 'blocked',
                        'Retry blocked',
                    ).catch(async (error: Error) => {
                        const current = business
                            .prepare(
                                'SELECT phase,lastConfirmedPhase FROM retry_attempts WHERE id=?',
                            )
                            .get(attempt.id);
                        assert.fail(
                            JSON.stringify({
                                error: error.message,
                                receipt: (await retry()).json().retry.state,
                                ...current,
                                queries,
                                restores,
                            }),
                        );
                    });
                    assert.deepEqual(blocked.json().retry, {
                        ...attempt,
                        state: 'blocked',
                    });
                    const verifyBlocked = async () => {
                        assert.deepEqual((await retry()).json().retry, {
                            ...attempt,
                            state: 'blocked',
                        });
                        assert.equal(
                            (await api(runs + '/' + attempt.runId)).status,
                            404,
                        );
                        const phase = business
                            .prepare(
                                'SELECT phase,lastConfirmedPhase FROM retry_attempts WHERE id=?',
                            )
                            .get(attempt.id);
                        assert.equal(phase?.phase, 'blocked');
                        assert.equal(phase?.lastConfirmedPhase, 'preparing');
                        assert.equal((await api(runs)).json().items.length, 2);
                        const continued = await api(
                            runs,
                            'POST',
                            { prompt: 'must stay blocked' },
                            randomUUID(),
                        );
                        assert.deepEqual(
                            [continued.status, continued.json().error.code],
                            [409, 'task_busy'],
                        );
                        const otherRetry = await api(
                            run + '/retry',
                            'POST',
                            undefined,
                            randomUUID(),
                        );
                        assert.deepEqual(
                            [otherRetry.status, otherRetry.json().error.reason],
                            [409, 'task_busy'],
                        );
                        assert.equal(queries, 1);
                        assert.equal(restores, 0);
                        assert.equal(
                            snapshotSha256(await base.snapshot(binding!)),
                            volumeBefore,
                        );
                        assert.deepEqual(historyState(), historyBefore);
                        assert.equal(
                            (await api(prior + '/results')).text,
                            priorResult,
                        );
                        assert.equal(
                            (
                                await api(
                                    prior + '/results/1/diff?view=cumulative',
                                )
                            ).text,
                            priorDiff,
                        );
                    };
                    await verifyBlocked();
                    await controller.close();
                    controller = await start(state, host);
                    await verifyBlocked();
                });
            }
        }
    },
);

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
