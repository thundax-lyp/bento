import { maxSnapshotBytes, maxSnapshotFiles } from '@/shared/text-snapshot.ts';

const projectStatuses = ['importing', 'ready', 'failed'] as const;
const runStatuses = [
    'queued',
    'running',
    'recovering',
    'needs_review',
    'cancelling',
    'cancelled',
    'succeeded',
    'failed',
] as const;

export type Project = {
    id: string;
    name: string;
    status: (typeof projectStatuses)[number];
    createdAt: string;
};

export type Run = {
    id: string;
    projectId: string;
    sessionId: string;
    status: (typeof runStatuses)[number];
    createdAt: string;
    updatedAt: string;
    summary?: string;
    prompt?: string;
};

export type ProjectInput = {
    name: string;
    files: { path: string; text: string }[];
};

export type FileDeleteHold = { state: 'held' | 'denied' | 'released' };

export type ProjectDeletionBlocker = 'project_importing' | 'project_busy';
type ProjectDeletionImpact = {
    runCount: number;
    diffCount: number;
    blockers: ProjectDeletionBlocker[];
};
export const projectDeletionConflicts = {
    project_busy: '项目仍有未结束的任务或文件清理。',
    project_importing: '项目正在初始化工作区。',
    owner_closed: '账号已注销。',
    idempotency_conflict: '项目已有不同的删除操作。',
} as const;

export type Operation =
    | TaskOperation
    | { kind: 'listProjects' }
    | { kind: 'purgeOwner' }
    | { kind: 'projectDeletionImpact'; projectId: string }
    | { kind: 'advanceProjectDeletion'; projectId: string; operationId: string }
    | {
          kind: 'acquireFileDeleteHold' | 'releaseFileDeleteHold';
          projectId: string;
          operationId: string;
      }
    | { kind: 'createProject'; input: ProjectInput; key?: string }
    | { kind: 'project' | 'listRuns'; projectId: string }
    | { kind: 'createRun'; projectId: string; prompt: string; key: string }
    | { kind: 'run' | 'diff' | 'cancelRun'; projectId: string; runId: string };

export type Result =
    | {
          status: 200 | 201 | 202;
          json:
              | Project
              | Run
              | { projects: Project[] }
              | { runs: Run[] }
              | { complete: boolean }
              | FileDeleteHold
              | ProjectDeletionImpact
              | { state: 'deleting' }
              | TaskResponse;
      }
    | { status: 200; diff: string }
    | { status: 204 };

export type Backend = (
    ownerId: string,
    operation: Operation,
) => Promise<Result>;

export class RequestError extends Error {
    readonly status: number;
    readonly code: string;
    readonly reason?: string;
    readonly issues?: { fileId: string; path: string; code: string }[];

    constructor(
        status: number,
        code: string,
        message: string,
        issues?: RequestError['issues'],
        reason?: string,
    ) {
        super(message);
        this.status = status;
        this.code = code;
        if (issues) this.issues = issues;
        if (reason) this.reason = reason;
    }
}

export const notFound = () =>
    new RequestError(404, 'not_found', '找不到该资源。');
export const conflict = (message: string) =>
    new RequestError(409, 'conflict', message);

export function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new RequestError(400, 'invalid_input', '请求必须是 JSON 对象。');
    }
    return value as Record<string, unknown>;
}

export function projectInput(value: unknown): ProjectInput {
    const { name, files } = object(value);
    if (typeof name !== 'string' || !name.trim() || !Array.isArray(files)) {
        throw new RequestError(
            400,
            'invalid_project',
            '请提供项目名称和文件列表。',
        );
    }
    if (files.length > maxSnapshotFiles) {
        throw new RequestError(
            413,
            'too_many_files',
            '项目最多包含 100 个文件。',
        );
    }

    const paths = new Set<string>();
    let bytes = 0;
    const snapshot = files.map((file: unknown) => {
        const { path, text } = object(file);
        if (
            typeof path !== 'string' ||
            /[\\\p{Cc}\p{Surrogate}]/u.test(path) ||
            path
                .split('/')
                .some((segment) => ['', '.', '..', '.git'].includes(segment)) ||
            paths.has(path)
        ) {
            throw new RequestError(400, 'invalid_path', '文件路径无效或重复。');
        }
        if (typeof text !== 'string' || /\p{Surrogate}/u.test(text)) {
            throw new RequestError(
                400,
                'invalid_file',
                '文件必须是 UTF-8 文本。',
            );
        }
        paths.add(path);
        bytes += Buffer.byteLength(text);
        return { path, text };
    });

    for (const path of paths) {
        const directory = path + '/';
        if (snapshot.some((file) => file.path.startsWith(directory))) {
            throw new RequestError(
                400,
                'path_conflict',
                '文件路径和目录路径冲突。',
            );
        }
    }
    if (bytes > maxSnapshotBytes) {
        throw new RequestError(
            413,
            'project_too_large',
            '项目文本内容最多 1 MiB。',
        );
    }
    return { name, files: snapshot };
}

