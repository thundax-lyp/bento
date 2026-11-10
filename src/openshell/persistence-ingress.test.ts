import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { test } from 'node:test';
import { Authority } from './authority.ts';
import { createPersistenceIngress } from './persistence-ingress.ts';
import { WorkerGate } from './worker-gate.ts';

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
