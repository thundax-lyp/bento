import type { SingleHostExecution } from '../openshell/single-host.ts';
import type { executionWorker } from './execution-worker.ts';
import type { Store } from './store/index.ts';
import type { Binding, WorkerResult } from './types.ts';

type Run = ReturnType<Store['findRun']>;

export function runRecovery({
    db,
    execution,
    signal,
    supportsPhysicalStop,
    runBinding,
    fence,
    finish,
    stopAndProve,
    worker,
}: {
    db: Store;
    execution: SingleHostExecution;
    signal: AbortSignal;
    supportsPhysicalStop: boolean;
    runBinding: (run: Run) => Binding;
    fence: (run: Run) => Promise<void>;
    finish: (run: Run) => Promise<void>;
    stopAndProve: (run: Run) => Promise<boolean>;
    worker: ReturnType<typeof executionWorker>;
}) {
    async function settle(
        run: Run,
        slot: number,
        activitySignal?: AbortSignal,
    ) {
        if (!run.receipt && run.status !== 'recovering')
            db.status(
                run.id,
                'recovering',
                'Recovering the execution session.',
            );
        await fence(run);
        if (signal.aborted) return;
        if (run.receipt) {
            await finish(run);
            return;
        }
        if (run.taskSequence !== null) {
            try {
                if (await stopAndProve(run)) {
                    db.status(
                        run.id,
                        'failed',
                        'Run stopped before completion.',
                    );
                    return;
                }
            } catch {
                // Evidence mismatch cannot turn an ambiguous result into a failure.
            }
        }
        if (activitySignal?.aborted) {
            completeReview(
                run,
                'Temporal execution lease lost. Waiting for review.',
            );
        } else if (!run.reconciled) {
            // The attempt is durable before admission. A recovery worker is never given the original prompt.
            db.reconciled(run.id);
            let result: WorkerResult | undefined;
            try {
                result = await worker(
                    run,
                    runBinding(run),
                    'recover',
                    slot,
                    activitySignal,
                );
            } catch {
                // The prior operation and any interrupted reconciliation stay subject to trusted review.
            }
            if (signal.aborted) return;
            if (result === 'recovered')
                db.recovered(
                    run.id,
                    execution.inspect(run.sessionId).generation,
                );
            await fence(run);
            completeReview(
                run,
                result === 'recovered'
                    ? 'Previous execution outcome is unknown. Waiting for review.'
                    : 'Recovery could not be confirmed. Waiting for review.',
            );
        } else {
            completeReview(
                run,
                'Recovery was interrupted. Waiting for review.',
            );
        }
    }

    function completeReview(run: Run, summary: string) {
        const generation = run.admittedGeneration;
        if (
            generation !== null &&
            (db.readPhysicalStopProof(run.id, generation) ||
                (supportsPhysicalStop &&
                    execution.hasUnknownOperations(run.sessionId, generation)))
        ) {
            db.completeAmbiguousRecovery(run.id, generation, summary);
            return;
        }
        db.status(run.id, 'needs_review', summary);
    }

    return settle;
}
