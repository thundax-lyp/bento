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
        const body: { error?: { message?: string } } | null = await response
            .json()
            .catch(() => null);
        throw new ApiError(
            response.status,
            body?.error?.message ?? '请求失败，请稍后重试。',
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
    status === 'queued' ||
    status === 'running' ||
    status === 'recovering' ||
    status === 'cancelling' ||
    status === 'needs_review';
export const runLabels: Record<Run['status'], string> = {
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
