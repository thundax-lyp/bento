import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { executionHttp } from '@/apps/orchestrator/src/execution-service/http.ts';
import { Store } from '@/apps/orchestrator/src/execution-service/store.ts';
import { httpBackend } from '../src/execution-service-http.ts';
import {
    openSpaceIntegrityFixture,
    type SpaceIntegrityFixture,
} from './fixtures/space-integrity-fixture.ts';

const hexSHA256 = (text: string) =>
    createHash('sha256').update(text).digest('hex');
const sourceBytes = Buffer.from('abc');
function object(value: unknown): Record<string, unknown> {
    assert(
        value !== null && typeof value === 'object' && !Array.isArray(value),
    );
    return value as Record<string, unknown>;
}
async function waitFor(check: () => Promise<boolean>) {
    const start = performance.now();
    while (!(await check())) {
        if (performance.now() - start >= 5000)
            assert.fail('Fixture state deadline exceeded');
        await delay(20);
    }
}
async function fixture(t: TestContext) {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const directory = await mkdtemp(
        join(tmpdir(), 'bento-space-delete-state-'),
    );
    const path = join(directory, 'business.sqlite');
    const token = 'fixture-space-deletion-' + randomUUID();
    let store = new Store(path, 16);
    let server: ReturnType<typeof executionHttp> | undefined;
    let f: SpaceIntegrityFixture | undefined;
    const unexpected = (): never => {
        throw new Error('Unexpected fixture operation');
    };
    async function listen() {
        server = executionHttp(
            store,
            token,
            () => {},
            async () => unexpected(),
            () => unexpected(),
            async () => unexpected(),
            {
                environmentVersion: 'sha256:' + 'a'.repeat(64),
                runView: () => unexpected(),
                cancel: () => unexpected(),
                retry: () => unexpected(),
                async purgeSource(owner, spaceId, operationId) {
                    for (const binding of store.taskSourceDeletionBindings(
                        owner,
                        spaceId,
                        operationId,
                    ))
                        store.purgeProject(binding, operationId, spaceId);
                    return store.finishTaskSourceDeletion(
                        owner,
                        spaceId,
                        operationId,
                    );
                },
            },
        );
        const listening = once(server, 'listening');
        server.listen(0, '127.0.0.1');
        await listening;
        const address = server.address();
        assert(address && typeof address !== 'string');
        return httpBackend('http://127.0.0.1:' + address.port, token, 5000);
    }
    async function closeServer() {
        if (!server) return;
        await new Promise<void>((resolve, reject) => {
            server!.close((error) => (error ? reject(error) : resolve()));
            server!.closeAllConnections();
        });
        server = undefined;
    }
    async function close() {
        try {
            await f?.close();
        } finally {
            try {
                await closeServer();
            } finally {
                store.close();
                await rm(directory, { recursive: true, force: true });
            }
        }
    }
    try {
        let upstream = await listen();
        f = await openSpaceIntegrityFixture({
            backend: (owner, operation) => upstream(owner, operation),
        });
        const space = f;
        const fileId = randomUUID();
        const fileUrl = '/api/space/files/' + fileId;
        const projectUrl = '/api/space/projects/' + f.projectId;
        assert.equal(
            (
                await f.request(projectUrl + '/uploads', 'POST', {
                    id: fileId,
                    path: 'input.txt',
                    size: 3,
                    checksums: [
                        createHash('sha256')
                            .update(sourceBytes)
                            .digest('base64'),
                    ],
                })
            ).status,
            200,
        );
        await f.putPart(fileId, 1, sourceBytes);
        assert.equal(
            (
                await f.request(
                    `/api/space/uploads/${fileId}/complete`,
                    'POST',
                    {},
                )
            ).status,
            200,
        );
        const taskKey = randomUUID();
        const body = {
            name: 'fixture',
            source: {
                kind: 'space_snapshot',
                spaceId: f.projectId,
                fileIds: [fileId],
            },
        };
        const created = await f.request('/api/tasks', 'POST', body, taskKey);
        assert.equal(created.status, 202);
        const taskIdValue = object(object(created.json).task).id;
        assert(typeof taskIdValue === 'string');
        const taskId: string = taskIdValue;
        store.importResult(taskId, 'ready');
        const replay = await f.request('/api/tasks', 'POST', body, taskKey);
        assert.equal(replay.status, 200);
        assert.equal(object(object(replay.json).task).id, taskId);
        assert.equal(object(object(replay.json).task).status, 'ready');
        assert.equal((await f.request('/api/tasks/' + taskId)).status, 200);
        assert.equal(f.rows('space_task_inputs')[0]?.readPinned, 0);
        assert.deepEqual(store.taskInitialFiles(taskId), [
            { path: 'input.txt', text: 'abc' },
        ]);
        assert.equal(
            store.taskConfig(taskId)?.inputDigest,
            hexSHA256(JSON.stringify([{ path: 'input.txt', text: 'abc' }])),
        );
        function rows(sql: string, ...values: SQLInputValue[]) {
            const db = new DatabaseSync(path, { readOnly: true });
            try {
                return db
                    .prepare(sql)
                    .all(...values)
                    .map((row) => ({ ...row }));
            } finally {
                db.close();
            }
        }
        const refs = () =>
            rows('SELECT * FROM task_input_refs WHERE taskId=?', taskId);
        assert.deepEqual(refs(), [{ taskId, fileId }]);
        const frozen = store.taskConfig(taskId)?.inputManifest;
        assert.deepEqual(JSON.parse(frozen!), [
            { fileId, path: 'input.txt', bytes: 3, sha256: hexSHA256('abc') },
        ]);
        async function reopen() {
            await space.suspend();
            await closeServer();
            store.close();
            store = new Store(path, 16);
            upstream = await listen();
            await space.reopen();
        }
        async function blocked() {
            const impact = await space.request(projectUrl + '/deletion');
            assert.equal(impact.status, 200);
            assert.deepEqual(object(impact.json).blockers, ['project_busy']);
            const before = space.rows('space_uploads');
            const pins = space.rows('space_task_inputs');
            for (let n = 0; n < 2; n++) {
                for (const url of [projectUrl, fileUrl]) {
                    const result = await space.request(url, 'DELETE');
                    assert.equal(result.status, 409);
                    assert.equal(
                        object(object(result.json).error).code,
                        'project_busy',
                    );
                }
            }
            assert.deepEqual(space.rows('space_uploads'), before);
            assert.deepEqual(space.rows('space_task_inputs'), pins);
            assert.deepEqual(space.rows('space_file_deletions'), []);
            assert.equal(store.taskConfig(taskId)?.inputManifest, frozen);
            assert.deepEqual(refs(), [{ taskId, fileId }]);
            assert.deepEqual(store.taskInitialFiles(taskId), [
                { path: 'input.txt', text: 'abc' },
            ]);
            assert.deepEqual(await space.download(fileId), sourceBytes);
            assert.deepEqual(await space.readObject(fileId), sourceBytes);
            const tree = await space.request(projectUrl);
            assert.deepEqual(object(tree.json).files, [
                { id: fileId, path: 'input.txt', size: 3 },
            ]);
            const summary = await space.request('/api/space');
            assert.equal(object(summary.json).saved, 3);
            assert.equal(object(summary.json).reserved, 0);
            const fileHolds = rows(
                'SELECT state FROM task_input_delete_holds WHERE fileId=?',
                fileId,
            );
            const sourceHolds = rows(
                'SELECT state FROM task_source_deletions WHERE spaceId=?',
                space.projectId,
            );
            assert(
                fileHolds.length >= 2 &&
                    fileHolds.every((row) => row.state === 'denied'),
            );
            assert(
                sourceHolds.length >= 2 &&
                    sourceHolds.every((row) => row.state === 'denied'),
            );
        }
        async function deleted() {
            const first = await space.request(fileUrl, 'DELETE');
            assert([202, 204].includes(first.status));
            t.mock.timers.tick(30000);
            await new Promise<void>((resolve) => setImmediate(resolve));
            await waitFor(
                async () =>
                    (await space.request(fileUrl, 'DELETE')).status === 204,
            );
            assert.equal(
                (await space.request(fileUrl + '/download')).status,
                404,
            );
            assert.equal(await space.readObject(fileId), null);
            assert.equal(
                object((await space.request('/api/space')).json).saved,
                0,
            );
            assert.equal(store.taskConfig(taskId)?.inputManifest, frozen);
            assert.deepEqual(store.taskInitialFiles(taskId), [
                { path: 'input.txt', text: 'abc' },
            ]);
            assert.equal(
                (await space.request('/api/tasks/' + taskId)).status,
                200,
            );
            for (let repeat = 0; repeat < 2; repeat++) {
                assert.equal(
                    (await space.request(fileUrl, 'DELETE')).status,
                    204,
                );
                assert.equal(
                    object((await space.request('/api/space')).json).saved,
                    0,
                );
            }
            await waitFor(
                async () =>
                    (await space.request(projectUrl, 'DELETE')).status === 204,
            );
            assert.equal(
                (await space.request('/api/tasks/' + taskId)).status,
                404,
            );
            assert.equal((await space.request(projectUrl)).status, 404);
            assert.equal(
                (await space.request(fileUrl + '/download')).status,
                404,
            );
            assert.equal(
                (await space.request(projectUrl, 'DELETE')).status,
                204,
            );
            assert.equal(
                object((await space.request('/api/space')).json).saved,
                0,
            );
            assert.deepEqual(refs(), []);
        }
        function counts() {
            return [
                rows(
                    "SELECT count(*) AS count FROM runs WHERE projectId=? AND status IN ('queued','running','recovering','cancelling','needs_review')",
                    taskId,
                )[0]?.count,
                rows(
                    "SELECT count(*) AS count FROM retry_attempts WHERE taskId=? AND phase IN ('preparing','workspace_restored','history_restored','blocked')",
                    taskId,
                )[0]?.count,
            ];
        }
        return {
            space,
            taskId,
            fileId,
            rows,
            counts,
            reopen,
            blocked,
            deleted,
            close,
            get store() {
                return store;
            },
        };
    } catch (error) {
        await close();
        throw error;
    }
}

