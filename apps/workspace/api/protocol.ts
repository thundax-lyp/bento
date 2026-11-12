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

export type Operation =
    | { kind: 'listProjects' }
    | { kind: 'purgeOwner' }
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
              | FileDeleteHold;
      }
    | { status: 200; diff: string };

export type Backend = (
    ownerId: string,
    operation: Operation,
) => Promise<Result>;

export class RequestError extends Error {
    readonly status: number;
    readonly code: string;
    readonly issues?: { fileId: string; path: string; code: string }[];

    constructor(
        status: number,
        code: string,
        message: string,
        issues?: RequestError['issues'],
    ) {
        super(message);
        this.status = status;
        this.code = code;
        if (issues) this.issues = issues;
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
    if (files.length > 100) {
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
    if (bytes > 1024 * 1024) {
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
