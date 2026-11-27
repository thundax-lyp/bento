import { maxSnapshotFiles } from '@/shared/text-snapshot.ts';
import type {
    FileDeleteHold,
    Operation,
    ProjectDeletionImpact,
    ProjectInput,
    Run,
} from './protocol.ts';
import {
    RequestError,
    field,
    notFound,
    object,
    resourceId,
    runPrompt,
    runStatuses,
    status,
    timestamp,
} from './protocol-values.ts';

export type TaskSource =
    | { kind: 'blank' }
    | { kind: 'space_snapshot'; spaceId: string; fileIds: string[] };
export type CreateTaskInput = { name: string; source: TaskSource };
export type FrozenTaskInput = {
    id: string | null;
    name: string;
    sourceSpaceId: string | null;
    inputFiles: ProjectInput['files'];
    inputManifest: TaskInputFile[];
    inputDigest: string;
};
type TaskInputFile = {
    fileId: string;
    path: string;
    bytes: number;
    sha256: string;
};
type TaskDTO = {
    id: string;
    name: string;
    sourceSpaceId: string | null;
    inputDigest: string;
    environmentVersion: string;
    status: 'preparing' | 'ready' | 'failed' | 'deleting';
    prepareError: string | null;
    closedReason: string | null;
    inputs: TaskInputFile[];
    reconciliation: {
        attemptId: string;
        state: 'blocked';
        reason: 'restore_conflict';
    } | null;
    createdAt: string;
    updatedAt: string;
};
type TaskRunDTO = {
    id: string;
    taskId: string;
    sequence: number;
    prompt: string;
    status: Run['status'];
    retryOf: string | null;
    canContinue: boolean;
    canCancel: boolean;
    retryReason: string | null;
    resultVersion: number | null;
    summary: string | null;
    createdAt: string;
    updatedAt: string;
};
type Check = {
    name: string;
    status: 'passed' | 'failed' | 'not_run' | 'unavailable';
    output: string | null;
};
type TaskEvent = {
    id: string;
    sequence: number;
    runId: string;
    at: string;
    kind: string;
    text: string;
    check: Check | null;
};
type TaskResult = {
    runId: string;
    version: 1;
    summary: string;
    checks: Check[];
    incrementalSha256: string;
    cumulativeSha256: string;
    createdAt: string;
};
type Retry = {
    id: string;
    runId: string;
    state: 'preparing' | 'queued' | 'blocked' | 'closed';
};
type TaskRoute =
    | 'listTasks'
    | 'task'
    | 'prepareTask'
    | 'taskEvents'
    | 'taskRuns'
    | 'createTaskRun'
    | 'taskRun'
    | 'cancelTaskRun'
    | 'retryTaskRun'
    | 'taskResult'
    | 'taskDiff';

export type TaskOperation =
    | {
          kind: 'taskRequest';
          action: TaskRoute;
          path: string;
          query: string;
          method: 'GET' | 'POST';
          key?: string;
          prompt?: string;
      }
    | { kind: 'createTask'; key: string; input: FrozenTaskInput }
    | { kind: 'taskCreationReceipt'; key: string }
    | { kind: 'drainOwner' }
    | {
          kind: 'taskSourceImpact';
          spaceId: string;
          legacyProjectId: string | null;
      }
    | {
          kind: 'taskSourceDeletion';
          spaceId: string;
          legacyProjectId: string | null;
          operationId: string;
          phase: 'hold' | 'commit' | 'release';
      }
    | {
          kind: 'acquireTaskInputDeleteHold' | 'releaseTaskInputDeleteHold';
          spaceId: string;
          fileId: string;
          legacyProjectId: string | null;
          operationId: string;
      };

export type TaskResponse =
    | { task: TaskDTO }
    | { run: TaskRunDTO }
    | { retry: Retry }
    | { result: TaskResult }
    | { items: TaskDTO[] | TaskRunDTO[] | TaskEvent[] }
    | { state: 'held' };

