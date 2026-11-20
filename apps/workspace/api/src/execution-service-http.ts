import {
    RequestError,
    isTaskOperation,
    taskResponse,
    conflict,
    notFound,
    projectDeletionConflicts,
    object,
    publicJson,
} from './protocol.ts';
import type { Backend, Operation, Result, TaskOperation } from './protocol.ts';

function route(operation: Operation): string {
    if (operation.kind === 'purgeOwner') return '/v1/account/purge';
    const projects = '/v1/projects';
    if (!('projectId' in operation)) return projects;
    const project = projects + '/' + encodeURIComponent(operation.projectId);
    if (
        operation.kind === 'project' ||
        operation.kind === 'advanceProjectDeletion'
    )
        return project;
    if (operation.kind === 'projectDeletionImpact')
        return project + '/deletion';
    if ('operationId' in operation)
        return (
            project +
            '/file-deletion-holds/' +
            encodeURIComponent(operation.operationId)
        );
    const runs = project + '/runs';
    if (!('runId' in operation)) return runs;
    const run = runs + '/' + encodeURIComponent(operation.runId);
    if (operation.kind === 'diff') return run + '/diff';
    if (operation.kind === 'cancelRun') return run + '/cancel';
    return run;
}

function upstreamError(status: number, operation: Operation): RequestError {
    switch (status) {
        case 400:
            return new RequestError(
                400,
                'invalid_input',
                '任务服务拒绝了请求内容。',
            );
        case 404:
            return notFound();
        case 409:
            if (operation.kind === 'cancelRun')
                return conflict('当前任务状态不能取消。');
            return conflict(
                operation.kind === 'diff'
                    ? '成果尚未可用。'
                    : '当前项目状态不允许提交，或此提交键已用于其他内容。',
            );
        case 429:
            return new RequestError(
                429,
                'tenant_queue_full',
                '当前账号的任务队列已满。等一个排队任务开始后再提交。',
            );
        case 413:
            return new RequestError(
                413,
                'too_large',
                '导入内容超过任务服务的限制。',
            );
        default:
            return new RequestError(
                502,
                'backend_error',
                '任务服务暂不可用，请稍后重试。',
            );
    }
}

function taskForward(operation: TaskOperation) {
    if (operation.kind === 'drainOwner')
        return { method: 'POST', path: '/v1/account/drain' };
    if (operation.kind === 'createTask')
        return {
            method: 'POST',
            path: '/v1/tasks',
            key: operation.key,
            body: operation.input,
        };
    if (operation.kind === 'taskCreationReceipt')
        return {
            method: 'GET',
            path: '/v1/tasks?creationKey=' + encodeURIComponent(operation.key),
        };
    if (operation.kind === 'taskRequest')
        return {
            method: operation.method,
            path:
                '/v1' +
                operation.path +
                (operation.query ? '?' + operation.query : ''),
            key: operation.key,
            body:
                operation.prompt === undefined
                    ? undefined
                    : { prompt: operation.prompt },
        };
    const params = new URLSearchParams();
    if (operation.legacyProjectId !== null)
        params.set('legacyProjectId', operation.legacyProjectId);
    let path = '/v1/task-sources/' + encodeURIComponent(operation.spaceId);
    if (operation.kind === 'taskSourceDeletion') {
        params.set('phase', operation.phase);
        return {
            method: 'DELETE',
            path: path + '?' + params.toString(),
            key: operation.operationId,
        };
    }
    const query = params.size ? '?' + params.toString() : '';
    if (operation.kind === 'taskSourceImpact')
        return { method: 'GET', path: path + '/deletion' + query };
    path +=
        '/files/' +
        encodeURIComponent(operation.fileId) +
        '/deletion-holds/' +
        encodeURIComponent(operation.operationId);
    return {
        method:
            operation.kind === 'acquireTaskInputDeleteHold' ? 'POST' : 'DELETE',
        path: path + query,
    };
}

