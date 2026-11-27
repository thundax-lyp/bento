import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { conflict, missing, RequestError } from '../input.ts';
import {
    type Project,
    type Run,
    projectView,
    runView,
    now,
    pending,
    projectBinding,
    queueFull,
} from './model.ts';
import type { Binding, FileText, RunStatus } from '../types.ts';

export function runStore({
    db,
    business,
    goControl,
    tenantQueueLimit,
    requireTaskRunApproval,
    write,
    ownedProject,
    isProjectDeleting,
    project: readProject,
    requireOpenOwner,
    inputDeletionHeld,
    hasQueueCapacity,
    taskRunRow,
}: {
    db: DatabaseSync;
    business: (action: string, input: object) => boolean | number | undefined;
    goControl: string | undefined;
    tenantQueueLimit: number;
    requireTaskRunApproval: boolean;
    write: <T>(action: () => T) => T;
    ownedProject: (owner: string, id: string, allowTask?: boolean) => Project;
    isProjectDeleting: (id: string) => boolean;
    project: (owner: string, id: string) => ReturnType<typeof projectView>;
    requireOpenOwner: (owner: string) => void;
    inputDeletionHeld: (projectId: string) => boolean;
    hasQueueCapacity: (owner: string) => boolean;
    taskRunRow: (owner: string, id: string, runId: string) => Run;
}) {
    function requireRunProject(owner: string, projectId: string): void {
        ownedProject(owner, projectId);
        if (isProjectDeleting(projectId) || inputDeletionHeld(projectId))
            throw conflict('project_busy', 'Project deletion is in progress.');
    }

    function hasPendingProjectRun(projectId: string) {
        return !!db
            .prepare(
                `SELECT 1 FROM runs WHERE projectId=? AND status IN ${pending}`,
            )
            .get(projectId);
    }

    function addRun(
        owner: string,
        projectId: string,
        key: string,
        prompt: string,
        sessionId?: string,
        validateSession?: (binding: Binding) => void,
    ) {
        const enqueue = () =>
            enqueueRun(
                owner,
                projectId,
                key,
                prompt,
                false,
                sessionId,
                validateSession,
            );
        return goControl ? enqueue() : write(enqueue);
    }

    function addDiagnosticRun(
        owner: string,
        project: string,
        key: string,
        prompt: string,
        validateSession?: (binding: Binding) => void,
    ) {
        const enqueue = () => {
            const result = enqueueRun(
                owner,
                project,
                key,
                prompt,
                false,
                undefined,
                validateSession,
                true,
            );
            if (result.replay) diagnosticRun(owner, project, result.run.id);
            else if (!goControl)
                db.prepare(
                    'INSERT INTO admin_diagnostic_runs (runId) VALUES (?)',
                ).run(result.run.id);
            return result;
        };
        return goControl ? enqueue() : write(enqueue);
    }

    function diagnosticRun(owner: string, project: string, id: string) {
        const run = ownedRun(owner, project, id);
        if (
            !db
                .prepare('SELECT 1 FROM admin_diagnostic_runs WHERE runId=?')
                .get(id)
        )
            throw missing();
        return runView(run);
    }

    function enqueueRun(
        owner: string,
        projectId: string,
        key: string,
        prompt: string,
        task = false,
        sessionId?: string,
        validateSession?: (binding: Binding) => void,
        diagnostic = false,
    ) {
        if (!task) requireRunProject(owner, projectId);
        requireOpenOwner(owner);
        const project = ownedProject(owner, projectId, task);
        const selectedSession = sessionId ?? project.sessionId;
        const previous = db
            .prepare('SELECT * FROM runs WHERE projectId=? AND key=?')
            .get(projectId, key) as Run | undefined;
        if (previous) {
            if (
                previous.prompt !== prompt ||
                previous.sessionId !== selectedSession
            )
                throw conflict(
                    'idempotency_conflict',
                    'Idempotency-Key already belongs to a different input.',
                );
            return { replay: true, run: runView(previous) };
        }
        if (
            db
                .prepare(
                    "SELECT 1 FROM file_delete_holds WHERE projectId=? AND state='held'",
                )
                .get(projectId)
        )
            throw conflict('project_busy', 'A project file is being deleted.');
        if (project.status !== 'ready')
            throw conflict('project_not_ready', 'Project is not ready.');
        if (
            db
                .prepare(
                    `SELECT 1 FROM runs WHERE projectId=? AND status IN ${pending}`,
                )
                .get(projectId)
        )
            throw conflict(
                'project_busy',
                'Project already has an unfinished Run.',
            );
        validateSession?.({
            ...projectBinding(project),
            session: selectedSession,
        });
        const id = randomUUID();
        const created = now();
        if (goControl) {
            if (
                business('enqueue', {
                    run: id,
                    session: selectedSession,
                    project: projectId,
                    owner,
                    key,
                    prompt,
                    task,
                    diagnostic,
                    requireApproval: task && requireTaskRunApproval,
                    body: task
                        ? JSON.stringify({
                              kind: 'user_message',
                              text: prompt,
                              check: null,
                          })
                        : '',
                    queueLimit: tenantQueueLimit,
                }) !== true
            )
                throw queueFull();
            return { replay: false, run: runView(findRun(id)) };
        }
        const result = db
            .prepare(
                `
                INSERT INTO runs(id,projectId,sessionId,key,prompt,status,createdAt,updatedAt)
                SELECT ?,?,?,?,?,'queued',?,?
                WHERE ?
            `,
            )
            .run(
                id,
                projectId,
                selectedSession,
                key,
                prompt,
                created,
                created,
                Number(hasQueueCapacity(owner)),
            );
        if (result.changes !== 1)
            throw new RequestError(
                429,
                'tenant_queue_full',
                'Tenant queue is full. Retry after a Run is claimed.',
            );
        return { replay: false, run: runView(findRun(id)) };
    }

    function findRun(id: string) {
        const row = db.prepare('SELECT * FROM runs WHERE id=?').get(id);
        if (!row) throw missing();
        return row as Run;
    }

    function ownedRun(owner: string, project: string, id: string) {
        readProject(owner, project);
        const row = db
            .prepare('SELECT * FROM runs WHERE id=? AND projectId=?')
            .get(id, project);
        if (!row) throw missing();
        return row as Run;
    }

    function runs(owner: string, project: string) {
        readProject(owner, project);
        return (
            db
                .prepare('SELECT * FROM runs WHERE projectId=? ORDER BY rowid')
                .all(project) as Run[]
        ).map(runView);
    }

    function readRun(owner: string, project: string, id: string) {
        const run = ownedRun(owner, project, id);
        return { ...runView(run), prompt: run.prompt };
    }

    function cancelQueuedRun(
        owner: string,
        project: string,
        id: string,
        task = false,
    ) {
        if (goControl) {
            const current = task
                ? taskRunRow(owner, project, id)
                : ownedRun(owner, project, id);
            if (
                current.status !== 'cancelled' &&
                business('cancel-queued', { run: id, project }) !== true
            )
                throw conflict(
                    'run_not_cancellable',
                    'The Run cannot be cancelled in its current state.',
                );
            return { ...runView(findRun(id)), prompt: current.prompt };
        }
        db.exec('BEGIN IMMEDIATE');
        try {
            const current = task
                ? taskRunRow(owner, project, id)
                : ownedRun(owner, project, id);
            if (current.status !== 'cancelled') {
                const result = db
                    .prepare(
                        "UPDATE runs SET status='cancelled', summary=?, updatedAt=? WHERE id=? AND projectId=? AND status IN ('queued','pending_approval')",
                    )
                    .run('Cancelled before start.', now(), id, project);
                if (result.changes !== 1)
                    throw conflict(
                        'run_not_cancellable',
                        'The Run cannot be cancelled in its current state.',
                    );
            }
            const run = task
                ? { ...runView(findRun(id)), prompt: current.prompt }
                : readRun(owner, project, id);
            db.exec('COMMIT');
            return run;
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    function requestRunningCancellation(
        owner: string,
        project: string,
        id: string,
        generation: number,
        task = false,
    ) {
        if (goControl) {
            const current = task
                ? taskRunRow(owner, project, id)
                : ownedRun(owner, project, id);
            if (
                (current.cancelGeneration === null ||
                    !['cancelling', 'cancelled', 'needs_review'].includes(
                        current.status,
                    )) &&
                business('request-cancel', {
                    run: id,
                    project,
                    generation,
                }) !== true
            )
                throw conflict(
                    'run_not_cancellable',
                    'The Run cannot be cancelled in its current state.',
                );
            return { ...runView(findRun(id)), prompt: current.prompt };
        }
        db.exec('BEGIN IMMEDIATE');
        try {
            const current = task
                ? taskRunRow(owner, project, id)
                : ownedRun(owner, project, id);
            if (
                current.cancelGeneration === null ||
                !['cancelling', 'cancelled', 'needs_review'].includes(
                    current.status,
                )
            ) {
                const result = db
                    .prepare(
                        "UPDATE runs SET status='cancelling', cancelGeneration=?, cancelWorkerClosed=?, summary=?, updatedAt=? WHERE id=? AND projectId=? AND status='running' AND receipt=0",
                    )
                    .run(
                        generation,
                        generation === 0 ? 1 : 0,
                        'Cancellation requested.',
                        now(),
                        id,
                        project,
                    );
                if (result.changes !== 1)
                    throw conflict(
                        'run_not_cancellable',
                        'The Run cannot be cancelled in its current state.',
                    );
            }
            const run = task
                ? { ...runView(findRun(id)), prompt: current.prompt }
                : readRun(owner, project, id);
            db.exec('COMMIT');
            return run;
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    function markCancellationWorkerClosed(
        id: string,
        generation: number,
    ): void {
        if (business('cancel-closed', { run: id, generation }) !== undefined)
            return;
        db.prepare(
            "UPDATE runs SET cancelWorkerClosed=1 WHERE id=? AND cancelGeneration=? AND status='cancelling'",
        ).run(id, generation);
    }

    function finishCancellation(
        id: string,
        generation: number,
        status: 'cancelled' | 'needs_review',
    ): boolean {
        const summary =
            status === 'cancelled'
                ? 'Run stopped and cancelled.'
                : '旧执行已停止，操作结果未确认，等待核对。';
        const result = business('finish-cancel', {
            run: id,
            generation,
            status,
            summary,
        });
        if (result !== undefined) return result === true;
        return (
            db
                .prepare(
                    "UPDATE runs SET status=?, summary=?, updatedAt=?, diff=NULL WHERE id=? AND cancelGeneration=? AND status='cancelling' AND cancelWorkerClosed=1",
                )
                .run(status, summary, now(), id, generation).changes === 1
        );
    }

    function failQueuedBaseline(id: string): void {
        if (business('fail-baseline', { run: id }) !== undefined) return;
        db.prepare(
            "UPDATE runs SET status='failed', summary=?, updatedAt=? WHERE id=? AND status='queued'",
        ).run('Workspace baseline could not be captured.', now(), id);
    }

    function diff(owner: string, project: string, id: string) {
        const row = ownedRun(owner, project, id);
        if (row.status !== 'succeeded' || row.diff === null)
            throw conflict(
                'diff_unavailable',
                'The Run result is not available.',
            );
        return row.diff;
    }

    function reserveDispatch(id: string, slots: number) {
        const result = business('reserve', { run: id, slots });
        if (result !== undefined) return result === true;
        return (
            db
                .prepare(
                    `
            WITH occupied AS (
                SELECT p.owner, r.status FROM runs r JOIN projects p ON p.id=r.projectId
                LEFT JOIN run_dispatches d ON d.runId=r.id
                WHERE r.status IN ('running','recovering','cancelling')
                   OR (r.status='queued' AND d.runId IS NOT NULL)
            )
            INSERT INTO run_dispatches(runId)
            SELECT r.id FROM runs r JOIN projects p ON p.id=r.projectId
            WHERE r.id=? AND r.status='queued'
                AND NOT EXISTS (SELECT 1 FROM run_dispatches d WHERE d.runId=r.id)
                AND NOT EXISTS (
                    SELECT 1 FROM occupied o WHERE o.owner=p.owner AND o.status='queued'
                )
                AND (SELECT COUNT(*) FROM occupied) < ?
        `,
                )
                .run(id, slots).changes === 1
        );
    }

    function dispatchReserved(id: string) {
        return (
            db.prepare('SELECT 1 FROM run_dispatches WHERE runId=?').get(id) !==
            undefined
        );
    }

    function next(status: 'active' | 'queued') {
        const condition =
            status === 'active'
                ? "IN ('running','recovering','cancelling')"
                : "= 'queued'";
        return db
            .prepare(
                `SELECT * FROM runs WHERE status ${condition} ORDER BY rowid LIMIT 1`,
            )
            .get() as Run | undefined;
    }

    function binding(run: Run) {
        const row = db
            .prepare('SELECT * FROM projects WHERE id=?')
            .get(run.projectId) as Project;
        return projectBinding(row);
    }

    function pendingCapture() {
        return db
            .prepare(
                `SELECT * FROM runs WHERE status='needs_review' AND receipt=1
                 ORDER BY updatedAt, rowid LIMIT 1`,
            )
            .get() as Run | undefined;
    }

    function start(id: string, baseline: readonly FileText[], slots: number) {
        const result = business('start', {
            run: id,
            baseline: JSON.stringify(baseline),
            slots,
        });
        if (result !== undefined) return result === true;
        return (
            db
                .prepare(
                    `
                UPDATE runs SET status='running', baseline=?, updatedAt=?
                WHERE id=? AND status='queued'
                    AND (SELECT COUNT(*) FROM runs WHERE status IN ('running','recovering','cancelling')) < ?
            `,
                )
                .run(JSON.stringify(baseline), now(), id, slots).changes === 1
        );
    }

    function received(id: string) {
        if (business('receipt', { run: id }) !== undefined) return;
        db.prepare(
            "UPDATE runs SET receipt=1, updatedAt=? WHERE id=? AND status='running'",
        ).run(now(), id);
    }

    function reconciled(id: string) {
        if (business('reconcile', { run: id }) !== undefined) return;
        db.prepare(
            "UPDATE runs SET reconciled=1, updatedAt=? WHERE id=? AND status='recovering'",
        ).run(now(), id);
    }

    function recovered(id: string, generation: number) {
        if (business('recovered', { run: id, generation }) !== undefined)
            return;
        db.prepare('INSERT INTO run_recoveries VALUES (?,?)').run(
            id,
            generation,
        );
    }

    function recoveryGeneration(id: string) {
        return db
            .prepare('SELECT generation FROM run_recoveries WHERE runId=?')
            .get(id)?.generation;
    }

    function status(
        id: string,
        status: RunStatus,
        summary: string,
        diff: string | null = null,
    ) {
        if (
            business('status', { run: id, status, summary, diff }) !== undefined
        )
            return;
        db.prepare(
            'UPDATE runs SET status=?, summary=?, diff=?, updatedAt=? WHERE id=?',
        ).run(status, summary, diff, now(), id);
    }

    function reviewReceipt(id: string, proof: string) {
        const row = db
            .prepare('SELECT proof FROM run_reviews WHERE runId=?')
            .get(id);
        if (row && row.proof !== proof)
            throw conflict(
                'review_conflict',
                'A different review was already recorded.',
            );
        return row !== undefined;
    }

    function confirmReview(id: string, proof: string, diff: string) {
        if (goControl) {
            if (!reviewReceipt(id, proof))
                business('confirm-review', {
                    run: id,
                    proof,
                    diff,
                    createdAt: now(),
                });
            return;
        }
        db.exec('BEGIN IMMEDIATE');
        try {
            if (!reviewReceipt(id, proof)) {
                const time = now();
                const result = db
                    .prepare(
                        `
                    UPDATE runs SET status='succeeded', diff=?, updatedAt=?,
                        summary='Workspace changes verified after recovery.'
                    WHERE id=? AND status='needs_review' AND receipt=0
                        AND EXISTS(SELECT 1 FROM run_recoveries WHERE runId=runs.id)
                `,
                    )
                    .run(diff, time, id);
                if (Number(result.changes) !== 1)
                    throw conflict(
                        'review_unavailable',
                        'Run is not awaiting recovery review.',
                    );
                db.prepare('INSERT INTO run_reviews VALUES (?,?,?)').run(
                    id,
                    proof,
                    time,
                );
            }
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    function readPhysicalStopProof(runId: string, generation: number) {
        return db
            .prepare(
                'SELECT canonicalJson,sha256 FROM physical_stop_proofs WHERE runId=? AND generation=?',
            )
            .get(runId, generation);
    }

    function recordPhysicalStopProof(
        runId: string,
        generation: number,
        canonicalJson: string,
    ) {
        const digest = createHash('sha256').update(canonicalJson).digest('hex');
        db.prepare('INSERT INTO physical_stop_proofs VALUES (?,?,?,?)').run(
            runId,
            generation,
            canonicalJson,
            digest,
        );
    }

    function completeAmbiguousRecovery(
        id: string,
        generation: number,
        summary: string,
    ) {
        if (
            business('complete-ambiguous', {
                run: id,
                generation,
                summary,
            }) !== undefined
        )
            return;
        write(() => {
            const proof = readPhysicalStopProof(id, generation);
            if (
                !proof ||
                proof.sha256 !==
                    createHash('sha256')
                        .update(String(proof.canonicalJson))
                        .digest('hex')
            )
                throw new Error('Physical stop proof is unavailable');
            db.prepare(
                "INSERT OR IGNORE INTO physical_stop_consumption VALUES (?,?,'slot',?)",
            ).run(id, generation, proof.sha256);
            status(id, 'needs_review', summary);
        });
    }

    function consumeUpgradeStops() {
        const result = business('drain', {});
        if (result !== undefined) return result === true;
        return write(() => {
            const pending = db
                .prepare(
                    `SELECT 1 FROM runs
                     WHERE status IN ('running','recovering','cancelling')
                     UNION ALL
                     SELECT 1 FROM physical_stop_proofs p
                     WHERE NOT EXISTS (
                         SELECT 1 FROM physical_stop_consumption c
                         WHERE c.runId=p.runId AND c.generation=p.generation
                           AND c.consumer='slot' AND c.sha256=p.sha256
                     ) LIMIT 1`,
                )
                .get();
            if (pending) return false;
            db.exec(
                `INSERT OR IGNORE INTO physical_stop_consumption
                 SELECT runId,generation,'upgrade',sha256
                 FROM physical_stop_consumption WHERE consumer='slot'`,
            );
            return true;
        });
    }

    return {
        readPhysicalStopProof,
        recordPhysicalStopProof,
        completeAmbiguousRecovery,
        consumeUpgradeStops,

        requireRunProject,
        hasPendingProjectRun,
        addRun,
        addDiagnosticRun,
        diagnosticRun,
        enqueueRun,
        findRun,
        runs,
        run: readRun,
        cancelQueuedRun,
        requestRunningCancellation,
        markCancellationWorkerClosed,
        finishCancellation,
        failQueuedBaseline,
        diff,
        reserveDispatch,
        dispatchReserved,
        next,
        binding,
        pendingCapture,
        start,
        received,
        reconciled,
        recovered,
        recoveryGeneration,
        status,
        reviewReceipt,
        confirmReview,
    };
}
