import { createHash } from 'node:crypto';
import { conflict, RequestError } from '../input.ts';
import type { Binding, FileText, ProjectStatus, RunStatus } from '../types.ts';

export type Project = {
    id: string;
    name: string;
    status: ProjectStatus;
    createdAt: string;
    owner: string;
    sessionId: string;
    sandbox: string;
    volume: string;
    source: string | null;
};

export type Run = {
    id: string;
    projectId: string;
    sessionId: string;
    status: RunStatus;
    createdAt: string;
    updatedAt: string;
    summary: string | null;
    prompt: string;
    baseline: string | null;
    receipt: number;
    reconciled: number;
    diff: string | null;
    cancelGeneration: number | null;
    cancelWorkerClosed: 0 | 1;
    taskSequence: number | null;
    retryOf: string | null;
    expectedGeneration: number | null;
    admittedGeneration: number | null;
    admittedBindingDigest: string | null;
};

export type Task = {
    id: string;
    owner: string;
    name: string;
    sourceSpaceId: string | null;
    inputDigest: string;
    environmentVersion: string;
    createdAt: string;
    updatedAt: string;
    prepareError: string | null;
    closedReason: 'unconfirmed' | null;
    inputManifest: string;
};

export type ConfirmedRetryPhase =
    'preparing' | 'workspace_restored' | 'history_restored';

export type RetryEvidence = {
    oldGeneration: number;
    newGeneration: number;
    workspaceSha256: string;
    historySha256: string;
};

export type RetryAttempt = RetryEvidence & {
    id: string;
    taskId: string;
    sourceRunId: string;
    newRunId: string;
    key: string;
    hash: string;
    phase: ConfirmedRetryPhase | 'queued' | 'closed' | 'blocked';
    lastConfirmedPhase: ConfirmedRetryPhase;
};

export type InputHoldState = 'held' | 'denied' | 'released';

export type SourceDeletionState = InputHoldState | 'committing' | 'deleted';

export type TaskEventPayload = {
    kind: 'user_message' | 'agent_reply' | 'step' | 'command' | 'check';
    text: string;
    check: {
        name: string;
        status: 'passed' | 'failed' | 'not_run' | 'unavailable';
        output: string | null;
    } | null;
};

export type TaskResultInput = {
    baselineSha256: string;
    initialSha256: string;
    afterSha256: string;
    incremental: string;
    cumulative: string;
};

export const sha256 = (value: string) =>
    createHash('sha256').update(value).digest('hex');

export const hashJson = (value: unknown) => sha256(JSON.stringify(value));

export const idempotencyConflict = () =>
    conflict(
        'idempotency_conflict',
        'Idempotency-Key already belongs to a different input.',
    );

export const queueFull = () =>
    new RequestError(
        429,
        'tenant_queue_full',
        'Tenant queue is full. Retry after a Run is claimed.',
    );

export const pendingRetries =
    "('preparing','workspace_restored','history_restored','blocked')";

export const now = () => new Date().toISOString();

export function projectBinding(project: Project): Binding {
    return {
        tenant: project.owner,
        project: project.id,
        session: project.sessionId,
        sandbox: project.sandbox,
        volume: project.volume,
    };
}

export const pending =
    "('pending_approval','queued','running','recovering','cancelling','needs_review')";

export const projectView = ({ id, name, status, createdAt }: Project) => ({
    id,
    name,
    status,
    createdAt,
});

export const runView = ({
    id,
    projectId,
    sessionId,
    status,
    createdAt,
    updatedAt,
    summary,
}: Run) => ({
    id,
    projectId,
    sessionId,
    status,
    createdAt,
    updatedAt,
    ...(summary === null ? {} : { summary }),
});

export type TaskInputFile = {
    fileId: string;
    path: string;
    bytes: number;
    sha256: string;
};
export type TaskInput = {
    id: string | null;
    name: string;
    sourceSpaceId: string | null;
    inputFiles: FileText[];
    inputManifest: TaskInputFile[];
    inputDigest: string;
};

export const busyProject = () =>
    conflict('project_busy', 'A source resource is being deleted.');
