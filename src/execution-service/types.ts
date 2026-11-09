import type {
    SingleHostExecution,
    SingleHostSandbox,
} from '../openshell/single-host.ts';
import type { SdkIngressOptions } from '../openshell/sdk-ingress.ts';

export type FileText = { path: string; text: string };
export type Binding = Parameters<SingleHostExecution['bind']>[0];
export type Observation = Parameters<SingleHostExecution['bind']>[1];
export type Grant = ReturnType<SingleHostExecution['admit']>;
export type WorkerRequest = {
    mode: 'execute' | 'recover';
    binding: Binding;
    grant: Grant;
    prompt?: string;
    persistenceUrl: string;
    operationUrl: string;
    gateway?: string;
};
export type WorkerResult = 'completed' | 'review' | 'recovered';

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
    worker(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResult>;
}

export type ProjectStatus = 'importing' | 'ready' | 'failed';
export type RunStatus =
    | 'queued'
    | 'running'
    | 'recovering'
    | 'needs_review'
    | 'succeeded'
    | 'failed';
