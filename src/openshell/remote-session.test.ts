import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import {
    reconcileSessionPersistence,
    remoteSessionPersistence,
} from './remote-session.ts';
import { SessionHistory } from './session-history.ts';

test('reconciliation retries with the same writer after a dropped RPC', async () => {
    const ctx = new Context();
    const history = new SessionHistory(':memory:');
    const id = 'session' as Parameters<typeof reconcileSessionPersistence>[1];
    const grant = { session: id, generation: 1, run: 'run' };
    const methods: string[] = [];
    let drop: 'reconcile' | 'close' | undefined;
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request as AsyncIterable<Buffer>)
            chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        const { method } = JSON.parse(body) as { method: string };
        methods.push(method);
        const disconnect = drop === method;
        if (disconnect) drop = undefined;
        if (disconnect && method === 'reconcile') {
            response.destroy();
            return;
        }
        const result = history.dispatch(body, grant);
        if (disconnect) response.destroy();
        else response.writeHead(result.status).end(result.body);
    });
    server.listen(0, '127.0.0.1');
    try {
        await once(server, 'listening');
        const address = server.address();
        assert(address && typeof address === 'object');
        await ctx.plugin(remoteSessionPersistence, {
            url: `http://127.0.0.1:${address.port}`,
            token: 'fixture',
        });
        const persistence = ctx.sessionPersistence;
        const writer = await persistence.create({
            id,
            version: 4,
            createdAt: Date.now(),
            isSeeded: false,
        });
        await writer.flush();
        await writer.close();
        methods.length = 0;

        drop = 'reconcile';
        await assert.rejects(
            reconcileSessionPersistence(persistence, id),
            TypeError,
        );
        drop = 'close';
        await assert.rejects(
            reconcileSessionPersistence(persistence, id),
            TypeError,
        );
        assert.deepEqual(
            await Promise.all([
                reconcileSessionPersistence(persistence, id),
                reconcileSessionPersistence(persistence, id),
            ]),
            [null, null],
        );
        assert.deepEqual(methods, [
            'open',
            'reconcile',
            'reconcile',
            'close',
            'close',
        ]);

        await (await persistence.open(id, 'write')).close();
    } finally {
        try {
            await ctx.fiber.dispose();
        } finally {
            server.close();
            server.closeAllConnections();
            history.close();
        }
    }
});
