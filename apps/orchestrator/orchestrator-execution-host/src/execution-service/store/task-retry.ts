import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { conflict, missing } from '../input.ts';
import {
    type Run,
    type Task,
    type ConfirmedRetryPhase,
    type RetryEvidence,
    type RetryAttempt,
    hashJson,
    idempotencyConflict,
    queueFull,
    pendingRetries,
    now,
} from './model.ts';
import type { Store } from './index.ts';
import type { taskProjectionStore } from './task-projection.ts';

export function taskRetryStore({
    db,
    write,
    taskRow,
    findRun,
    readStopProof,
    taskWriteGuard,
    hasQueueCapacity,
    goControl,
    business,
    tenantQueueLimit,
    taskSequence,
    appendTaskEvent,
}: {
    db: DatabaseSync;
    write: <T>(action: () => T) => T;
    taskRow: (owner: string, id: string) => Task;
    findRun: (id: string) => Run;
    readStopProof: Store['readStopProof'];
    taskWriteGuard: (owner: string, task: Task) => void;
    hasQueueCapacity: (owner: string) => boolean;
    goControl: string | undefined;
    business: (action: string, input: object) => boolean | number | undefined;
    tenantQueueLimit: number;
    taskSequence: (id: string) => number;
    appendTaskEvent: ReturnType<typeof taskProjectionStore>['appendTaskEvent'];
}) {
    function retryByKey(taskId: string, key: string) {
        return db
            .prepare('SELECT * FROM retry_attempts WHERE taskId=? AND key=?')
            .get(taskId, key) as RetryAttempt | undefined;
    }

    function acceptTaskRetry(
        owner: string,
        taskId: string,
        sourceRunId: string,
        key: string,
        evidence: RetryEvidence,
    ) {
        const accept = () => {
            const task = taskRow(owner, taskId);
            const source = findRun(sourceRunId);
            if (source.projectId !== taskId) throw missing();
            const hash = hashJson({ op: 'retry', sourceRunId });
            const prior = retryByKey(taskId, key);
            if (prior) {
                if (prior.hash !== hash) throw idempotencyConflict();
                return { replay: true, attempt: prior };
            }
            if (
                db
                    .prepare('SELECT 1 FROM runs WHERE projectId=? AND key=?')
                    .get(taskId, key)
            )
                throw idempotencyConflict();
            if (
                (source.status !== 'failed' && source.status !== 'cancelled') ||
                db
                    .prepare(
                        'SELECT 1 FROM runs WHERE projectId=? AND taskSequence>?',
                    )
                    .get(taskId, source.taskSequence) ||
                db
                    .prepare('SELECT 1 FROM retry_attempts WHERE sourceRunId=?')
                    .get(sourceRunId) ||
                !readStopProof(sourceRunId)
            )
                throw conflict('run_not_retryable', 'Run cannot be retried.');
            taskWriteGuard(owner, task);
            if (!hasQueueCapacity(owner)) throw queueFull();
            const id = randomUUID();
            const newRunId = randomUUID();
            const at = now();
            if (goControl) {
                if (
                    business('accept-retry', {
                        run: newRunId,
                        attempt: id,
                        project: taskId,
                        owner,
                        sourceRun: sourceRunId,
                        key,
                        proof: hash,
                        generation: evidence.oldGeneration,
                        newGeneration: evidence.newGeneration,
                        workspaceSHA256: evidence.workspaceSha256,
                        historySHA256: evidence.historySha256,
                        queueLimit: tenantQueueLimit,
                    }) !== true
                )
                    throw queueFull();
                return { replay: false, attempt: taskRetry(id) };
            }
            db.prepare(
                `INSERT INTO retry_attempts
                VALUES (?,?,?,?,?,?,'preparing','preparing',?,?,?,?,NULL,?,?)`,
            ).run(
                id,
                taskId,
                sourceRunId,
                newRunId,
                key,
                hash,
                evidence.oldGeneration,
                evidence.newGeneration,
                evidence.workspaceSha256,
                evidence.historySha256,
                at,
                at,
            );
            return { replay: false, attempt: taskRetry(id) };
        };
        return goControl ? accept() : write(accept);
    }

    function taskRetry(id: string) {
        const attempt = db
            .prepare('SELECT * FROM retry_attempts WHERE id=?')
            .get(id) as RetryAttempt | undefined;
        if (!attempt) throw missing();
        return attempt;
    }

    function advanceTaskRetry(
        id: string,
        expected: ConfirmedRetryPhase,
        phase: 'workspace_restored' | 'history_restored' | 'blocked',
    ) {
        const next: Record<ConfirmedRetryPhase, string | null> = {
            preparing: 'workspace_restored',
            workspace_restored: 'history_restored',
            history_restored: null,
        };
        if (phase !== 'blocked' && next[expected] !== phase) return false;
        return (
            db
                .prepare(
                    'UPDATE retry_attempts SET phase=?,lastConfirmedPhase=?,error=?,updatedAt=? WHERE id=? AND phase=?',
                )
                .run(
                    phase,
                    phase === 'blocked' ? expected : phase,
                    phase === 'blocked' ? 'restore_conflict' : null,
                    now(),
                    id,
                    expected,
                ).changes === 1
        );
    }

    function finalizeTaskRetry(
        id: string,
        phase: 'history_restored' | 'blocked',
    ) {
        if (goControl) {
            const attempt = taskRetry(id);
            if (
                attempt.phase !== 'queued' &&
                (attempt.phase !== phase ||
                    business('finalize-retry', {
                        run: id,
                        status: phase,
                    }) !== true)
            )
                throw conflict('task_busy', 'Retry phase changed.');
            return findRun(attempt.newRunId);
        }
        return write(() => {
            const attempt = taskRetry(id);
            if (attempt.phase === 'queued') return findRun(attempt.newRunId);
            if (attempt.phase !== phase)
                throw conflict('task_busy', 'Retry phase changed.');
            const source = findRun(attempt.sourceRunId);
            const time = now();
            db.prepare(
                `INSERT INTO runs(id,projectId,sessionId,key,prompt,status,createdAt,updatedAt,taskSequence,retryOf,expectedGeneration)
                VALUES (?,?,?,?,?,'queued',?,?,?,?,?)`,
            ).run(
                attempt.newRunId,
                attempt.taskId,
                source.sessionId,
                attempt.key,
                source.prompt,
                time,
                time,
                taskSequence(attempt.taskId),
                source.id,
                attempt.newGeneration,
            );
            appendTaskEvent(
                attempt.taskId,
                attempt.newRunId,
                attempt.newRunId + ':retry',
                { kind: 'step', text: 'Retry queued.', check: null },
            );
            db.prepare(
                "UPDATE retry_attempts SET phase='queued',lastConfirmedPhase='history_restored',error=NULL,updatedAt=? WHERE id=?",
            ).run(time, id);
            return findRun(attempt.newRunId);
        });
    }

    function closeBlockedTaskRetry(
        id: string,
        authorityGeneration: number,
        evidenceDigest: string,
    ) {
        return write(() => {
            const prior = readTaskRetryClosure(id);
            if (prior) {
                if (prior.authorityGeneration !== authorityGeneration)
                    throw conflict(
                        'review_unavailable',
                        'Retry evidence changed.',
                    );
                return prior;
            }
            const attempt = taskRetry(id);
            if (
                attempt.phase !== 'blocked' ||
                attempt.newGeneration !== authorityGeneration
            )
                throw conflict(
                    'review_unavailable',
                    'Retry is not awaiting closure.',
                );
            const time = now();
            db.prepare(
                'INSERT INTO task_retry_closure_audit VALUES (?,?,?,?)',
            ).run(id, authorityGeneration, evidenceDigest, time);
            db.prepare(
                "UPDATE retry_attempts SET phase='closed',updatedAt=? WHERE id=?",
            ).run(time, id);
            db.prepare(
                "UPDATE tasks SET closedReason='unconfirmed',updatedAt=? WHERE id=?",
            ).run(time, attempt.taskId);
            return readTaskRetryClosure(id);
        });
    }

    function readTaskRetryClosure(id: string) {
        return db
            .prepare('SELECT * FROM task_retry_closure_audit WHERE attemptId=?')
            .get(id);
    }

    function taskRetryReceipt(id: string, key: string) {
        return retryByKey(id, key);
    }

    function nextTaskRetry(afterRowId: number) {
        return db
            .prepare(
                `SELECT rowid AS rowId,* FROM retry_attempts
            WHERE phase IN ('preparing','workspace_restored','history_restored')
            ORDER BY (rowid<=?),rowid LIMIT 1`,
            )
            .get(afterRowId) as (RetryAttempt & { rowId: number }) | undefined;
    }

    function pendingTaskRetry(taskId: string) {
        return (
            db
                .prepare(
                    `SELECT 1 FROM retry_attempts WHERE taskId=? AND phase IN ${pendingRetries}`,
                )
                .get(taskId) !== undefined
        );
    }

    return {
        acceptTaskRetry,
        taskRetry,
        advanceTaskRetry,
        finalizeTaskRetry,
        closeBlockedTaskRetry,
        readTaskRetryClosure,
        taskRetryReceipt,
        nextTaskRetry,
        pendingTaskRetry,
    };
}
