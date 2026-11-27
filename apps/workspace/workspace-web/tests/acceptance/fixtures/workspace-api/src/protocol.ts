import type { TaskOperation, TaskResponse } from './task-protocol.ts';
import {
    RequestError,
    field,
    object,
    resourceId,
    runStatuses,
    status,
    timestamp,
} from './protocol-values.ts';
export {
    RequestError,
    conflict,
    notFound,
    object,
    resourceId,
    runPrompt,
} from './protocol-values.ts';
export {
    createTaskInput,
    isTaskOperation,
    parseTaskRequest,
    taskKey,
    taskResponse,
} from './task-protocol.ts';
export type {
    CreateTaskInput,
    FrozenTaskInput,
    TaskOperation,
    TaskSource,
} from './task-protocol.ts';

import { maxSnapshotBytes, maxSnapshotFiles } from '@/shared/text-snapshot.ts';

const projectStatuses = ['importing', 'ready', 'failed'] as const;
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
export type ProjectDeletionImpact = {
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
