import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { httpBackend } from './execution-service-http.ts';
import { mockBackend } from './mock.ts';
import { RequestError } from './protocol.ts';

test('file delete hold uses the private HTTP methods and validates the receipt', async () => {
    const requests: unknown[] = [];
    const owner = 'owner-a';
    const projectId = 'fixture-project';
    const operationId = randomUUID();
    const path =
        '/v1/projects/' + projectId + '/file-deletion-holds/' + operationId;
    let state = 'held';
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push({
            method: request.method,
            path: request.url,
            owner: request.headers['x-bento-owner-id'],
            body: Buffer.concat(chunks).toString('utf8'),
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ state }));
    });
    const ready = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await ready;
    try {
        const address = server.address();
        assert(address && typeof address !== 'string');
        const backend = httpBackend(
            'http://127.0.0.1:' + address.port,
            'fixture-bearer',
            1000,
        );
        const acquire = {
            kind: 'acquireFileDeleteHold' as const,
            projectId,
            operationId,
        };
        assert.deepEqual(await backend(owner, acquire), {
            status: 200,
            json: { state: 'held' },
        });
        state = 'released';
        assert.deepEqual(
            await backend(owner, { ...acquire, kind: 'releaseFileDeleteHold' }),
            { status: 200, json: { state: 'released' } },
        );
        state = 'unrecognized';
        await assert.rejects(
            backend(owner, acquire),
            (error) => error instanceof RequestError && error.status === 502,
        );
        assert.deepEqual(
            requests,
            ['POST', 'DELETE', 'POST'].map((method) => ({
                method,
                path,
                owner,
                body: '',
            })),
        );
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
        });
    }
});

test('mock file delete hold blocks new runs and cannot revive after release', async () => {
    const backend = mockBackend();
    const owner = 'owner-a';
    const created = await backend(owner, {
        kind: 'createProject',
        input: { name: 'Fixture', files: [] },
    });
    assert('json' in created && 'id' in created.json);
    const projectId = created.json.id;
    for (let i = 0; i < 100; i++) {
        const current = await backend(owner, { kind: 'project', projectId });
        if (
            'json' in current &&
            'status' in current.json &&
            current.json.status === 'ready'
        )
            break;
        await delay(10);
    }
    const acquire = {
        kind: 'acquireFileDeleteHold' as const,
        projectId,
        operationId: randomUUID(),
    };
    assert.deepEqual(await backend(owner, acquire), {
        status: 200,
        json: { state: 'held' },
    });
    const run = {
        kind: 'createRun' as const,
        projectId,
        key: 'fixture',
        prompt: 'Fixture',
    };
    await assert.rejects(
        backend(owner, run),
        (error) => error instanceof RequestError && error.status === 409,
    );
    assert.deepEqual(
        await backend(owner, { ...acquire, kind: 'releaseFileDeleteHold' }),
        { status: 200, json: { state: 'released' } },
    );
    assert.deepEqual(await backend(owner, acquire), {
        status: 200,
        json: { state: 'released' },
    });
    assert.equal((await backend(owner, run)).status, 202);
});
