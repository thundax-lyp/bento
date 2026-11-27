import { operationId } from '@/apps/worker/src/protocol.ts';
import type { SingleHostExecution } from '../openshell/single-host.ts';
import { unifiedDiff } from './diff.ts';
import { conflict, textSnapshot } from './input.ts';
import { snapshotSha256 } from './snapshot.ts';
import type { Store } from './store/index.ts';
import {
    type Binding,
    type ExecutionHost,
    type TaskVolumeStopObservation,
    executionBindingDigest,
    sha256Digest,
} from './types.ts';

import type { taskRetryRecovery } from './task-retry-recovery.ts';

type RetryRecovery = ReturnType<typeof taskRetryRecovery>;
type Run = ReturnType<Store['findRun']>;
type Review = {
    runId: string;
    failedGeneration: number;
    readyGeneration: number;
    expectedSnapshotSha256: string;
} & (
    | { stableOperationId: string; sdkOperationId?: never }
    | { stableOperationId?: never; sdkOperationId: string }
);

export function trustedRunReview({
    db,
    execution,
    host,
    signal,
    runBinding,
    readyBinding,
    readProof,
    isExecuting,
    advancingRetries,
    verifiedStopProof,
    verifyRestoredTask,
    wake,
}: {
    db: Store;
    execution: SingleHostExecution;
    host: ExecutionHost;
    signal: AbortSignal;
    runBinding: (run: Run) => Binding;
    readyBinding: (binding: Binding, generation: number) => boolean;
    readProof: RetryRecovery['readProof'];
    isExecuting: (id: string) => boolean;
    advancingRetries: Set<string>;
    verifiedStopProof: RetryRecovery['verifiedStopProof'];
    verifyRestoredTask: RetryRecovery['verifyRestoredTask'];
    wake: () => void;
}) {
    // Trusted deployment API. No HTTP v1 route exposes this capability.
    async function reviewRun(review: Review) {
        const {
            runId,
            failedGeneration,
            readyGeneration,
            stableOperationId,
            sdkOperationId,
            expectedSnapshotSha256,
        } = review;
        if (
            !Number.isSafeInteger(failedGeneration) ||
            failedGeneration < 1 ||
            !Number.isSafeInteger(readyGeneration) ||
            readyGeneration <= failedGeneration ||
            !/^[0-9a-f]{64}$/.test(expectedSnapshotSha256)
        )
            throw new Error('Invalid review proof');
        let op: string;
        if (sdkOperationId !== undefined) {
            if (
                stableOperationId !== undefined ||
                typeof sdkOperationId !== 'string' ||
                !/^sdk:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(
                    sdkOperationId,
                )
            )
                throw new Error('Invalid review proof');
            op = sdkOperationId;
        } else {
            if (typeof stableOperationId !== 'string' || !stableOperationId)
                throw new Error('Invalid review proof');
            op = operationId(runId, stableOperationId);
        }
        const proof = JSON.stringify({
            failedGeneration,
            readyGeneration,
            operationId: op,
            expectedSnapshotSha256,
        });
        if (db.reviewReceipt(runId, proof)) return;
        const run = db.findRun(runId);
        if (
            run.status !== 'needs_review' ||
            run.receipt ||
            db.recoveryGeneration(runId) !== failedGeneration + 1 ||
            readyGeneration !== failedGeneration + 2
        )
            throw conflict(
                'review_unavailable',
                'Run is not awaiting recovery review.',
            );
        const binding = runBinding(run);
        if (
            sdkOperationId !== undefined &&
            (run.taskSequence === null ||
                run.admittedGeneration !== failedGeneration ||
                run.admittedBindingDigest !== executionBindingDigest(binding))
        )
            throw conflict(
                'review_unavailable',
                'Run execute admission changed.',
            );
        const checkBinding = () => {
            const current = execution.inspect(run.sessionId);
            if (
                current.state !== 'READY' ||
                current.generation !== readyGeneration ||
                current.volume !== binding.volume ||
                current.sandbox !== binding.sandbox ||
                current.project !== binding.project ||
                current.tenant !== binding.tenant ||
                execution.operation(run.sessionId, failedGeneration, op)
                    ?.state !== 'UNKNOWN'
            )
                throw conflict(
                    'review_unavailable',
                    'Run execution or operation evidence changed.',
                );
        };
        checkBinding();
        const after = textSnapshot(await host.snapshot(binding));
        if (snapshotSha256(after) !== expectedSnapshotSha256)
            throw conflict(
                'review_mismatch',
                'Workspace does not match the reviewed snapshot.',
            );
        const diff = await unifiedDiff(
            textSnapshot(JSON.parse(run.baseline ?? 'null')),
            after,
        );
        signal.throwIfAborted();
        if (db.reviewReceipt(runId, proof)) return;
        checkBinding();
        if (run.taskSequence === null) db.confirmReview(runId, proof, diff);
        else {
            const initial = db.taskInitialFiles(run.projectId);
            const cumulative = await unifiedDiff(initial, after);
            signal.throwIfAborted();
            if (db.reviewReceipt(runId, proof)) return;
            checkBinding();
            db.publishTaskResult(
                runId,
                {
                    baselineSha256: snapshotSha256(
                        textSnapshot(JSON.parse(run.baseline ?? 'null')),
                    ),
                    initialSha256: snapshotSha256(initial),
                    afterSha256: expectedSnapshotSha256,
                    incremental: diff,
                    cumulative,
                },
                proof,
            );
        }
    }

    async function taskExit(run: Run, binding: Binding, generation: number) {
        const bindingDigest = executionBindingDigest(binding);
        if (
            run.admittedGeneration !== generation ||
            run.admittedBindingDigest !== bindingDigest
        )
            return undefined;
        const prior = db.taskExit(run.id, generation);
        if (prior)
            return prior.bindingDigest === bindingDigest ? prior : undefined;
        const observed = await host.observeWorkerExit?.(
            binding,
            run.id,
            generation,
        );
        if (
            !observed ||
            observed.sessionId !== binding.session ||
            observed.runId !== run.id ||
            observed.generation !== generation ||
            observed.bindingDigest !== bindingDigest ||
            !Number.isFinite(Date.parse(observed.exitedAt))
        )
            return undefined;
        return db.recordTaskExit(
            run.id,
            generation,
            bindingDigest,
            observed.exitedAt,
        );
    }

    async function reconcileFixtureWrite(
        run: Run,
        binding: Binding,
        generation: number,
    ) {
        const operation = operationId(run.id, 'local-demo');
        if (!execution.operation(binding.session, generation, operation))
            return;
        const receipt = await host.taskRecovery?.readFixtureWriteReceipt?.(
            binding,
            run.id,
            generation,
        );
        if (!receipt) return;
        const inputDigest = sha256Digest(run.prompt);
        const current = textSnapshot(await host.snapshot(binding)).find(
            (file) => file.path === receipt.relativePath,
        );
        if (
            receipt.sessionId !== binding.session ||
            receipt.runId !== run.id ||
            receipt.generation !== generation ||
            receipt.bindingDigest !== executionBindingDigest(binding) ||
            receipt.operationId !== operation ||
            receipt.inputDigest !== inputDigest ||
            !current ||
            sha256Digest(current.text) !== receipt.fileSha256
        )
            throw new Error('Invalid fixture write evidence');
        execution.observeTaskFixtureWrite(
            binding.session,
            generation,
            operation,
            sha256Digest(inputDigest),
        );
    }

    async function stopAndProve(
        run: Run,
        mode: 'settle' | 'observe-ready' = 'settle',
    ) {
        const generation = run.admittedGeneration;
        const recovery = host.taskRecovery;
        if (generation === null || !recovery) return false;
        if (
            host.sdk &&
            (!host.sdk.decodeExecEvent ||
                !host.observeWorkerExit ||
                !recovery.observeSdkRetrySafety)
        )
            return false;
        const binding = runBinding(run);
        const nextGeneration = generation + 1;
        if (mode === 'observe-ready' && !readyBinding(binding, nextGeneration))
            return false;
        const exit = await taskExit(run, binding, generation);
        if (!exit) return false;
        if (!readyBinding(binding, nextGeneration)) {
            if (mode === 'observe-ready') return false;
            await execution.takeover(binding.session, generation);
        }
        if (!readyBinding(binding, nextGeneration)) return false;
        if (
            mode === 'observe-ready' &&
            execution.hasUnknownOperations(binding.session, generation)
        )
            return false;
        const prior = db.readStopProof(run.id);
        if (prior) {
            readProof(run, generation, generation + 1);
            return true;
        }
        if (mode === 'settle')
            await reconcileFixtureWrite(run, binding, generation);
        if (execution.hasUnknownOperations(binding.session, generation))
            return false;
        let effect;
        if (host.sdk) {
            const observed = await recovery.observeSdkRetrySafety!(
                binding,
                run.id,
                generation,
            );
            if (!observed) return false;
            const exitedAt = Date.parse(observed.exitedAt);
            const observedAt = Date.parse(observed.observedAt);
            if (
                observed.sessionId !== binding.session ||
                observed.runId !== run.id ||
                observed.generation !== generation ||
                observed.bindingDigest !== executionBindingDigest(binding) ||
                observed.exitedAt !== exit.exitedAt ||
                !Number.isFinite(exitedAt) ||
                !Number.isFinite(observedAt) ||
                exitedAt > observedAt ||
                observedAt > Date.now()
            )
                return false;
            effect = observed;
        } else {
            effect = await recovery.retryObservation(
                binding,
                run.id,
                generation,
            );
        }
        const history = execution.historyQuiescence(binding.session);
        if (
            !effect ||
            effect.workspaceOnly !== true ||
            effect.unknownOperations !== 0 ||
            history.handleOpen ||
            history.pendingBatches !== 0
        )
            return false;
        if (!readyBinding(binding, nextGeneration)) return false;
        if (
            mode === 'observe-ready' &&
            execution.hasUnknownOperations(binding.session, generation)
        )
            return false;
        const proof = {
            taskId: run.projectId,
            runId: run.id,
            sessionId: binding.session,
            bindingDigest: executionBindingDigest(binding),
            oldGeneration: generation,
            newGeneration: generation + 1,
            workerExitedAt: exit.exitedAt,
            authorityState: 'READY',
            authorityRun: null,
            hasCapability: false,
            unknownOperations: 0,
            pendingBatches: 0,
            workspaceOnly: true,
            observedAt: new Date().toISOString(),
        };
        db.recordStopProof(run.id, JSON.stringify(proof));
        return true;
    }

    type TaskClosureInput = {
        runId: string;
        decision: 'failed' | 'unconfirmed';
        expectedGeneration: number;
    };
    const closingTaskRuns = new Map<string, Promise<void>>();

    async function closeTaskRun(input: TaskClosureInput) {
        if (input.decision !== 'failed' && input.decision !== 'unconfirmed')
            throw conflict('review_unavailable', 'Invalid closure.');
        const active = closingTaskRuns.get(input.runId);
        if (active) await active;
        const prior = db.readTaskClosure(input.runId);
        if (prior) {
            if (
                prior.authorityGeneration !== input.expectedGeneration ||
                prior.decision !== input.decision
            )
                throw conflict(
                    'review_unavailable',
                    'Closure decision changed.',
                );
            return;
        }
        const task = finishTaskClosure(input);
        closingTaskRuns.set(input.runId, task);
        try {
            await task;
        } finally {
            closingTaskRuns.delete(input.runId);
        }
    }

    async function finishTaskClosure(input: TaskClosureInput) {
        const run = db.findRun(input.runId);
        const generation = run.admittedGeneration;
        const binding = runBinding(run);
        const unavailable = () =>
            conflict(
                'review_unavailable',
                'Task closure evidence unavailable.',
            );
        const canClose = () => {
            const current = db.findRun(run.id);
            if (
                signal.aborted ||
                current.taskSequence === null ||
                current.status !== 'needs_review' ||
                current.receipt ||
                current.admittedGeneration !== generation ||
                current.admittedBindingDigest !==
                    executionBindingDigest(binding) ||
                isExecuting(run.id) ||
                db.hasActiveTaskRetry(run.projectId) ||
                !readyBinding(binding, input.expectedGeneration)
            )
                return false;
            const history = execution.historyQuiescence(binding.session);
            return !history.handleOpen && !history.pendingBatches;
        };
        if (
            generation === null ||
            !Number.isSafeInteger(input.expectedGeneration) ||
            input.expectedGeneration <= generation ||
            !canClose()
        )
            throw unavailable();
        const exit = await taskExit(run, binding, generation);
        if (!exit || !canClose()) throw unavailable();
        let observation: TaskVolumeStopObservation | undefined;
        if (input.decision === 'failed') {
            try {
                await stopAndProve(run, 'observe-ready');
            } catch {
                // Invalid retry evidence cannot authorize a retry.
            }
        } else {
            let observed;
            try {
                observed = await host.observeTaskVolumeStopped?.(
                    binding,
                    run.id,
                    generation,
                );
            } catch {
                throw unavailable();
            }
            const observedAt = Date.parse(observed?.observedAt ?? '');
            if (
                !observed ||
                observed.sessionId !== binding.session ||
                observed.runId !== run.id ||
                observed.generation !== generation ||
                observed.bindingDigest !== executionBindingDigest(binding) ||
                observed.restoreIdle !== true ||
                observed.volumeWriters !== 0 ||
                observed.sandboxStopped !== true ||
                !Number.isFinite(observedAt) ||
                observedAt < Date.parse(exit.exitedAt) ||
                observedAt > Date.now()
            )
                throw unavailable();
            observation = {
                sessionId: observed.sessionId,
                runId: observed.runId,
                generation: observed.generation,
                bindingDigest: observed.bindingDigest,
                restoreIdle: true,
                volumeWriters: 0,
                sandboxStopped: true,
                observedAt: observed.observedAt,
            };
        }
        if (!canClose()) throw unavailable();
        db.closeTaskRun(
            run.id,
            input.decision,
            input.expectedGeneration,
            sha256Digest(
                JSON.stringify({
                    exitReceiptDigest: sha256Digest(JSON.stringify(exit)),
                    bindingDigest: executionBindingDigest(binding),
                    oldGeneration: generation,
                    newGeneration: input.expectedGeneration,
                    ...(observation && { observation }),
                }),
            ),
        );
    }

    async function closeTaskRetry(input: {
        attemptId: string;
        expectedGeneration: number;
    }) {
        const prior = db.readTaskRetryClosure(input.attemptId);
        if (prior) {
            if (prior.authorityGeneration !== input.expectedGeneration)
                throw conflict('review_unavailable', 'Retry closure changed.');
            return;
        }
        const attempt = db.taskRetry(input.attemptId);
        if (
            attempt.phase !== 'blocked' ||
            input.expectedGeneration !== attempt.newGeneration ||
            advancingRetries.has(attempt.id)
        )
            throw conflict(
                'review_unavailable',
                'Retry is not awaiting closure.',
            );
        advancingRetries.add(attempt.id);
        try {
            const run = db.findRun(attempt.sourceRunId);
            const binding = runBinding(run);
            const exit = await taskExit(run, binding, attempt.oldGeneration);
            const history = execution.historyQuiescence(binding.session);
            if (
                !exit ||
                history.handleOpen ||
                history.pendingBatches ||
                !readyBinding(binding, input.expectedGeneration)
            )
                throw conflict(
                    'review_unavailable',
                    'Retry cleanup evidence unavailable.',
                );
            const cleanupObservation = await host.observeRetryCleanup?.(
                binding,
                attempt.id,
                input.expectedGeneration,
            );
            const bindingDigest = executionBindingDigest(binding);
            if (
                !cleanupObservation ||
                cleanupObservation.attemptId !== attempt.id ||
                cleanupObservation.generation !== attempt.newGeneration ||
                cleanupObservation.bindingDigest !== bindingDigest ||
                cleanupObservation.restoreIdle !== true ||
                cleanupObservation.volumeWriters !== 0 ||
                cleanupObservation.sandboxStopped !== true ||
                !readyBinding(binding, input.expectedGeneration) ||
                !Number.isFinite(Date.parse(cleanupObservation.observedAt))
            )
                throw conflict(
                    'review_unavailable',
                    'Retry cleanup evidence unavailable.',
                );
            db.closeBlockedTaskRetry(
                attempt.id,
                input.expectedGeneration,
                sha256Digest(
                    JSON.stringify({
                        exitReceiptDigest: sha256Digest(JSON.stringify(exit)),
                        bindingDigest,
                        authorityGeneration: input.expectedGeneration,
                        cleanupObservation,
                    }),
                ),
            );
        } finally {
            advancingRetries.delete(attempt.id);
        }
    }

    async function reconcileTaskRetry(input: {
        attemptId: string;
        expectedGeneration: number;
    }): Promise<'pending' | 'queued'> {
        const attempt = db.taskRetry(input.attemptId);
        if (attempt.newGeneration !== input.expectedGeneration)
            return 'pending';
        if (attempt.phase === 'queued') return 'queued';
        if (attempt.phase !== 'blocked' || advancingRetries.has(attempt.id))
            return 'pending';
        advancingRetries.add(attempt.id);
        try {
            const { binding, proof } = verifiedStopProof(attempt);
            await verifyRestoredTask(attempt, binding, proof);
            db.finalizeTaskRetry(attempt.id, 'blocked');
            wake();
            return 'queued';
        } catch {
            return 'pending';
        } finally {
            advancingRetries.delete(attempt.id);
        }
    }

    return {
        reviewRun,
        taskExit,
        stopAndProve,
        closeTaskRun,
        closeTaskRetry,
        reconcileTaskRetry,
    };
}
