import { createHash } from 'node:crypto';
import type {
    Binding,
    WorkerRequest,
    WorkerResult,
} from '@/apps/worker/protocol.ts';
export type {
    Binding,
    Grant,
    WorkerRequest,
    WorkerResult,
} from '@/apps/worker/protocol.ts';
import type {
    SingleHostExecution,
    SingleHostSandbox,
} from '../openshell/single-host.ts';
import type { SdkIngressOptions } from '../openshell/sdk-ingress.ts';

export type FileText = { path: string; text: string };
export type Observation = Parameters<SingleHostExecution['bind']>[1];

export const sha256Digest = (value: string) =>
    createHash('sha256').update(value).digest('hex');

export function executionEnvironmentVersion(
    imageDigest: unknown,
    policyDigest: unknown,
) {
    const format = /^sha256:[0-9a-f]{64}$/;
    if (
        typeof imageDigest !== 'string' ||
        !format.test(imageDigest) ||
        typeof policyDigest !== 'string' ||
        !format.test(policyDigest)
    )
        throw new Error('Invalid execution environment identity');
    return (
        'sha256:' + sha256Digest(JSON.stringify({ imageDigest, policyDigest }))
    );
}

export function executionBindingDigest(binding: Binding) {
    const { tenant, project, session, sandbox, volume } = binding;
    return sha256Digest(
        JSON.stringify({ tenant, project, session, sandbox, volume }),
    );
}

export type WorkerExitObservation = {
    sessionId: string;
    runId: string;
    generation: number;
    bindingDigest: string;
    exitedAt: string;
};

export type FixtureWriteReceipt = Pick<
    WorkerExitObservation,
    'sessionId' | 'runId' | 'generation' | 'bindingDigest'
> & {
    operationId: string;
    inputDigest: string;
    relativePath: 'README.md' | 'bento-demo.txt';
    fileSha256: string;
};

export class TaskRestoreEvidenceConflict extends Error {}

export type RestoreObservation = {
    attemptId: string;
    phase: 'prepared' | 'published' | 'ready';
    sha256: string;
};

export type RetryCleanupObservation = {
    attemptId: string;
    generation: number;
    bindingDigest: string;
    restoreIdle: true;
    volumeWriters: 0;
    sandboxStopped: true;
    observedAt: string;
};

/** Trusted deployment integration. Only the worker grant goes to the worker. */
export interface ExecutionHost extends SingleHostSandbox {
    sdk?: SdkIngressOptions;
    environmentVersion: string;
    provisionTask(
        binding: Binding,
        files: readonly FileText[],
        environmentVersion: string,
    ): Promise<Observation & { environmentVersion: string }>;
    observeWorkerExit?(
        binding: Binding,
        runId: string,
        generation: number,
    ): Promise<WorkerExitObservation | null>;
    observeRetryCleanup?(
        binding: Binding,
        attemptId: string,
        generation: number,
    ): Promise<RetryCleanupObservation | null>;
    taskRecovery?: {
        retryObservation(
            binding: Binding,
            runId: string,
            generation: number,
        ): Promise<{ unknownOperations: number; workspaceOnly: boolean }>;
        queryRestore(
            binding: Binding,
            attemptId: string,
        ): Promise<RestoreObservation | null>;
        restoreTask(
            binding: Binding,
            attemptId: string,
            files: readonly FileText[],
            expectedSha256: string,
        ): Promise<{ attemptId: string; sha256: string }>;
        readFixtureWriteReceipt?(
            binding: Binding,
            runId: string,
            generation: number,
        ): Promise<FixtureWriteReceipt | null>;
    };
    /** Idempotent staging and verified mount. A retry must never replace a live volume. */
    provision(
        binding: Binding,
        files: readonly FileText[],
    ): Promise<Observation>;
    /** Read a quiescent volume independently of the worker. */
    snapshot(binding: Binding): Promise<readonly FileText[]>;
    /** Delete this binding's sandbox and volume, and confirm both are absent. */
    purge?(binding: Binding): Promise<void>;
    workerSlots?: 1 | 2;
    /** The trusted launcher can independently confirm the exit of this Worker. */
    supportsRunningCancellation?: true;
    supportsTaskRunningCancellation?: true;
    warmWorker?(signal: AbortSignal): () => Promise<void>;
    worker(
        request: WorkerRequest,
        signal: AbortSignal,
        slot?: number,
        onWorkerExit?: () => void,
    ): Promise<WorkerResult>;
}

export type ProjectStatus = 'importing' | 'ready' | 'failed';
export type RunStatus =
    | 'queued'
    | 'running'
    | 'recovering'
    | 'needs_review'
    | 'cancelling'
    | 'cancelled'
    | 'succeeded'
    | 'failed';
