import type {
    Binding,
    WorkerRequest,
    WorkerResult,
} from '../../worker/protocol.ts';
export type {
    Binding,
    Grant,
    WorkerRequest,
    WorkerResult,
} from '../../worker/protocol.ts';
import type {
    SingleHostExecution,
    SingleHostSandbox,
} from '../openshell/single-host.ts';
import type { SdkIngressOptions } from '../openshell/sdk-ingress.ts';

export type FileText = { path: string; text: string };
export type Observation = Parameters<SingleHostExecution['bind']>[1];

/** Trusted deployment integration. Only the worker grant goes to the worker. */
export interface ExecutionHost extends SingleHostSandbox {
    sdk?: SdkIngressOptions;
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
    warmWorker?(signal: AbortSignal): () => Promise<void>;
    worker(
        request: WorkerRequest,
        signal: AbortSignal,
        slot?: number,
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