async function forwardTask(
    origin: string,
    operation: TaskOperation,
    headers: Headers,
    signal: AbortSignal,
): Promise<Result> {
    const { method, path, key, body } = taskForward(operation);
    if (key) headers.set('Idempotency-Key', key);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(origin + path, {
        method,
        headers,
        redirect: 'error',
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const { status } = response;
    const type = response.headers
        .get('content-type')
        ?.split(';')[0]
        ?.trim()
        .toLowerCase();
    if (!response.ok) {
        if (status === 404) {
            await response.body?.cancel();
            throw notFound();
        }
        if (type === 'application/json' && (status === 400 || status === 409)) {
            const { code, reason } = object(
                object(await response.json()).error,
            );
            const accepted =
                status === 400
                    ? ['invalid_input', 'invalid_key']
                    : [
                          'idempotency_conflict',
                          'task_not_ready',
                          'task_busy',
                          'run_not_cancellable',
                          'run_not_retryable',
                          'diff_unavailable',
                          'project_busy',
                          'project_importing',
                          'owner_closed',
                          'deletion_released',
                          'deletion_not_held',
                          'deletion_committed',
                      ];
            if (typeof code === 'string' && accepted.includes(code))
                throw new RequestError(
                    status,
                    code,
                    '当前请求无法执行。',
                    undefined,
                    code === 'run_not_retryable' &&
                        typeof reason === 'string' &&
                        [
                            'task_closed',
                            'not_latest',
                            'not_terminal',
                            'needs_review',
                            'stop_unconfirmed',
                            'checkpoint_unavailable',
                            'environment_unavailable',
                            'task_busy',
                            'task_not_ready',
                        ].includes(reason)
                        ? reason
                        : undefined,
                );
            throw new Error('Unexpected Task error code');
        }
        await response.body?.cancel();
        throw upstreamError(status, operation);
    }
    if (
        status === 204 &&
        (operation.kind === 'drainOwner' ||
            operation.kind === 'taskSourceDeletion')
    )
        return { status };
    if (operation.kind === 'taskRequest' && operation.action === 'taskDiff') {
        if (status !== 200 || type !== 'text/plain')
            throw new Error('Invalid Task diff');
        return {
            status,
            diff: new TextDecoder('utf-8', {
                fatal: true,
                ignoreBOM: true,
            }).decode(await response.arrayBuffer()),
        };
    }
    const accepts202 =
        operation.kind === 'createTask' ||
        operation.kind === 'taskSourceDeletion' ||
        (operation.kind === 'taskRequest' &&
            (operation.action === 'createTaskRun' ||
                operation.action === 'retryTaskRun'));
    if (
        type !== 'application/json' ||
        (status !== 200 && !(accepts202 && status === 202))
    ) {
        await response.body?.cancel();
        throw new Error('Invalid Task response');
    }
    return { status, json: taskResponse(operation, await response.json()) };
}

export function httpBackend(
    origin: string,
    bearer: string,
    timeoutMs: number,
): Backend {
    return async (ownerId, operation) => {
        const headers = new Headers({
            Authorization: 'Bearer ' + bearer,
            'X-Bento-Owner-Id': ownerId,
        });
        let body: string | undefined;
        if (operation.kind === 'purgeOwner') body = '{}';
        if (operation.kind === 'createProject') {
            body = JSON.stringify(operation.input);
            if (operation.key) headers.set('Idempotency-Key', operation.key);
        }
        if (operation.kind === 'createRun') {
            body = JSON.stringify({ prompt: operation.prompt });
            headers.set('Idempotency-Key', operation.key);
        }
        if (operation.kind === 'advanceProjectDeletion')
            headers.set('Idempotency-Key', operation.operationId);
        if (body !== undefined) headers.set('Content-Type', 'application/json');

        const signal = AbortSignal.timeout(timeoutMs);
        try {
            if (isTaskOperation(operation))
                return await forwardTask(origin, operation, headers, signal);
            const response = await fetch(origin + route(operation), {
                method:
                    operation.kind === 'releaseFileDeleteHold' ||
                    operation.kind === 'advanceProjectDeletion'
                        ? 'DELETE'
                        : operation.kind === 'acquireFileDeleteHold' ||
                            operation.kind === 'cancelRun' ||
                            body !== undefined
                          ? 'POST'
                          : 'GET',
                headers,
                redirect: 'error',
                signal,
                ...(body === undefined ? {} : { body }),
            });
            const { status } = response;
            if (!response.ok) {
                if (
                    status === 409 &&
                    operation.kind === 'advanceProjectDeletion'
                ) {
                    const type = response.headers
                        .get('content-type')
                        ?.split(';')[0]
                        ?.trim()
                        .toLowerCase();
                    if (type !== 'application/json') {
                        await response.body?.cancel();
                        throw new Error('Invalid deletion error');
                    }
                    const { code } = object(
                        object(await response.json()).error,
                    );
                    if (
                        typeof code !== 'string' ||
                        !Object.hasOwn(projectDeletionConflicts, code)
                    )
                        throw new Error('Invalid deletion error code');
                    const known = code as keyof typeof projectDeletionConflicts;
                    throw new RequestError(
                        409,
                        known,
                        projectDeletionConflicts[known],
                    );
                }
                await response.body?.cancel();
                throw upstreamError(status, operation);
            }
            if (operation.kind === 'advanceProjectDeletion' && status === 204)
                return { status: 204 };
            const type = response.headers
                .get('content-type')
                ?.split(';')[0]
                ?.trim()
                .toLowerCase();
            if (operation.kind === 'diff') {
                if (status !== 200 || type !== 'text/plain') {
                    await response.body?.cancel();
                    throw new Error('Invalid diff response');
                }
                const diff = new TextDecoder('utf-8', {
                    fatal: true,
                    ignoreBOM: true,
                }).decode(await response.arrayBuffer());
                return { status, diff };
            }
            const expectedStatus =
                operation.kind === 'advanceProjectDeletion'
                    ? status === 202
                    : operation.kind === 'projectDeletionImpact'
                      ? status === 200
                      : (status === 201 &&
                            operation.kind === 'createProject') ||
                        (status === 202 &&
                            (operation.kind === 'createRun' ||
                                operation.kind === 'purgeOwner')) ||
                        (status === 200 &&
                            (operation.kind !== 'createProject' ||
                                operation.key !== undefined));
            if (
                (status !== 200 && status !== 201 && status !== 202) ||
                !expectedStatus ||
                type !== 'application/json'
            ) {
                await response.body?.cancel();
                throw new Error('Invalid JSON response');
            }
            const value: unknown = await response.json();
            try {
                return { status, json: publicJson(operation, value) };
            } catch {
                throw new Error('Invalid response fields');
            }
        } catch (error) {
            if (error instanceof RequestError) {
                throw error;
            }
            if (signal.aborted && !isTaskOperation(operation)) {
                throw new RequestError(
                    504,
                    'backend_timeout',
                    '任务服务响应超时，请用原提交重试。',
                );
            }
            throw new RequestError(
                502,
                'backend_error',
                '任务服务暂不可用，请稍后重试。',
            );
        }
    };
}
