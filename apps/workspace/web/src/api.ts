import { queryOptions } from '@tanstack/react-query';

export type Session = { account: string };
export type Project = {
    id: string;
    name: string;
    createdAt: string;
    status: 'importing' | 'ready' | 'failed';
};
export type Run = {
    id: string;
    projectId: string;
    sessionId: string;
    createdAt: string;
    status:
        | 'pending_approval'
        | 'queued'
        | 'running'
        | 'recovering'
        | 'needs_review'
        | 'cancelling'
        | 'cancelled'
        | 'succeeded'
        | 'failed';
    updatedAt: string;
    summary?: string;
    prompt?: string;
};

export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly code?: string,
        readonly reason?: string,
        readonly issues?: { path: string; code: string }[],
    ) {
        super(message);
    }
}

export function isUnavailableRun(error: unknown): boolean {
    return (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 404)
    );
}

export async function request(path: string, init?: RequestInit) {
    const response = await fetch(path, { credentials: 'same-origin', ...init });
    if (!response.ok) {
        const body: {
            error?: {
                message?: string;
                code?: string;
                reason?: string;
                issues?: ApiError['issues'];
            };
        } | null = await response.json().catch(() => null);
        throw new ApiError(
            response.status,
            body?.error?.message ?? '请求失败，请稍后重试。',
            body?.error?.code,
            body?.error?.reason,
            body?.error?.issues,
        );
    }
    return response;
}

export async function json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await request(path, init)).json() as Promise<T>;
}

export function post<T>(path: string, body: unknown, key?: string) {
    return json<T>(path, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(key ? { 'Idempotency-Key': key } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
    });
}

const projectApi = (id: string) => '/api/projects/' + encodeURIComponent(id);
const runsApi = (id: string) => projectApi(id) + '/runs';
const runApi = (project: string, run: string) =>
    runsApi(project) + '/' + encodeURIComponent(run);

export const runUrl = (project: string, run: string) =>
    '/runs/' + encodeURIComponent(run) + '?' + new URLSearchParams({ project });
export const downloadUrl = (project: string, run: string) =>
    runApi(project, run) + '/diff?download=1';
export const isActive = (status: Run['status'] | undefined) =>
    status === 'pending_approval' ||
    status === 'queued' ||
    status === 'running' ||
    status === 'recovering' ||
    status === 'cancelling' ||
    status === 'needs_review';
export const runLabels: Record<Run['status'], string> = {
    pending_approval: '待审批',
    queued: '排队中',
    running: '运行中',
    recovering: '恢复中',
    needs_review: '待核对',
    cancelling: '取消中',
    cancelled: '已取消',
    succeeded: '已完成',
    failed: '失败',
};

export const login = (account: string, password: string) =>
    post<Session>('/api/login', { account, password });
export const register = (account: string, invite: string, password: string) =>
    post<Session>('/api/register', { account, invite, password });
export const closeAccount = (password: string) =>
    post<Record<string, never>>('/api/account/close', {
        password,
        confirmed: true,
    });
export const logout = () => post<Record<string, never>>('/api/logout', {});
export const createProject = (
    name: string,
    files: { path: string; text: string }[],
) => post<Project>('/api/projects', { name, files });
export const createRun = (project: string, prompt: string, key: string) =>
    post<Run>(runsApi(project), { prompt }, key);

export const cancelRun = (project: string, run: string): Promise<Run> =>
    json<Run>(runApi(project, run) + '/cancel', {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
    });

export const sessionQuery = queryOptions({
    queryKey: ['session'],
    queryFn: ({ signal }) => json<Session>('/api/session', { signal }),
    retry: false,
    staleTime: 0,
});

export const projectsQuery = (account: string) =>
    queryOptions({
        queryKey: ['account', account, 'projects'],
        queryFn: async ({ signal }) =>
            (await json<{ projects: Project[] }>('/api/projects', { signal }))
                .projects,
        refetchInterval: ({ state }) =>
            state.data?.some((project) => project.status === 'importing')
                ? 1500
                : false,
    });

