import type { SingleHostExecution } from '../openshell/single-host.ts';
import type { Store } from './store/index.ts';
import type { taskEventProjection } from './task-event-projection.ts';
import type { trustedRunReview } from './trusted-run-review.ts';
import {
    executionBindingDigest,
    type Binding,
    type ExecutionHost,
    type WorkerRequest,
    type WorkerResult,
} from './types.ts';

type Run = ReturnType<Store['findRun']>;
export type WorkerAttempt = {
    generation: number;
    abort: AbortController;
    exitConfirmed: boolean;
};

export function executionWorker({
    db,
    execution,
    host,
    live,
    executing,
    stopSignal,
    workerTimeoutMs,
    ingress,
    projection,
    supportsCancellation,
    taskExit,
    usesWarmWorker,
}: {
    db: Store;
    execution: SingleHostExecution;
    host: ExecutionHost;
    live: Map<string, WorkerRequest['mode']>;
    executing: Map<string, WorkerAttempt>;
    stopSignal: AbortSignal;
    workerTimeoutMs: number;
    ingress: Pick<WorkerRequest, 'persistenceUrl' | 'operationUrl' | 'gateway'>;
    projection: ReturnType<typeof taskEventProjection>;
    supportsCancellation: (run: Run) => boolean;
    taskExit: ReturnType<typeof trustedRunReview>['taskExit'];
    usesWarmWorker: () => boolean;
}) {
    async function worker(
        run: Run,
        binding: Binding,
        mode: WorkerRequest['mode'],
        slot: number,
        activitySignal?: AbortSignal,
    ) {
        activitySignal?.throwIfAborted();
        const current = execution.inspect(binding.session);
        if (run.taskSequence !== null && mode === 'execute') {
            if (
                run.expectedGeneration !== null &&
                run.expectedGeneration !== current.generation
            )
                throw new Error('Queued retry generation changed');
            db.recordTaskAdmission(
                run.id,
                current.generation,
                executionBindingDigest(binding),
            );
        }
        const grant = execution.admit(
            binding.session,
            current.generation,
            run.id,
            workerTimeoutMs,
        );
        live.set(grant.token, mode);
        const attempt =
            mode === 'execute'
                ? {
                      generation: grant.generation,
                      abort: new AbortController(),
                      exitConfirmed: false,
                  }
                : undefined;
        if (attempt) executing.set(run.id, attempt);
        const onWorkerExit =
            attempt && supportsCancellation(run)
                ? () => {
                      if (
                          stopSignal.aborted ||
                          executing.get(run.id) !== attempt
                      )
                          return;
                      attempt.exitConfirmed = true;
                      if (run.taskSequence !== null) {
                          if (host.observeWorkerExit) {
                              void taskExit(
                                  db.findRun(run.id),
                                  binding,
                                  grant.generation,
                              ).catch(() => {});
                          } else {
                              db.recordTaskExit(
                                  run.id,
                                  grant.generation,
                                  executionBindingDigest(binding),
                                  new Date().toISOString(),
                              );
                          }
                      }
                      try {
                          db.markCancellationWorkerClosed(
                              run.id,
                              attempt.generation,
                          );
                      } catch {
                          // Retain the observed exit for the next advancement.
                      }
                  }
                : undefined;
        const executionDeadline = AbortSignal.timeout(workerTimeoutMs);
        const signal = AbortSignal.any([
            stopSignal,
            executionDeadline,
            ...(attempt ? [attempt.abort.signal] : []),
            ...(activitySignal ? [activitySignal] : []),
        ]);
        let onAbort: () => void = () => {};
        const aborted = new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(new Error('Worker lease ended'));
            signal.addEventListener('abort', onAbort, { once: true });
        });
        let task: Promise<WorkerResult> | undefined;
        try {
            signal.throwIfAborted();
            task = host.worker(
                {
                    mode,
                    binding,
                    grant,
                    ...ingress,
                    ...(run.taskSequence !== null && mode === 'execute'
                        ? {
                              publicEventsUrl: new URL(
                                  '/task-events',
                                  ingress.operationUrl,
                              ).href,
                          }
                        : {}),
                    ...(mode === 'execute' ? { prompt: run.prompt } : {}),
                },
                signal,
                slot,
                onWorkerExit,
            );
            const result = await Promise.race([task, aborted]);
            activitySignal?.throwIfAborted();
            if (
                result === 'completed' &&
                run.taskSequence !== null &&
                !projection.ended(grant)
            )
                return 'review';
            return result;
        } finally {
            live.delete(grant.token);
            projection.forget(grant);
            signal.removeEventListener('abort', onAbort);
            const leaseLost =
                activitySignal?.aborted || executionDeadline.aborted;
            try {
                if (leaseLost)
                    await execution.drainAttempt(
                        binding.session,
                        grant.generation,
                        run.id,
                    );
            } finally {
                // Observe launcher shutdown before asking the sandbox to stop.
                if (
                    leaseLost ||
                    (usesWarmWorker() &&
                        signal.aborted &&
                        !attempt?.abort.signal.aborted)
                )
                    await task?.catch(() => {});
            }
        }
    }

    return worker;
}