for (const state of [
    'queued',
    'running',
    'recovering',
    'cancelling',
    'needs_review',
] as const) {
    test(`WEB-03-07 ${state}: both DELETE gates preserve input across reopen`, async (t) => {
        const f = await fixture(t);
        try {
            const run = f.store.enqueueTaskRun(
                f.space.ownerId,
                f.taskId,
                randomUUID(),
                'Original',
            ).run;
            f.store.status(run.id, state, 'Synthetic active state');
            assert.deepEqual(f.counts(), [1, 0]);
            await f.blocked();
            await f.reopen();
            await f.blocked();
            assert.equal(f.store.findRun(run.id).status, state);
        } finally {
            await f.close();
        }
    });
}
for (const terminal of ['failed', 'cancelled', 'succeeded'] as const) {
    test(`WEB-03-07 ${terminal}: terminal fixture releases file and project deletion`, async (t) => {
        const f = await fixture(t);
        try {
            const run = f.store.enqueueTaskRun(
                f.space.ownerId,
                f.taskId,
                randomUUID(),
                'Original',
            ).run;
            f.store.status(run.id, terminal, 'Synthetic terminal state');
            assert.deepEqual(f.counts(), [0, 0]);
            await f.deleted();
        } finally {
            await f.close();
        }
    });
}