export function isTaskOperation(
    operation: Operation,
): operation is TaskOperation {
    switch (operation.kind) {
        case 'taskRequest':
        case 'createTask':
        case 'taskCreationReceipt':
        case 'drainOwner':
        case 'taskSourceImpact':
        case 'taskSourceDeletion':
        case 'acquireTaskInputDeleteHold':
        case 'releaseTaskInputDeleteHold':
            return true;
        default:
            return false;
    }
}

const taskUuid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const taskInputError = () =>
    new RequestError(400, 'invalid_input', '任务请求内容无效。');

export function taskKey(keys: readonly string[] | undefined) {
    if (keys?.length !== 1 || !keys[0] || !taskUuid.test(keys[0]))
        throw new RequestError(400, 'invalid_key', '提交键无效。');
    return keys[0];
}

export function createTaskInput(value: unknown): CreateTaskInput {
    const data = object(value);
    const { name, source } = data;
    if (
        typeof name !== 'string' ||
        !name.trim() ||
        [...name.trim()].length > 120 ||
        Buffer.from(name).toString('utf8') !== name ||
        Object.keys(data).length !== 2
    )
        throw taskInputError();
    const selection = object(source);
    if (selection.kind === 'blank' && Object.keys(selection).length === 1)
        return { name: name.trim(), source: { kind: 'blank' } };
    if (
        selection.kind !== 'space_snapshot' ||
        Object.keys(selection).length !== 3 ||
        !Array.isArray(selection.fileIds) ||
        selection.fileIds.length < 1
    )
        throw taskInputError();
    if (selection.fileIds.length > maxSnapshotFiles)
        throw new RequestError(413, 'too_large', '任务快照最多 100 个文件。');
    const fileIds = selection.fileIds.map(resourceId).sort();
    if (new Set(fileIds).size !== fileIds.length) throw taskInputError();
    return {
        name: name.trim(),
        source: {
            kind: 'space_snapshot',
            spaceId: resourceId(selection.spaceId),
            fileIds,
        },
    };
}

export async function parseTaskRequest(
    path: string,
    query: string | undefined,
    method: string | undefined,
    keys: readonly string[] | undefined,
    readBody: () => Promise<unknown>,
    requireEmpty: () => void,
): Promise<
    | TaskOperation
    | { kind: 'taskSubmission'; key: string; input: CreateTaskInput }