export function runPrompt(value: unknown): string {
    const { prompt } = object(value);
    if (
        typeof prompt !== 'string' ||
        !prompt.trim() ||
        [...prompt.trim()].length > 8000
    ) {
        throw new RequestError(
            400,
            'invalid_prompt',
            '任务描述须为 1 至 8000 个字符。',
        );
    }
    return prompt.trim();
}

export function resourceId(value: unknown): string {
    if (
        typeof value !== 'string' ||
        !value ||
        value === '.' ||
        value === '..' ||
        /[/\\\p{Cc}\p{Surrogate}]/u.test(value)
    ) {
        throw notFound();
    }
    return value;
}

function field(value: unknown): string {
    if (typeof value !== 'string') throw new Error('Invalid field');
    return value;
}

function timestamp(value: unknown): string {
    const date = field(value);
    if (
        !/^\d{4}-\d{2}-\d{2}T/.test(date) ||
        !Number.isFinite(Date.parse(date))
    ) {
        throw new Error('Invalid timestamp');
    }
    return date;
}

function status<T extends string>(value: unknown, allowed: readonly T[]): T {
    const match = allowed.find((candidate) => candidate === value);
    if (!match) throw new Error('Invalid status');
    return match;
}

function project(value: unknown): Project {
    const data = object(value);
    return {
        id: resourceId(data.id),
        name: field(data.name),
        status: status(data.status, projectStatuses),
        createdAt: timestamp(data.createdAt),
    };
}

function run(value: unknown, projectId: string, runId?: string): Run {
    const data = object(value);
    const id = resourceId(data.id);
    if (data.projectId !== projectId || (runId !== undefined && id !== runId)) {
        throw new Error('Unexpected run');
    }
    return {
        id,
        projectId,
        sessionId: resourceId(data.sessionId),
        status: status(data.status, runStatuses),
        createdAt: timestamp(data.createdAt),
        updatedAt: timestamp(data.updatedAt),
        ...(data.summary === undefined ? {} : { summary: field(data.summary) }),
        ...(runId === undefined || data.prompt === undefined
            ? {}
            : { prompt: field(data.prompt) }),
    };
}

export function publicJson(operation: Operation, value: unknown) {
    switch (operation.kind) {
        case 'projectDeletionImpact': {
            const { runCount, diffCount, blockers } = object(value);
            if (
                typeof runCount !== 'number' ||
                !Number.isSafeInteger(runCount) ||
                runCount < 0 ||
                typeof diffCount !== 'number' ||
                !Number.isSafeInteger(diffCount) ||
                diffCount < 0 ||
                !Array.isArray(blockers) ||
                new Set(blockers).size !== blockers.length ||
                blockers.some(
                    (code) =>
                        code !== 'project_busy' && code !== 'project_importing',
                )
            )
                throw new Error('Invalid deletion impact');
            return {
                runCount,
                diffCount,
                blockers: blockers as ProjectDeletionBlocker[],
            };
        }
        case 'advanceProjectDeletion':
            if (object(value).state !== 'deleting')
                throw new Error('Invalid deletion receipt');
            return { state: 'deleting' as const };
        case 'acquireFileDeleteHold':
        case 'releaseFileDeleteHold': {
            const { state } = object(value);
            if (state !== 'held' && state !== 'denied' && state !== 'released')
                throw new Error('Invalid file deletion hold result');
            return { state } as const;
        }
        case 'purgeOwner': {
            const { complete } = object(value);
            if (typeof complete !== 'boolean')
                throw new Error('Invalid cleanup receipt');
            return { complete };
        }
        case 'listProjects': {
            const { projects } = object(value);
            if (!Array.isArray(projects)) throw new Error('Invalid projects');
            return { projects: projects.map(project) };
        }
        case 'createProject':
            return project(value);
        case 'project': {
            const result = project(value);
            if (result.id !== operation.projectId)
                throw new Error('Unexpected project');
            return result;
        }
        case 'listRuns': {
            const { runs } = object(value);
            if (!Array.isArray(runs)) throw new Error('Invalid runs');
            return { runs: runs.map((item) => run(item, operation.projectId)) };
        }
        case 'createRun':
            return run(value, operation.projectId);
        case 'run':
            return run(value, operation.projectId, operation.runId);
        case 'cancelRun': {
            const result = run(value, operation.projectId, operation.runId);
            if (
                !['cancelling', 'cancelled', 'needs_review'].includes(
                    result.status,
                )
            )
                throw new Error('Invalid cancellation status');
            return result;
        }
        default:
            throw new Error('Unexpected operation');
    }
}

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

type TaskResponse =
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