function acceptRetry(f: Awaited<ReturnType<typeof fixture>>) {
    const source = f.store.enqueueTaskRun(
        f.space.ownerId,
        f.taskId,
        randomUUID(),
        'Original',
    ).run;
    f.store.status(source.id, 'failed', 'Synthetic failure');
    // Store fixture only: this is not trusted runtime stop or restoration evidence.
    assert.equal(
        f.store.recordStopProof(source.id, '{}').sha256,
        hexSHA256('{}'),
    );
    const attempt = f.store.acceptTaskRetry(
        f.space.ownerId,
        f.taskId,
        source.id,
        randomUUID(),
        {
            oldGeneration: 1,
            newGeneration: 2,
            workspaceSha256: hexSHA256('[]'),
            historySha256: hexSHA256('[]'),
        },
    ).attempt;
    assert.equal(attempt.phase, 'preparing');
    assert.equal(attempt.lastConfirmedPhase, 'preparing');
    assert.equal(attempt.sourceRunId, source.id);
    assert.equal(
        f.rows('SELECT id FROM runs WHERE id=?', attempt.newRunId).length,
        0,
    );
    return { source, attempt };
}
for (const phase of [
    'preparing',
    'workspace_restored',
    'history_restored',
    'blocked',
] as const) {
    test(`WEB-03-07 retry ${phase}: reservation blocks DELETE until closure fixture`, async (t) => {
        const f = await fixture(t);
        try {
            const { source, attempt } = acceptRetry(f);
            if (phase === 'workspace_restored' || phase === 'history_restored')
                assert.equal(
                    f.store.advanceTaskRetry(
                        attempt.id,
                        'preparing',
                        'workspace_restored',
                    ),
                    true,
                );
            if (phase === 'history_restored')
                assert.equal(
                    f.store.advanceTaskRetry(
                        attempt.id,
                        'workspace_restored',
                        'history_restored',
                    ),
                    true,
                );
            if (phase === 'blocked')
                assert.equal(
                    f.store.advanceTaskRetry(
                        attempt.id,
                        'preparing',
                        'blocked',
                    ),
                    true,
                );
            assert.equal(
                f.store.taskRetry(attempt.id).lastConfirmedPhase,
                phase === 'blocked' ? 'preparing' : phase,
            );
            assert.equal(
                f.rows(
                    'SELECT error FROM retry_attempts WHERE id=?',
                    attempt.id,
                )[0]?.error,
                phase === 'blocked' ? 'restore_conflict' : null,
            );
            assert.deepEqual(f.counts(), [0, 1]);
            await f.blocked();
            await f.reopen();
            await f.blocked();
            assert.equal(f.store.taskRetry(attempt.id).phase, phase);
            assert.equal(f.store.findRun(source.id).status, 'failed');
            assert.equal(
                f.rows('SELECT id FROM runs WHERE id=?', attempt.newRunId)
                    .length,
                0,
            );
            assert.deepEqual(f.counts(), [0, 1]);
            if (phase !== 'blocked')
                assert.equal(
                    f.store.advanceTaskRetry(attempt.id, phase, 'blocked'),
                    true,
                );
            const evidenceDigest = hexSHA256(
                JSON.stringify({
                    kind: 'fixture-only-closure',
                    attemptId: attempt.id,
                    generation: 2,
                }),
            );
            const audit = f.store.closeBlockedTaskRetry(
                attempt.id,
                2,
                evidenceDigest,
            );
            assert(audit);
            assert.equal(audit.attemptId, attempt.id);
            assert.equal(audit.authorityGeneration, 2);
            assert.equal(audit.evidenceDigest, evidenceDigest);
            assert(typeof audit.closedAt === 'string');
            assert.equal(
                new Date(audit.closedAt).toISOString(),
                audit.closedAt,
            );
            assert.deepEqual(
                f.store.closeBlockedTaskRetry(attempt.id, 2, evidenceDigest),
                audit,
            );
            assert.equal(f.store.taskRetry(attempt.id).phase, 'closed');
            assert.equal(
                f.store.task(f.space.ownerId, f.taskId).closedReason,
                'unconfirmed',
            );
            assert.deepEqual(f.counts(), [0, 0]);
            await f.reopen();
            assert.deepEqual(f.store.readTaskRetryClosure(attempt.id), audit);
            await f.deleted();
        } finally {
            await f.close();
        }
    });
}
test('WEB-03-07 queued retry delegates deletion gate to new Run until terminal', async (t) => {
    const f = await fixture(t);
    try {
        const { attempt } = acceptRetry(f);
        assert.equal(
            f.store.advanceTaskRetry(
                attempt.id,
                'preparing',
                'workspace_restored',
            ),
            true,
        );
        assert.equal(
            f.store.advanceTaskRetry(
                attempt.id,
                'workspace_restored',
                'history_restored',
            ),
            true,
        );
        const next = f.store.finalizeTaskRetry(attempt.id, 'history_restored');
        assert.equal(next.id, attempt.newRunId);
        assert.equal(next.status, 'queued');
        assert.equal(f.store.taskRetry(attempt.id).phase, 'queued');
        assert.deepEqual(f.counts(), [1, 0]);
        await f.blocked();
        f.store.status(next.id, 'succeeded', 'Synthetic success');
        await f.reopen();
        assert.deepEqual(f.counts(), [0, 0]);
        assert.equal(f.store.taskRetry(attempt.id).phase, 'queued');
        await f.deleted();
    } finally {
        await f.close();
    }
});
