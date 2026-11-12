import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { httpBackend } from './execution-service-http.ts';

test('cancel proxy keeps owner, route, status and detail projection', async () => {
    const view = {
        id: 'run',
        projectId: 'project',
        sessionId: 'session',
        status: 'cancelling',
        prompt: 'original prompt',
        createdAt: '2026-11-12T00:00:00Z',
        updatedAt: '2026-11-12T00:01:00Z',
    };
    const requests: unknown[] = [];
    let status = 200;
    const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        requests.push({
            method: request.method,
            path: request.url,
            owner: request.headers['x-bento-owner-id'],
            body: Buffer.concat(chunks).toString(),
        });
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(
            JSON.stringify(
                status === 200 ? view : { error: { message: 'private' } },
            ),
        );
    }).listen(0, '127.0.0.1');
    try {
        await once(server, 'listening');
        const address = server.address();
        assert(address && typeof address !== 'string');
        const invoke = httpBackend(
            'http://127.0.0.1:' + address.port,
            'fixture-bearer',
            3000,
        );
        const ids = { projectId: 'project', runId: 'run' };
        const cancel = () => invoke('owner-a', { kind: 'cancelRun', ...ids });
        for (const state of ['cancelling', 'cancelled', 'needs_review']) {
            view.status = state;
            assert.deepEqual(await cancel(), { status: 200, json: view });
        }
        status = 404;
        await assert.rejects(cancel(), { status: 404, code: 'not_found' });
        status = 409;
        await assert.rejects(cancel(), {
            status: 409,
            code: 'conflict',
            message: '当前任务状态不能取消。',
        });
        status = 200;
        view.status = 'running';
        await assert.rejects(cancel(), { status: 502 });
        view.status = 'cancelled';
        assert.deepEqual(await invoke('owner-a', { kind: 'run', ...ids }), {
            status: 200,
            json: view,
        });
        const route = '/v1/projects/project/runs/run';
        assert.deepEqual(requests, [
            ...Array.from({ length: 6 }, () => ({
                method: 'POST',
                path: route + '/cancel',
                owner: 'owner-a',
                body: '',
            })),
            { method: 'GET', path: route, owner: 'owner-a', body: '' },
        ]);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