> {
    if (method !== 'GET' && method !== 'POST') throw notFound();
    const params = new URLSearchParams(query);
    const validateQuery = (allowed: readonly string[]) => {
        for (const name of params.keys())
            if (!allowed.includes(name) || params.getAll(name).length !== 1)
                throw taskInputError();
    };
    if (path === '/api/tasks') {
        validateQuery([]);
        if (method === 'POST')
            return {
                kind: 'taskSubmission',
                key: taskKey(keys),
                input: createTaskInput(await readBody()),
            };
        if (method === 'GET') {
            requireEmpty();
            return {
                kind: 'taskRequest',
                action: 'listTasks',
                method,
                path: '/tasks',
                query: '',
            };
        }
        throw notFound();
    }
    const match =
        /^\/api\/tasks\/([^/]+)(?:\/(prepare|events|runs)(?:\/([^/]+)(?:\/(cancel|retry|results)(?:\/(1)\/diff)?)?)?)?$/.exec(
            path,
        );
    if (!match) throw notFound();
    const [, id, section, runId, mode, version] = match;
    if (
        !id ||
        !taskUuid.test(id) ||
        (runId !== undefined && !taskUuid.test(runId))
    )
        throw notFound();
    let action: TaskRoute;
    if (!section && method === 'GET') action = 'task';
    else if (section === 'prepare' && !runId && method === 'POST')
        action = 'prepareTask';
    else if (section === 'events' && !runId && method === 'GET')
        action = 'taskEvents';
    else if (section === 'runs' && !runId && method === 'GET')
        action = 'taskRuns';
    else if (section === 'runs' && !runId && method === 'POST')
        action = 'createTaskRun';
    else if (section === 'runs' && runId && !mode && method === 'GET')
        action = 'taskRun';
    else if (
        section === 'runs' &&
        mode === 'cancel' &&
        !version &&
        method === 'POST'
    )
        action = 'cancelTaskRun';
    else if (
        section === 'runs' &&
        mode === 'retry' &&
        !version &&
        method === 'POST'
    )
        action = 'retryTaskRun';
    else if (section === 'runs' && mode === 'results' && method === 'GET')
        action = version ? 'taskDiff' : 'taskResult';
    else throw notFound();
    validateQuery(
        action === 'taskEvents'
            ? ['after']
            : action === 'taskDiff'
              ? ['view', 'download']
              : [],
    );
    if (action === 'taskEvents') {
        const after = params.get('after') ?? '0';
        if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))
            throw taskInputError();
    }
    if (action === 'taskDiff') {
        const view = params.get('view');
        if (
            (view !== 'incremental' && view !== 'cumulative') ||
            (params.has('download') && params.get('download') !== '1')
        )
            throw taskInputError();
    }
    const key =
        action === 'createTaskRun' || action === 'retryTaskRun'
            ? taskKey(keys)
            : undefined;
    if (action !== 'createTaskRun') requireEmpty();
    let prompt: string | undefined;
    if (action === 'createTaskRun') {
        const data = object(await readBody());
        if (Object.keys(data).length !== 1) throw taskInputError();
        prompt = runPrompt(data);
    }
    return {
        kind: 'taskRequest',
        action,
        method,
        path: path.slice(4),
        query: params.toString(),
        ...(key ? { key } : {}),
        ...(prompt === undefined ? {} : { prompt }),
    };
}

const nullableString = (value: unknown) =>
    value === null ? null : field(value);
