import type { SingleHostExecution } from '../openshell/single-host.ts';
import {
    HistoryCheckpointUnavailable,
    type VerifiedStopProof,
} from '../openshell/session-history.ts';
import { RequestError, textSnapshot } from './input.ts';
import type { Store } from './store/index.ts';
import { snapshotSha256 } from './snapshot.ts';
import {
    TaskRestoreEvidenceConflict,
    executionBindingDigest,
    sha256Digest,
    type Binding,
    type ExecutionHost,
    type FileText,
} from './types.ts';
type Run = ReturnType<Store['findRun']>;
type Attempt = ReturnType<Store['taskRetry']>;
export class RetryEvidenceConflict extends Error {}
type Options = {
    db: Store;
    execution: SingleHostExecution;
    host: ExecutionHost;
    stop: AbortController;
    readyBinding(binding: Binding, generation: number): boolean;
};
export function taskRetryRecovery({
    db,
    execution,
    host,
    stop,
    readyBinding,
}: Options) {
    function readProof(run: Run, oldGeneration: number, newGeneration: number) {
        const binding = db.binding(run);
        const receipt = db.readStopProof(run.id);
        if (
            !receipt ||
            typeof receipt.canonicalJson !== 'string' ||
            sha256Digest(receipt.canonicalJson) !== receipt.sha256
        )
            throw new RetryEvidenceConflict(
                'Task stop proof checksum mismatch',
            );
        const proof = JSON.parse(receipt.canonicalJson);
        const canonical = JSON.stringify({
            taskId: run.projectId,
            runId: run.id,
            sessionId: binding.session,
            bindingDigest: executionBindingDigest(binding),
            oldGeneration,
            newGeneration,
            workerExitedAt: db.taskExit(run.id, oldGeneration)?.exitedAt,
            authorityState: 'READY',
            authorityRun: null,
            hasCapability: false,
            unknownOperations: 0,
            pendingBatches: 0,
            workspaceOnly: true,
            observedAt: proof.observedAt,
        });
        if (
            oldGeneration !== run.admittedGeneration ||
            oldGeneration + 1 !== newGeneration ||
            canonical !== receipt.canonicalJson ||
            !Number.isFinite(Date.parse(proof.workerExitedAt)) ||
            !Number.isFinite(Date.parse(proof.observedAt)) ||
            !readyBinding(binding, newGeneration) ||
            execution.hasUnknownOperations(binding.session, oldGeneration)
        )
            throw new RetryEvidenceConflict('Task stop proof binding mismatch');
        return binding;
    }

    function verifiedStopProof(attempt: Attempt) {
        const source = db.findRun(attempt.sourceRunId);
        if (source.projectId !== attempt.taskId)
            throw new RetryEvidenceConflict('Retry source binding changed');
        const binding = readProof(
            source,
            attempt.oldGeneration,
            attempt.newGeneration,
        );
        const checkpoint = db.taskCheckpoint(source.id);
        if (
            !checkpoint ||
            checkpoint.workspaceSha256 !== attempt.workspaceSha256 ||
            checkpoint.historySha256 !== attempt.historySha256
        )
            throw new RetryEvidenceConflict('Retry checkpoint mismatch');
        let files: FileText[];
        try {
            files = textSnapshot(JSON.parse(checkpoint.workspace));
        } catch (error) {
            if (error instanceof RequestError || error instanceof SyntaxError)
                throw new RetryEvidenceConflict('Retry checkpoint mismatch');
            throw error;
        }
        if (snapshotSha256(files) !== checkpoint.workspaceSha256)
            throw new RetryEvidenceConflict('Retry checkpoint mismatch');
        const proof = {
            attemptId: attempt.id,
            taskId: attempt.taskId,
            sourceRunId: source.id,
            newRunId: attempt.newRunId,
            sessionId: binding.session,
            oldGeneration: attempt.oldGeneration,
            newGeneration: attempt.newGeneration,
            checkpointSha256: attempt.historySha256,
        } as VerifiedStopProof;
        return { binding, checkpoint, proof };
    }

    const advancingRetries = new Set<string>();
    async function advanceTaskRetry(attempt: Attempt) {
        const phase = attempt.phase;
        const recovery = host.taskRecovery;
        if (
            !recovery ||
            phase === 'queued' ||
            phase === 'closed' ||
            phase === 'blocked' ||
            advancingRetries.has(attempt.id)
        )
            return;
        advancingRetries.add(attempt.id);
        try {
            let validated: ReturnType<typeof verifiedStopProof>;
            try {
                validated = verifiedStopProof(attempt);
            } catch (error) {
                if (
                    error instanceof RetryEvidenceConflict ||
                    error instanceof SyntaxError
                )
                    throw new RetryEvidenceConflict(
                        'Invalid persisted retry evidence',
                    );
                throw error;
            }
            let { binding, checkpoint, proof } = validated;
            if (phase === 'preparing') {
                const receipt = await recovery.queryRestore(
                    binding,
                    attempt.id,
                );
                try {
                    ({ binding, checkpoint, proof } =
                        verifiedStopProof(attempt));
                } catch (error) {
                    if (
                        error instanceof RetryEvidenceConflict ||
                        error instanceof SyntaxError
                    )
                        throw new RetryEvidenceConflict(
                            'Invalid persisted retry evidence',
                        );
                    throw error;
                }
                if (
                    receipt &&
                    (receipt.sha256 !== attempt.workspaceSha256 ||
                        receipt.attemptId !== attempt.id)
                )
                    throw new RetryEvidenceConflict('Restore receipt changed');
                execution.validateRestoreCheckpoint(
                    proof.sessionId,
                    proof.sourceRunId,
                    proof.oldGeneration,
                    proof.checkpointSha256,
                );
                if (receipt?.phase !== 'ready') {
                    const output = await recovery.restoreTask(
                        binding,
                        attempt.id,
                        textSnapshot(JSON.parse(checkpoint.workspace)),
                        attempt.workspaceSha256,
                    );
                    if (
                        output.attemptId !== attempt.id ||
                        output.sha256 !== attempt.workspaceSha256
                    )
                        throw new RetryEvidenceConflict(
                            'Unexpected restore receipt',
                        );
                }
                if (
                    snapshotSha256(await host.snapshot(binding)) !==
                    attempt.workspaceSha256
                )
                    throw new RetryEvidenceConflict(
                        'Restored Task volume differs',
                    );
                db.advanceTaskRetry(attempt.id, phase, 'workspace_restored');
                return;
            }
            if (phase === 'workspace_restored') {
                if (
                    execution.restoreHistory(proof).sha256 !==
                    attempt.historySha256
                )
                    throw new RetryEvidenceConflict(
                        'Restored Task history differs',
                    );
                db.advanceTaskRetry(attempt.id, phase, 'history_restored');
                return;
            }
            await verifyRestoredTask(attempt, binding, proof);
            db.finalizeTaskRetry(attempt.id, phase);
        } catch (error) {
            if (
                !stop.signal.aborted &&
                (error instanceof RetryEvidenceConflict ||
                    error instanceof TaskRestoreEvidenceConflict ||
                    error instanceof HistoryCheckpointUnavailable)
            )
                db.advanceTaskRetry(attempt.id, phase, 'blocked');
            // An ambiguous host response is queried under the same attempt on the next tick.
        } finally {
            advancingRetries.delete(attempt.id);
        }
    }

    async function verifyRestoredTask(
        attempt: Attempt,
        binding: Binding,
        proof: VerifiedStopProof,
    ) {
        const receipt = await host.taskRecovery?.queryRestore(
            binding,
            attempt.id,
        );
        const current = await host.running(execution.inspect(binding.session));
        if (
            receipt?.phase !== 'ready' ||
            receipt.attemptId !== attempt.id ||
            receipt.sha256 !== attempt.workspaceSha256 ||
            !current.running ||
            !current.installed ||
            current.sandbox !== binding.sandbox ||
            current.volume !== binding.volume ||
            snapshotSha256(await host.snapshot(binding)) !==
                attempt.workspaceSha256 ||
            execution.restoredHistoryDigest(proof) !== attempt.historySha256
        )
            throw new RetryEvidenceConflict(
                'Inconsistent Task recovery evidence',
            );
    }

    return {
        readProof,
        verifiedStopProof,
        advanceTaskRetry,
        verifyRestoredTask,
        advancingRetries,
    };
}
