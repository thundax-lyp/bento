import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { conflict, missing } from '../input.ts';
import {
    type Run,
    type Task,
    type TaskEventPayload,
    type TaskResultInput,
    sha256,
    now,
} from './model.ts';

export function taskProjectionStore({
    db,
    write,
    findRun,
    taskRow,
    recoveryGeneration,
    goControl,
    business,
}: {
    db: DatabaseSync;
    write: <T>(action: () => T) => T;
    findRun: (id: string) => Run;
    taskRow: (owner: string, id: string) => Task;
    recoveryGeneration: (id: string) => SQLOutputValue | undefined;
    goControl: string | undefined;
    business: (action: string, input: object) => boolean | number | undefined;
}) {
    function appendTaskEvent(
        taskId: string,
        runId: string,
        eventId: string,
        value: TaskEventPayload,
    ) {
        const body = JSON.stringify(value);
        const prior = db
            .prepare(
                'SELECT runId,body FROM task_events WHERE taskId=? AND eventId=?',
            )
            .get(taskId, eventId);
        if (prior) {
            if (prior.runId !== runId || prior.body !== body)
                throw new Error('Conflicting Task event.');
            return;
        }
        db.prepare(
            'INSERT INTO task_events SELECT ?,COALESCE(MAX(sequence),0)+1,?,?,?,? FROM task_events WHERE taskId=?',
        ).run(taskId, eventId, runId, now(), body, taskId);
    }

    function appendTaskEvents(
        taskId: string,
        runId: string,
        generation: number,
        events: readonly (TaskEventPayload & { offset: number })[],
    ) {
        write(() => {
            const run = findRun(runId);
            if (
                run.projectId !== taskId ||
                run.taskSequence === null ||
                run.admittedGeneration !== generation ||
                run.status !== 'running'
            )
                throw missing();
            const ended = db
                .prepare(
                    'SELECT 1 FROM task_projection_ends WHERE runId=? AND generation=?',
                )
                .get(runId, generation);
            const prefix = runId + ':' + generation + ':';
            const previous = db
                .prepare(
                    `SELECT max(CAST(substr(eventId,?) AS INTEGER)) AS offset
                 FROM task_events WHERE taskId=? AND runId=? AND substr(eventId,1,?)=?`,
                )
                .get(prefix.length + 1, taskId, runId, prefix.length, prefix);
            let highWater =
                typeof previous?.offset === 'number' ? previous.offset : -1;
            const existing = db.prepare(
                'SELECT 1 FROM task_events WHERE taskId=? AND eventId=?',
            );
            for (const { offset, ...value } of events) {
                const eventId = prefix + offset;
                if (!existing.get(taskId, eventId)) {
                    if (ended)
                        throw new Error('Task projection already ended.');
                    if (offset <= highWater)
                        throw new Error(
                            'Task event offset precedes a confirmed event.',
                        );
                    highWater = offset;
                }
                appendTaskEvent(taskId, runId, eventId, value);
            }
            if (events.length === 0)
                db.prepare(
                    'INSERT OR IGNORE INTO task_projection_ends VALUES (?,?)',
                ).run(runId, generation);
        });
    }

    function taskEvents(owner: string, taskId: string, after: number) {
        taskRow(owner, taskId);
        return db
            .prepare(
                'SELECT eventId AS id,sequence,runId,at,body FROM task_events WHERE taskId=? AND sequence>? ORDER BY sequence',
            )
            .all(taskId, after)
            .map((row) => ({
                id: row.id as string,
                sequence: row.sequence as number,
                runId: row.runId as string,
                at: row.at as string,
                ...(JSON.parse(row.body as string) as TaskEventPayload),
            }));
    }

    function publishTaskResult(
        runId: string,
        input: TaskResultInput,
        reviewProof?: string,
    ) {
        const publish = () => {
            const run = findRun(runId);
            if (run.taskSequence === null) throw missing();
            const events = db
                .prepare(
                    'SELECT body FROM task_events WHERE runId=? ORDER BY sequence',
                )
                .all(runId)
                .map(
                    (row) => JSON.parse(row.body as string) as TaskEventPayload,
                );
            const summary =
                events.findLast((event) => event.kind === 'agent_reply')
                    ?.text ?? 'Run completed.';
            const checks = events.flatMap((event) =>
                event.check === null ? [] : [event.check],
            );
            const body = JSON.stringify({
                version: 1,
                baselineSha256: input.baselineSha256,
                initialSha256: input.initialSha256,
                afterSha256: input.afterSha256,
                incremental: input.incremental,
                cumulative: input.cumulative,
                incrementalSha256: sha256(input.incremental),
                cumulativeSha256: sha256(input.cumulative),
                summary,
                checks,
            });
            const prior = db
                .prepare(
                    'SELECT body,createdAt FROM task_run_results WHERE runId=?',
                )
                .get(runId);
            if (prior) {
                if (prior.body !== body)
                    throw new Error('Conflicting Task result.');
                return { ...JSON.parse(body), createdAt: prior.createdAt };
            }
            if (
                run.status !== 'running' &&
                run.status !== 'recovering' &&
                run.status !== 'needs_review'
            )
                throw conflict(
                    'diff_unavailable',
                    'Run cannot publish a result.',
                );
            if (
                reviewProof !== undefined &&
                (run.status !== 'needs_review' ||
                    run.receipt ||
                    !recoveryGeneration(runId))
            )
                throw conflict(
                    'review_unavailable',
                    'Run is not awaiting recovery review.',
                );
            const createdAt = now();
            if (goControl) {
                business('publish-result', {
                    run: runId,
                    summary,
                    diff: input.incremental,
                    body,
                    proof: reviewProof ?? '',
                    createdAt,
                });
                return { ...JSON.parse(body), createdAt };
            }
            db.prepare('INSERT INTO task_run_results VALUES (?,?,?)').run(
                runId,
                body,
                createdAt,
            );
            db.prepare(
                "UPDATE runs SET status='succeeded',summary=?,diff=?,updatedAt=? WHERE id=?",
            ).run(summary, input.incremental, createdAt, runId);
            if (reviewProof !== undefined)
                db.prepare('INSERT INTO run_reviews VALUES (?,?,?)').run(
                    runId,
                    reviewProof,
                    createdAt,
                );
            return { ...JSON.parse(body), createdAt };
        };
        return goControl ? publish() : write(publish);
    }

    function taskResultRow(runId: string) {
        const row = db
            .prepare(
                'SELECT body,createdAt FROM task_run_results WHERE runId=?',
            )
            .get(runId);
        if (!row) return null;
        type Result = TaskResultInput & {
            version: 1;
            summary: string;
            checks: NonNullable<TaskEventPayload['check']>[];
            incrementalSha256: string;
            cumulativeSha256: string;
        };
        return {
            ...(JSON.parse(row.body as string) as Result),
            createdAt: row.createdAt as string,
        };
    }

    return {
        appendTaskEvent,
        appendTaskEvents,
        taskEvents,
        publishTaskResult,
        taskResultRow,
    };
}
