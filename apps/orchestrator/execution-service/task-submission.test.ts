import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Store, type TaskInput } from './store.ts';
import type { RunStatus } from './types.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const owner = 'retry-owner';
const version = 'sha256:' + 'a'.repeat(64);
const blank: TaskInput = {
    id: null,
    name: 'Retry task',
    sourceSpaceId: null,
    inputFiles: [],
    inputManifest: [],
    inputDigest: hash('[]'),
};
async function fixture(t: TestContext, input = blank) {
    const directory = await mkdtemp(join(tmpdir(), 'bento-submission-store-'));
    const path = join(directory, 'business.sqlite');
    let store = new Store(path, 16);
    t.after(async () => {
        store.close();
        await rm(directory, { recursive: true, force: true });
    });
    const key = randomUUID();
    const task = store.createTask(owner, key, input, version).task;
    store.importResult(task.id, 'ready');
    return {
        get store() {
            return store;
        },
        task,
        key,
        reopen() {
            store.close();
            store = new Store(path, 16);
        },
        rows() {
            const db = new DatabaseSync(path, { readOnly: true });
            try {
                return [
                    'tasks',
                    'task_creation_receipts',
                    'runs',
                    'task_events',
                    'retry_attempts',
                ].map((table) =>
                    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
                );
            } finally {
                db.close();
            }
        },
    };
}
for (const kind of ['blank', 'snapshot'] as const) {
    test(`${kind}: durable creation and Run receipts survive reopen and conflicts are atomic`, async (t) => {
        const files = [{ path: 'input.txt', text: 'base\n' }];
        const input =
            kind === 'blank'
                ? blank
                : {
                      id: randomUUID(),
                      name: 'Snapshot',
                      sourceSpaceId: randomUUID(),
                      inputFiles: files,
                      inputManifest: [
                          {
                              fileId: randomUUID(),
                              path: 'input.txt',
                              bytes: 5,
                              sha256: hash('base\n'),
                          },
                      ],
                      inputDigest: hash(JSON.stringify(files)),
                  };
        const f = await fixture(t, input);
        const runKey = randomUUID();
        const run = f.store.enqueueTaskRun(
            owner,
            f.task.id,
            runKey,
            'Original',
        ).run;
        const before = f.rows();
        f.reopen();
        const replay = f.store.createTask(
            owner,
            f.key,
            input,
            'sha256:' + 'b'.repeat(64),
        );
        assert.equal(replay.replay, true);
        assert.equal(replay.task.id, f.task.id);
        assert.equal(replay.task.environmentVersion, version);
        assert.equal(replay.task.inputDigest, input.inputDigest);
        assert.equal(
            f.store.enqueueTaskRun(owner, f.task.id, runKey, 'Original').run.id,
            run.id,
        );
        assert.throws(
            () =>
                f.store.createTask(
                    owner,
                    f.key,
                    { ...input, name: 'Changed' },
                    version,
                ),
            { status: 409, code: 'idempotency_conflict' },
        );
        assert.throws(
            () => f.store.enqueueTaskRun(owner, f.task.id, runKey, 'Changed'),
            { status: 409, code: 'idempotency_conflict' },
        );
        assert.throws(() => f.store.task('another-owner', f.task.id), {
            status: 404,
        });
        assert.throws(
            () => f.store.taskRunRow('another-owner', f.task.id, run.id),
            { status: 404 },
        );
        assert.deepEqual(f.rows(), before);
        assert.equal(f.store.taskRunRows(owner, f.task.id).length, 1);
        assert.equal(
            f.store
                .taskEvents(owner, f.task.id, 0)
                .filter((e) => e.kind === 'user_message').length,
            1,
        );
    });
}
for (const status of [
    'queued',
    'running',
    'recovering',
    'needs_review',
    'cancelling',
] satisfies RunStatus[]) {
    test(`${status}: new submissions cannot replace an active Run after reopen`, async (t) => {
        const f = await fixture(t);
        const key = randomUUID();
        const run = f.store.enqueueTaskRun(
            owner,
            f.task.id,
            key,
            'Original',
        ).run;
        f.store.status(run.id, status, 'Synthetic active state');
        const before = f.rows();
        f.reopen();
        assert.throws(
            () =>
                f.store.enqueueTaskRun(
                    owner,
                    f.task.id,
                    randomUUID(),
                    'New requirement',
                ),
            { status: 409, code: 'task_busy' },
        );
        assert.equal(
            f.store.enqueueTaskRun(owner, f.task.id, key, 'Original').run.id,
            run.id,
        );
        assert.deepEqual(f.rows(), before);
    });
}
async function retryFixture(t: TestContext) {
    const f = await fixture(t);
    const source = f.store.enqueueTaskRun(
        owner,
        f.task.id,
        randomUUID(),
        'Original',
    ).run;
    f.store.status(source.id, 'failed', 'Synthetic failure');
    // Store-level fixture only: this is not trusted runtime stop evidence.
    f.store.recordStopProof(source.id, '{}');
    const evidence = {
        oldGeneration: 1,
        newGeneration: 2,
        workspaceSha256: blank.inputDigest,
        historySha256: blank.inputDigest,
    };
    const attempt = f.store.acceptTaskRetry(
        owner,
        f.task.id,
        source.id,
        randomUUID(),
        evidence,
    ).attempt;
    return { f, attempt };
}
for (const phase of [
    'preparing',
    'workspace_restored',
    'history_restored',
    'blocked',
] as const) {
    test(`retry ${phase}: durable reservation rejects new submissions without writes`, async (t) => {
        const { f, attempt } = await retryFixture(t);
        if (phase === 'blocked')
            assert.equal(
                f.store.advanceTaskRetry(attempt.id, 'preparing', 'blocked'),
                true,
            );
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
        const before = f.rows();
        f.reopen();
        assert.equal(f.store.taskRetry(attempt.id).phase, phase);
        assert.throws(
            () =>
                f.store.enqueueTaskRun(
                    owner,
                    f.task.id,
                    randomUUID(),
                    'New requirement',
                ),
            { status: 409, code: 'task_busy' },
        );
        assert.deepEqual(f.rows(), before);
    });
}
test('queued retry receipt delegates its gate to the new Run and releases it at terminal state', async (t) => {
    const { f, attempt } = await retryFixture(t);
    assert.equal(
        f.store.advanceTaskRetry(attempt.id, 'preparing', 'workspace_restored'),
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
    const before = f.rows();
    assert.throws(
        () =>
            f.store.enqueueTaskRun(
                owner,
                f.task.id,
                randomUUID(),
                'New requirement',
            ),
        { status: 409, code: 'task_busy' },
    );
    assert.deepEqual(f.rows(), before);
    f.store.status(next.id, 'succeeded', 'Synthetic success');
    f.reopen();
    const runs = f.store.taskRunRows(owner, f.task.id).length;
    const messages = f.store
        .taskEvents(owner, f.task.id, 0)
        .filter((e) => e.kind === 'user_message').length;
    assert.equal(
        f.store.enqueueTaskRun(
            owner,
            f.task.id,
            randomUUID(),
            'New requirement',
        ).replay,
        false,
    );
    assert.equal(f.store.taskRunRows(owner, f.task.id).length, runs + 1);
    assert.equal(
        f.store
            .taskEvents(owner, f.task.id, 0)
            .filter((e) => e.kind === 'user_message').length,
        messages + 1,
    );
});
test('closed retry receipt rejects as task_not_ready rather than holding an active reservation', async (t) => {
    const { f, attempt } = await retryFixture(t);
    assert.equal(
        f.store.advanceTaskRetry(attempt.id, 'preparing', 'blocked'),
        true,
    );
    assert.notEqual(
        f.store.closeBlockedTaskRetry(attempt.id, 2, 'a'.repeat(64)),
        null,
    );
    assert.equal(f.store.taskRetry(attempt.id).phase, 'closed');
    assert.equal(f.store.task(owner, f.task.id).closedReason, 'unconfirmed');
    const before = f.rows();
    f.reopen();
    assert.throws(
        () =>
            f.store.enqueueTaskRun(
                owner,
                f.task.id,
                randomUUID(),
                'New requirement',
            ),
        { status: 409, code: 'task_not_ready' },
    );
    assert.deepEqual(f.rows(), before);
});
