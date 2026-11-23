import type { SingleHostExecution } from '../openshell/single-host.ts';
import { HistoryCheckpointUnavailable } from '../openshell/session-history.ts';
import { textSnapshot } from './input.ts';
import type { Store } from './store.ts';
import type { Binding, ExecutionHost } from './types.ts';
import { snapshotSha256 } from './snapshot.ts';
type Run = ReturnType<Store['findRun']>;
type Options = {
    db: Store;
    execution: SingleHostExecution;
    host: ExecutionHost;
    readProof(run: Run, oldGeneration: number, newGeneration: number): Binding;
    supportsCancellation(run: Run): boolean;
};
export function taskRunViews({
    db,
    execution,
    host,
    readProof,
    supportsCancellation,
}: Options) {
    function retryReason(run: Run) {
        const task = db.task(db.binding(run).tenant, run.projectId);
        if (task.closedReason) return 'task_closed';
        if (task.status !== 'ready') return 'task_not_ready';
        if (run.status === 'needs_review') return 'needs_review';
        if (db.hasActiveTaskRetry(run.projectId)) return 'task_busy';
        if (
            db.taskRunRows(db.binding(run).tenant, run.projectId).at(-1)?.id !==
            run.id
        )
            return 'not_latest';
        if (run.status !== 'failed' && run.status !== 'cancelled')
            return 'not_terminal';
        if (!host.taskRecovery || !db.readStopProof(run.id))
            return 'stop_unconfirmed';
        const checkpoint = db.taskCheckpoint(run.id);
        if (!checkpoint) return 'checkpoint_unavailable';
        try {
            if (
                snapshotSha256(
                    textSnapshot(JSON.parse(checkpoint.workspace)),
                ) !== checkpoint.workspaceSha256
            )
                return 'checkpoint_unavailable';
        } catch {
            return 'checkpoint_unavailable';
        }
        const oldGeneration = run.admittedGeneration;
        if (oldGeneration === null) return 'stop_unconfirmed';
        let binding: Binding;
        try {
            binding = readProof(run, oldGeneration, oldGeneration + 1);
        } catch {
            return 'stop_unconfirmed';
        }
        try {
            execution.validateRestoreCheckpoint(
                binding.session,
                run.id,
                oldGeneration,
                checkpoint.historySha256,
            );
        } catch (error) {
            if (error instanceof HistoryCheckpointUnavailable)
                return 'checkpoint_unavailable';
            throw error;
        }
        return null;
    }

    function taskRunView(run: Run) {
        const task = db.task(db.binding(run).tenant, run.projectId);
        return {
            id: run.id,
            taskId: run.projectId,
            sequence: run.taskSequence,
            prompt: run.prompt,
            status: run.status,
            retryOf: run.retryOf,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
            summary: run.summary,
            canContinue:
                task.status === 'ready' &&
                !task.closedReason &&
                !db.hasActiveTaskRetry(task.id) &&
                db.taskRunRows(db.binding(run).tenant, task.id).at(-1)?.id ===
                    run.id &&
                (run.status === 'succeeded' ||
                    (run.status === 'cancelled' &&
                        run.admittedGeneration === null)),
            canCancel:
                run.status === 'queued' ||
                (run.status === 'running' &&
                    !run.receipt &&
                    supportsCancellation(run)),
            retryReason: retryReason(run),
            resultVersion: db.taskResultRow(run.id)?.version ?? null,
        };
    }

    return { retryReason, taskRunView };
}