function positive(value: unknown) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
        throw new Error('Invalid Task sequence');
    return value;
}
function boolean(value: unknown) {
    if (typeof value !== 'boolean') throw new Error('Invalid Task flag');
    return value;
}
function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
    if (!Array.isArray(value)) throw new Error('Expected list');
    return value.map(parse);
}
function hashField(value: unknown) {
    const hex = field(value);
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('Invalid digest');
    return hex;
}
function taskDTO(value: unknown): TaskDTO {
    const row = object(value);
    const recovery =
        row.reconciliation === null ? null : object(row.reconciliation);
    const version = field(row.environmentVersion);
    if (!/^sha256:[0-9a-f]{64}$/.test(version))
        throw new Error('Invalid environment version');
    return {
        id: resourceId(row.id),
        name: field(row.name),
        sourceSpaceId: nullableString(row.sourceSpaceId),
        inputDigest: hashField(row.inputDigest),
        environmentVersion: version,
        status: status(row.status, [
            'preparing',
            'ready',
            'failed',
            'deleting',
        ] as const),
        prepareError: nullableString(row.prepareError),
        closedReason: nullableString(row.closedReason),
        reconciliation: recovery && {
            attemptId: resourceId(recovery.attemptId),
            state: status(recovery.state, ['blocked'] as const),
            reason: status(recovery.reason, ['restore_conflict'] as const),
        },
        createdAt: timestamp(row.createdAt),
        updatedAt: timestamp(row.updatedAt),
        inputs: list(row.inputs, (value) => {
            const file = object(value);
            return {
                fileId: resourceId(file.fileId),
                path: field(file.path),
                bytes: file.bytes === 0 ? 0 : positive(file.bytes),
                sha256: hashField(file.sha256),
            };
        }),
    };
}
function taskRunDTO(value: unknown): TaskRunDTO {
    const row = object(value);
    return {
        id: resourceId(row.id),
        taskId: resourceId(row.taskId),
        sequence: positive(row.sequence),
        prompt: field(row.prompt),
        status: status(row.status, runStatuses),
        retryOf: nullableString(row.retryOf),
        canContinue: boolean(row.canContinue),
        canCancel: boolean(row.canCancel),
        retryReason: nullableString(row.retryReason),
        resultVersion:
            row.resultVersion === null ? null : positive(row.resultVersion),
        summary: nullableString(row.summary),
        createdAt: timestamp(row.createdAt),
        updatedAt: timestamp(row.updatedAt),
    };
}
function taskCheck(value: unknown): Check {
    const row = object(value);
    return {
        name: field(row.name),
        status: status(row.status, [
            'passed',
            'failed',
            'not_run',
            'unavailable',
        ] as const),
        output: nullableString(row.output),
    };
}
export function taskResponse(
    operation: TaskOperation,
    value: unknown,
):
    | TaskResponse
    | FileDeleteHold
    | ProjectDeletionImpact
    | { state: 'deleting' } {
    const row = object(value);
    if (operation.kind === 'createTask') return { task: taskDTO(row.task) };
    if (operation.kind === 'taskCreationReceipt')
        return { items: list(row.items, taskDTO) };
    if (operation.kind === 'taskSourceImpact') {
        const counter = (v: unknown) => (v === 0 ? 0 : positive(v));
        return {
            runCount: counter(row.runCount),
            diffCount: counter(row.diffCount),
            blockers: list(row.blockers, (v) =>
                status(v, ['project_importing', 'project_busy'] as const),
            ),
        };
    }
    if (operation.kind === 'taskSourceDeletion')
        return { state: status(row.state, ['held', 'deleting'] as const) };
    if (
        operation.kind === 'acquireTaskInputDeleteHold' ||
        operation.kind === 'releaseTaskInputDeleteHold'
    )
        return {
            state: status(row.state, ['held', 'denied', 'released'] as const),
        };
    if (operation.kind !== 'taskRequest')
        throw new Error('Unexpected Task response');
    const { action } = operation;
    if (action === 'listTasks') return { items: list(row.items, taskDTO) };
    if (action === 'task' || action === 'prepareTask') {
        const task = taskDTO(row.task);
        if (task.id !== operation.path.split('/')[2])
            throw new Error('Task binding mismatch');
        return { task };
    }
    const [, , taskId, , runId] = operation.path.split('/');
    const parseRun = (value: unknown) => {
        const run = taskRunDTO(value);
        if (run.taskId !== taskId || (runId !== undefined && run.id !== runId))
            throw new Error('Run binding mismatch');
        return run;
    };
    if (action === 'taskRuns') return { items: list(row.items, parseRun) };
    if (
        action === 'taskRun' ||
        action === 'createTaskRun' ||
        action === 'cancelTaskRun'
    )
        return { run: parseRun(row.run) };
    if (action === 'taskEvents')
        return {
            items: list(row.items, (value) => {
                const event = object(value);
                return {
                    id: field(event.id),
                    sequence: positive(event.sequence),
                    runId: resourceId(event.runId),
                    at: timestamp(event.at),
                    kind: status(event.kind, [
                        'user_message',
                        'agent_reply',
                        'step',
                        'command',
                        'check',
                    ] as const),
                    text: field(event.text),
                    check: event.check === null ? null : taskCheck(event.check),
                };
            }),
        };
    if (action === 'taskResult') {
        const result = object(row.result);
        if (result.runId !== runId || result.version !== 1)
            throw new Error('Result binding mismatch');
        return {
            result: {
                runId: resourceId(result.runId),
                version: 1,
                summary: field(result.summary),
                checks: list(result.checks, taskCheck),
                incrementalSha256: hashField(result.incrementalSha256),
                cumulativeSha256: hashField(result.cumulativeSha256),
                createdAt: timestamp(result.createdAt),
            },
        };
    }
    if (action === 'retryTaskRun') {
        const retry = object(row.retry);
        return {
            retry: {
                id: resourceId(retry.id),
                runId: resourceId(retry.runId),
                state: status(retry.state, [
                    'preparing',
                    'queued',
                    'blocked',
                    'closed',
                ] as const),
            },
        };
    }
    throw new Error('Unexpected Task response');
}
