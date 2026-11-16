import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { test } from 'node:test';
import { Authority } from './authority.ts';
import { createPersistenceIngress } from './persistence-ingress.ts';
import { WorkerGate } from './worker-gate.ts';
import { SingleHostExecution } from './single-host.ts';
import type { VerifiedStopProof } from './session-history.ts';

test(
    'persistence dispatch preserves UTF-8 split across HTTP chunks',
    { timeout: 5000 },
    async () => {
        const authority = new Authority(':memory:');
        const gate = new WorkerGate(authority);
        const binding = {
            tenant: 'tenant',
            project: 'project',
            session: 'session',
            sandbox: 'sandbox',
            volume: 'volume',
        };
        authority.bind(binding, {
            sandbox: binding.sandbox,
            generation: 1,
            installed: true,
        });
        const token = authority.admit(binding.session, 1, 'run', 10_000);
        const grant = {
            token,
            session: binding.session,
            run: 'run',
            generation: 1,
            backendToken: 'fixture',
        };
        let dispatched: string | undefined;
        const server = createPersistenceIngress(
            gate,
            (authorization) =>
                authorization === `Bearer ${token}` ? grant : undefined,
            async (body) => {
                dispatched = body;
                return { status: 200, body: '{}' };
            },
        );
        server.listen(0, '127.0.0.1');
        try {
            await once(server, 'listening');
            const address = server.address();
            assert(address && typeof address === 'object');
            const received = new Promise<void>((resolve) => {
                server.once('request', (incoming) => {
                    incoming.once('data', () => resolve());
                });
            });
            const payload = JSON.stringify({
                id: binding.session,
                text: '中文',
            });
            const bytes = Buffer.from(payload);
            const split = bytes.indexOf(Buffer.from('中')) + 1;
            const outgoing = request({
                host: '127.0.0.1',
                port: address.port,
                method: 'POST',
                path: '/rpc',
                headers: { authorization: `Bearer ${token}` },
            });
            const response = once(outgoing, 'response');
            outgoing.write(bytes.subarray(0, split));
            await received;
            outgoing.end(bytes.subarray(split));
            const [result] = await response;
            result.resume();
            assert.equal(result.statusCode, 200);
            assert.equal(dispatched, payload);
        } finally {
            server.close();
            server.closeAllConnections();
            gate.close();
            authority.close();
        }
    },
);

test('an absent history checkpoint restores only behind the new authority fence', async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'bento-history-fence-'));
    const binding = {
        tenant: 'tenant',
        project: 'project',
        session: randomUUID(),
        sandbox: 'sandbox',
        volume: 'volume',
    };
    const observation = {
        sandbox: binding.sandbox,
        volume: binding.volume,
        running: true,
        installed: true,
    };
    let running = true;
    const controller = new SingleHostExecution(
        {
            authority: join(folder, 'authority.sqlite'),
            history: join(folder, 'history.sqlite'),
        },
        {
            async stop() {
                running = false;
            },
            async start() {
                running = true;
            },
            async stopped() {
                return !running;
            },
            async running() {
                return { ...observation, running };
            },
        },
    );
    const server = controller.persistenceIngress();
    t.after(async () => {
        server.close();
        server.closeAllConnections();
        controller.close();
        await rm(folder, { recursive: true, force: true });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address === 'object');
    const rpc = (token: string, method: string) =>
        fetch(`http://127.0.0.1:${address.port}/rpc`, {
            method: 'POST',
            headers: { authorization: 'Bearer ' + token },
            body: JSON.stringify({ method, id: binding.session }),
        });
    controller.bind(binding, observation);
    const source = randomUUID();
    const next = randomUUID();
    const checkpoint = controller.checkpointHistory(binding.session, source, 1);
    const proof = {
        attemptId: randomUUID(),
        taskId: binding.project,
        sourceRunId: source,
        newRunId: next,
        sessionId: binding.session,
        oldGeneration: 1,
        newGeneration: 2,
        checkpointSha256: checkpoint.sha256,
    } as VerifiedStopProof;
    const stale = controller.admit(binding.session, 1, source, 10_000);
    assert.throws(() => controller.restoreHistory(proof), /not ready/);
    assert.equal((await rpc(stale.token, 'stat')).status, 200);
    await controller.takeover(binding.session, 1);
    assert.deepEqual(controller.restoreHistory(proof), checkpoint);
    assert.equal(controller.restoredHistoryDigest(proof), checkpoint.sha256);
    const fresh = controller.admit(binding.session, 2, next, 10_000);
    assert.equal((await rpc(stale.token, 'stat')).status, 403);
    assert.equal((await rpc(fresh.token, 'stat')).status, 200);
});
