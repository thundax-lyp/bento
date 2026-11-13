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

test('project deletion backend validates private requests and receipts', async () => {
    const projectId = 'fixture-project';
    const operationId = randomUUID();
    const requests: unknown[] = [];
    let status = 202;
    let value: unknown = { state: 'deleting' };
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push({
            method: request.method,
            path: request.url,
            owner: request.headers['x-bento-owner-id'],
            keys: request.headersDistinct['idempotency-key'],
            auth: request.headers.authorization,
            body: Buffer.concat(chunks).toString(),
        });
        if (status === 204) {
            response.writeHead(status).end();
        } else {
            response
                .writeHead(status, { 'Content-Type': 'application/json' })
                .end(JSON.stringify(value));
        }
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
        const remove = () =>
            backend('owner-a', {
                kind: 'advanceProjectDeletion',
                projectId,
                operationId,
            });
        const impact = () =>
            backend('owner-a', { kind: 'projectDeletionImpact', projectId });
        assert.deepEqual(await remove(), { status: 202, json: value });
        status = 204;
        assert.deepEqual(await remove(), { status: 204 });
        status = 200;
        value = { runCount: 1, diffCount: 1, blockers: [] };
        assert.deepEqual(await impact(), { status: 200, json: value });
        assert.deepEqual(requests, [
            ...Array.from({ length: 2 }, () => ({
                method: 'DELETE',
                path: '/v1/projects/' + projectId,
                owner: 'owner-a',
                keys: [operationId],
                auth: 'Bearer fixture-bearer',
                body: '',
            })),
            {
                method: 'GET',
                path: '/v1/projects/' + projectId + '/deletion',
                owner: 'owner-a',
                keys: undefined,
                auth: 'Bearer fixture-bearer',
                body: '',
            },
        ]);
        await assert.rejects(remove(), { status: 502 });
        for (const bad of [
            { runCount: -1, diffCount: 0, blockers: [] },
            { runCount: 0, diffCount: 0, blockers: ['unknown'] },
            {
                runCount: 0,
                diffCount: 0,
                blockers: ['project_busy', 'project_busy'],
            },
            { runCount: 0, diffCount: 0.5 },
        ]) {
            value = bad;
            await assert.rejects(impact(), { status: 502 });
        }
        status = 202;
        value = { state: 'held' };
        await assert.rejects(remove(), { status: 502 });
        status = 409;
        for (const code of [
            'project_busy',
            'project_importing',
            'owner_closed',
            'idempotency_conflict',
        ]) {
            value = { error: { code, message: 'private' } };
            await assert.rejects(
                remove(),
                (error) =>
                    error instanceof RequestError &&
                    error.status === 409 &&
                    error.code === code &&
                    error.message !== 'private',
            );
        }
        value = { error: { code: 'unknown' } };
        await assert.rejects(remove(), { status: 502 });
        status = 404;
        await assert.rejects(remove(), { status: 404, code: 'not_found' });
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test('project deletion backend mock keeps receipts owner-scoped', async () => {
    const backend = mockBackend();
    const create = (owner: string) =>
        backend(owner, {
            kind: 'createProject',
            input: { name: 'fixture', files: [] },
        });
    const [created, other] = await Promise.all([
        create('owner-a'),
        create('owner-b'),
    ]);
    assert('json' in created && 'id' in created.json);
    assert('json' in other && 'id' in other.json);
    const projectId = created.json.id;
    const operation = {
        kind: 'advanceProjectDeletion' as const,
        projectId,
        operationId: randomUUID(),
    };
    await assert.rejects(backend('owner-b', operation), { status: 404 });
    await assert.rejects(backend('owner-a', operation), {
        code: 'project_importing',
    });
    for (let i = 0; i < 40; i++) {
        const state = await backend('owner-a', { kind: 'project', projectId });
        if (
            'json' in state &&
            'status' in state.json &&
            state.json.status === 'ready'
        )
            break;
        await delay(25);
    }
    await assert.rejects(backend('owner-a', operation), {
        code: 'project_importing',
    });
    const accepted = { ...operation, operationId: randomUUID() };
    assert.deepEqual(await backend('owner-a', accepted), { status: 204 });
    assert.deepEqual(await backend('owner-a', accepted), { status: 204 });
    await assert.rejects(backend('owner-b', accepted), { status: 404 });
    await assert.rejects(backend('owner-a', { kind: 'listRuns', projectId }), {
        status: 404,
    });
    assert.equal(
        (
            await backend('owner-b', {
                kind: 'listRuns',
                projectId: other.json.id,
            })
        ).status,
        200,
    );
});
