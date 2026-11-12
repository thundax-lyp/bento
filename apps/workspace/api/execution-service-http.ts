import { RequestError, conflict, notFound, publicJson } from './protocol.ts';
import type { Backend, Operation } from './protocol.ts';

function route(operation: Operation): string {
    if (operation.kind === 'purgeOwner') return '/v1/account/purge';
    const projects = '/v1/projects';
    if (!('projectId' in operation)) return projects;
    const project = projects + '/' + encodeURIComponent(operation.projectId);
    if (operation.kind === 'project') return project;
    if ('operationId' in operation)
        return (
            project +
            '/file-deletion-holds/' +
            encodeURIComponent(operation.operationId)
        );
    const runs = project + '/runs';
    if (!('runId' in operation)) return runs;
    const run = runs + '/' + encodeURIComponent(operation.runId);
    return operation.kind === 'diff' ? run + '/diff' : run;
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
        if (body !== undefined) headers.set('Content-Type', 'application/json');

        const signal = AbortSignal.timeout(timeoutMs);
        try {
            const response = await fetch(origin + route(operation), {
                method:
                    operation.kind === 'releaseFileDeleteHold'
                        ? 'DELETE'
                        : operation.kind === 'acquireFileDeleteHold' ||
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
                await response.body?.cancel();
                throw upstreamError(status, operation);
            }
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
                (status === 201 && operation.kind === 'createProject') ||
                (status === 202 &&
                    (operation.kind === 'createRun' ||
                        operation.kind === 'purgeOwner')) ||
                (status === 200 &&
                    (operation.kind !== 'createProject' ||
                        operation.key !== undefined));
            if (!expectedStatus || type !== 'application/json') {
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
            if (signal.aborted) {
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