export const runsQuery = (account: string, project: string) =>
    queryOptions({
        queryKey: ['account', account, 'runs', project],
        queryFn: async ({ signal }) =>
            (await json<{ runs: Run[] }>(runsApi(project), { signal })).runs,
        refetchInterval: ({ state }) =>
            state.data?.some((run) => isActive(run.status)) ? 2000 : false,
    });

export const runQuery = (account: string, project: string, run: string) =>
    queryOptions({
        queryKey: ['account', account, 'run', project, run],
        queryFn: ({ signal }) => json<Run>(runApi(project, run), { signal }),
        staleTime: 0,
        refetchOnReconnect: 'always',
        refetchInterval: ({ state }) =>
            !isUnavailableRun(state.error) && isActive(state.data?.status)
                ? 1500
                : false,
    });

export const diffQuery = (account: string, project: string, run: string) =>
    queryOptions({
        queryKey: ['account', account, 'diff', project, run],
        staleTime: 0,
        refetchOnReconnect: 'always',
        queryFn: async ({ signal }) =>
            (await request(runApi(project, run) + '/diff', { signal })).text(),
    });

export type Task = {
    id: string;
    name: string;
    sourceSpaceId: string | null;
    inputDigest: string;
    environmentVersion: string;
    status: 'preparing' | 'ready' | 'failed' | 'deleting';
    prepareError: string | null;
    closedReason: string | null;
    reconciliation: {
        attemptId: string;
        state: 'blocked';
        reason: 'restore_conflict';
    } | null;
    inputs: { fileId: string; path: string; bytes: number; sha256: string }[];
    createdAt: string;
    updatedAt: string;
};
export type TaskRun = {
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
export type TaskCheck = {
    name: string;
    status: 'passed' | 'failed' | 'not_run' | 'unavailable';
    output: string | null;
};
export type TaskEvent = {
    id: string;
    sequence: number;
    runId: string;
    at: string;
    kind: 'user_message' | 'agent_reply' | 'step' | 'command' | 'check';
    text: string;
    check: TaskCheck | null;
};
export type TaskResult = {
    runId: string;
    version: number;
    summary: string;
    checks: TaskCheck[];
    incrementalSha256: string;
    cumulativeSha256: string;
    createdAt: string;
};
type TaskSource =
    | { kind: 'blank' }
    | { kind: 'space_snapshot'; spaceId: string; fileIds: string[] };
type TaskRetry = {
    id: string;
    runId: string;
    state: 'preparing' | 'queued' | 'blocked' | 'closed';
};

export const taskUrl = (taskId: string, runId?: string) =>
    '/tasks/' +
    encodeURIComponent(taskId) +
    (runId ? '?' + new URLSearchParams({ run: runId }) : '');
export const taskApi = (taskId: string) => '/api' + taskUrl(taskId);
const taskRunApi = (taskId: string, runId: string) =>
    taskApi(taskId) + '/runs/' + encodeURIComponent(runId);

export const taskListQuery = (account: string) =>
    queryOptions({
        queryKey: ['account', account, 'tasks'],
        queryFn: async ({ signal }) =>
            (await json<{ items: Task[] }>('/api/tasks', { signal })).items,
    });
export const taskDetailsQuery = (account: string, id: string) =>
    queryOptions({
        queryKey: ['account', account, 'task', id],
        queryFn: async ({ signal }) =>
            (await json<{ task: Task }>(taskApi(id), { signal })).task,
        refetchInterval: 1000,
    });
export const taskRunsQuery = (account: string, id: string) =>
    queryOptions({
        queryKey: ['account', account, 'task-runs', id],
        queryFn: async ({ signal }) =>
            (
                await json<{ items: TaskRun[] }>(taskApi(id) + '/runs', {
                    signal,
                })
            ).items,
        refetchInterval: 1000,
    });
export const taskEventsQuery = (account: string, id: string) =>
    queryOptions({
        queryKey: ['account', account, 'task-events', id],
        queryFn: async ({ signal, client, queryKey }) => {
            const prior = client.getQueryData<TaskEvent[]>(queryKey) ?? [];
            const after = prior.at(-1)?.sequence ?? 0;
            const incoming = (
                await json<{ items: TaskEvent[] }>(
                    taskApi(id) + '/events?after=' + after,
                    { signal },
                )
            ).items;
            const events = new Map(prior.map((event) => [event.id, event]));
            for (const event of incoming)
                if (!events.has(event.id)) events.set(event.id, event);
            return [...events.values()].sort((a, b) => a.sequence - b.sequence);
        },
        refetchInterval: 1000,
    });

export const taskResultQuery = (
    account: string,
    taskId: string,
    runId: string,
    version: number | null,
) =>
    queryOptions({
        queryKey: ['account', account, 'task-result', taskId, runId, version],
        queryFn: async ({ signal }) =>
            (
                await json<{ result: TaskResult }>(
                    taskRunApi(taskId, runId) + '/results',
                    { signal },
                )
            ).result,
        enabled: !!version,
    });
export type DiffView = 'incremental' | 'cumulative';
export const taskDiffUrl = (
    taskId: string,
    runId: string,
    version: number,
    view: DiffView,
    download = false,
) =>
    taskRunApi(taskId, runId) +
    '/results/' +
    version +
    '/diff?' +
    new URLSearchParams({ view, ...(download ? { download: '1' } : {}) });

export const tasksUnavailable = (error: unknown) =>
    error instanceof ApiError &&
    error.status === 503 &&
    error.code === 'tasks_unavailable';

async function taskMutation<T>(
    account: string,
    kind: string,
    scope: string,
    path: string,
    body?: unknown,
) {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(body ?? null)),
    );
    const signature = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
    ).join('');
    const storageKey = JSON.stringify([
        'bento:task-mutation',
        account,
        kind,
        scope,
        signature,
    ]);
    const key = sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
    sessionStorage.setItem(storageKey, key);
    try {
        const result =
            body === undefined
                ? await json<T>(path, {
                      method: 'POST',
                      headers: { 'Idempotency-Key': key },
                      signal: AbortSignal.timeout(15_000),
                  })
                : await post<T>(path, body, key);
        sessionStorage.removeItem(storageKey);
        return result;
    } catch (error) {
        if (
            error instanceof ApiError &&
            error.status >= 400 &&
            error.status < 500
        )
            sessionStorage.removeItem(storageKey);
        throw error;
    }
}

