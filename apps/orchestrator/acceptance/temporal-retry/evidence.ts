import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { operationId, type Binding } from '@/apps/worker/protocol.ts';
import { executionBindingDigest } from '@/apps/orchestrator/execution-service/types.ts';

export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;
export type BusinessEvidence = {
    run: SqlRow;
    results: SqlRow[];
    checkpoints: SqlRow[];
    exits: SqlRow[];
    projectionEnds: SqlRow[];
    events: SqlRow[];
    retryAttempts: SqlRow[];
    dispatches: SqlRow[];
    session: SqlRow;
    operations: SqlRow[];
    receiptBytes: string;
    exitBytes: string;
    workspaceText: string;
    workerCalls: SqlRow[];
};
export type TemporalEvidence = {
    schema: 1;
    workflowId: string;
    executionRunId: string;
    workflowType: string;
    taskQueue: string;
    status: 'running' | 'completed' | 'other';
    workflowInput: { count: number; runId: string };
    workflowStarted: number;
    workflowCompleted: number;
    workflowFailed: number;
    continuations: number;
    scheduled: {
        eventId: string;
        activityType: string;
        taskQueue: string;
        input: { count: number; runId: string };
    }[];
    started: { eventId: string; scheduledEventId: string; attempt: number }[];
    completed: { scheduledEventId: string; startedEventId: string }[];
    pending: { activityId: string; attempt: number; started: boolean }[];
    historySha256: string;
};
export const sha256 = (value: string) =>
    createHash('sha256').update(value).digest('hex');
const rows = (db: DatabaseSync, sql: string, id: string) =>
    db
        .prepare(sql)
        .all(id)
        .map((row) => ({ ...row }) as SqlRow);
