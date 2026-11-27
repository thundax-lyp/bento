import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/store/index.ts';
import { snapshotSha256 } from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/service.ts';
import { readme } from './fixtures/service.ts';

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