export const createTask = (
    account: string,
    name: string,
    source: TaskSource,
) => {
    const normalized =
        source.kind === 'space_snapshot'
            ? { ...source, fileIds: [...source.fileIds].sort() }
            : source;
    return taskMutation<{ task: Task }>(
        account,
        'create',
        source.kind === 'blank' ? 'blank' : source.spaceId,
        '/api/tasks',
        { name: name.trim(), source: normalized },
    ).then((result) => result.task);
};
export const createTaskRun = (account: string, id: string, prompt: string) =>
    taskMutation<{ run: TaskRun }>(
        account,
        'continue',
        id,
        taskApi(id) + '/runs',
        { prompt: prompt.trim() },
    ).then((result) => result.run);
export const retryTaskRun = (account: string, id: string, runId: string) =>
    taskMutation<{ retry: TaskRetry }>(
        account,
        'retry',
        id + ':' + runId,
        taskRunApi(id, runId) + '/retry',
    ).then((result) => result.retry);
export const prepareTask = (id: string) =>
    json<{ task: Task }>(taskApi(id) + '/prepare', { method: 'POST' });
export const cancelTaskRun = (id: string, runId: string) =>
    json<{ run: TaskRun }>(taskRunApi(id, runId) + '/cancel', {
        method: 'POST',
    });