export async function captureBusiness(
    state: string,
    volume: string,
    taskId: string,
    runId: string,
): Promise<BusinessEvidence> {
    const business = new DatabaseSync(join(state, 'business.sqlite'), {
        readOnly: true,
    });
    let run: SqlRow,
        results: SqlRow[],
        checkpoints: SqlRow[],
        exits: SqlRow[],
        projectionEnds: SqlRow[],
        events: SqlRow[],
        retryAttempts: SqlRow[],
        dispatches: SqlRow[];
    try {
        business.exec('BEGIN');
        const runs = rows(business, 'SELECT * FROM runs WHERE id=?', runId);
        assert.equal(runs.length, 1);
        run = runs[0]!;
        results = rows(
            business,
            'SELECT * FROM task_run_results WHERE runId=?',
            runId,
        );
        checkpoints = rows(
            business,
            'SELECT * FROM task_run_checkpoints WHERE runId=?',
            runId,
        );
        exits = rows(
            business,
            'SELECT * FROM worker_exit WHERE runId=?',
            runId,
        );
        projectionEnds = rows(
            business,
            'SELECT * FROM task_projection_ends WHERE runId=?',
            runId,
        );
        events = rows(
            business,
            'SELECT * FROM task_events WHERE runId=? ORDER BY sequence',
            runId,
        );
        retryAttempts = rows(
            business,
            'SELECT * FROM retry_attempts WHERE taskId=? ORDER BY id',
            taskId,
        );
        dispatches = rows(
            business,
            'SELECT * FROM run_dispatches WHERE runId=?',
            runId,
        );
        business.exec('COMMIT');
    } finally {
        business.close();
    }
    const authority = new DatabaseSync(join(state, 'authority.sqlite'), {
        readOnly: true,
    });
    let session: SqlRow, operations: SqlRow[];
    try {
        authority.exec('BEGIN');
        const found = rows(
            authority,
            'SELECT session,tenant,project,sandbox,volume,generation,state,run,(capability IS NOT NULL) AS hasCapability FROM execution_sessions WHERE session=?',
            String(run.sessionId),
        );
        assert.equal(found.length, 1);
        session = found[0]!;
        operations = rows(
            authority,
            'SELECT session,generation,id,digest,state FROM operations WHERE session=? ORDER BY id',
            String(run.sessionId),
        );
        authority.exec('COMMIT');
    } finally {
        authority.close();
    }
    const project = join(volume, taskId),
        target = await readlink(join(project, 'task-volume'));
    assert.match(
        target,
        /^volume-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const actual = await realpath(join(project, target));
    assert.equal(actual, join(await realpath(project), target));
    const suffix = runId + '.' + run.admittedGeneration + '.json';
    const [receiptBytes, exitBytes, workspaceText, calls] = await Promise.all([
        readFile(join(project, 'writes', suffix), 'utf8'),
        readFile(join(project, 'exits', suffix), 'utf8'),
        readFile(join(actual, 'README.md'), 'utf8'),
        readFile(join(state, 'worker-calls.ndjson'), 'utf8'),
    ]);
    const workerCalls = calls
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SqlRow);
    const evidence = {
        run,
        results,
        checkpoints,
        exits,
        projectionEnds,
        events,
        retryAttempts,
        dispatches,
        session,
        operations,
        receiptBytes,
        exitBytes,
        workspaceText,
        workerCalls,
    };
    assertNormal(evidence, taskId, runId);
    return evidence;
}
function assertNormal(e: BusinessEvidence, taskId: string, runId: string) {
    const run = e.run;
    assert.equal(run.id, runId);
    assert.equal(run.projectId, taskId);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.receipt, 1);
    assert.equal(run.taskSequence, 1);
    assert.equal(run.retryOf, null);
    assert.equal(run.admittedGeneration, 1);
    for (const list of [e.results, e.checkpoints, e.exits, e.projectionEnds])
        assert.equal(list.length, 1);
    assert.equal(e.retryAttempts.length, 0);
    assert.equal(e.session.state, 'READY');
    assert.equal(e.session.run, null);
    assert.equal(e.session.hasCapability, 0);
    assert.equal(e.session.generation, 2);
    assert.equal(e.operations.length, 1);
    const binding: Binding = {
        tenant: String(e.session.tenant),
        project: String(e.session.project),
        session: String(e.session.session),
        sandbox: String(e.session.sandbox),
        volume: String(e.session.volume),
    };
    const bindingDigest = executionBindingDigest(binding),
        operation = operationId(runId, 'local-demo');
    assert.equal(run.admittedBindingDigest, bindingDigest);
    assert.deepEqual(e.operations[0], {
        session: run.sessionId,
        generation: 1,
        id: operation,
        digest: sha256(sha256(String(run.prompt))),
        state: 'UNKNOWN',
    });
    const receipt = JSON.parse(e.receiptBytes) as Record<string, unknown>;
    assert.deepEqual(receipt, {
        sessionId: run.sessionId,
        runId,
        generation: 1,
        bindingDigest,
        operationId: operation,
        inputDigest: sha256(String(run.prompt)),
        relativePath: 'README.md',
        fileSha256: sha256(e.workspaceText),
    });
    const exit = JSON.parse(e.exitBytes) as Record<string, unknown>;
    assert.deepEqual(Object.keys(exit).sort(), [
        'bindingDigest',
        'exitedAt',
        'generation',
        'runId',
        'sessionId',
    ]);
    assert.equal(exit.sessionId, run.sessionId);
    assert.equal(exit.runId, runId);
    assert.equal(exit.generation, 1);
    assert.equal(exit.bindingDigest, bindingDigest);
    assert(Number.isFinite(Date.parse(String(exit.exitedAt))));
    assert.equal(e.exits[0]!.generation, 1);
    assert.equal(e.exits[0]!.bindingDigest, bindingDigest);
    assert.equal(e.exits[0]!.exitedAt, exit.exitedAt);
    assert.equal(e.workspaceText, '# Fixture\n' + String(run.prompt) + '\n');
    assert.equal(
        e.workspaceText.split('\n').filter((line) => line === run.prompt)
            .length,
        1,
    );
    assert.deepEqual(e.workerCalls, [
        {
            schema: 1,
            runId,
            sessionId: run.sessionId,
            generation: 1,
            mode: 'execute',
            bindingDigest,
        },
    ]);
    const result = JSON.parse(String(e.results[0]!.body)) as Record<
        string,
        unknown
    >;
    assert.equal(result.version, 1);
    assert.equal(result.summary, 'Run completed.');
    assert.deepEqual(result.checks, []);
    assert.equal(
        result.afterSha256,
        sha256(JSON.stringify([{ path: 'README.md', text: e.workspaceText }])),
    );
    assert.equal(
        result.initialSha256,
        sha256(JSON.stringify([{ path: 'README.md', text: '# Fixture\n' }])),
    );
    assert.equal(result.baselineSha256, result.initialSha256);
    assert.equal(result.incrementalSha256, sha256(String(result.incremental)));
    assert.equal(result.cumulativeSha256, sha256(String(result.cumulative)));
}
export function assertOriginal(
    before: BusinessEvidence,
    after: BusinessEvidence,
): void {
    assert.deepEqual(after, before);
}
export function assertTemporal(
    e: TemporalEvidence,
    expected: {
        runId: string;
        queue: string;
        executionId: string;
        retried: boolean;
    },
): void {
    assert.equal(e.schema, 1);
    assert.equal(e.workflowId, 'bento-run-' + expected.runId);
    assert.equal(e.executionRunId, expected.executionId);
    assert.equal(e.workflowType, 'bentoRun');
    assert.equal(e.taskQueue, expected.queue);
    assert.equal(e.status, 'completed');
    assert.deepEqual(e.workflowInput, { count: 1, runId: expected.runId });
    assert.equal(e.workflowStarted, 1);
    assert.equal(e.workflowCompleted, 1);
    assert.equal(e.workflowFailed, 0);
    assert.equal(e.continuations, 0);
    assert.equal(e.scheduled.length, 1);
    const scheduled = e.scheduled[0]!;
    assert.equal(scheduled.activityType, 'advanceRun');
    assert.equal(scheduled.taskQueue, expected.queue);
    assert.deepEqual(scheduled.input, { count: 1, runId: expected.runId });
    const last = e.started.at(-1);
    assert(last);
    assert.equal(last.scheduledEventId, scheduled.eventId);
    if (expected.retried) assert(last.attempt >= 2);
    else assert.equal(last.attempt, 1);
    assert.deepEqual(e.completed, [
        { scheduledEventId: scheduled.eventId, startedEventId: last.eventId },
    ]);
    assert.equal(e.pending.length, 0);
    assert.match(e.historySha256, /^[a-f0-9]{64}$/);
}
