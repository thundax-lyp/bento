import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import {
    reconcileSessionPersistence,
    remoteSessionPersistence,
} from '@/apps/worker/remote-session.ts';
import { SessionHistory, type VerifiedStopProof } from './session-history.ts';

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

test('a verified retry restores the checkpoint prefix and reopens with its original receipt', async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'bento-history-checkpoint-'));
    const path = join(folder, 'history.sqlite');
    let history = new SessionHistory(path);
    const db = new DatabaseSync(path);
    t.after(async () => {
        history.close();
        db.close();
        await rm(folder, { recursive: true, force: true });
    });
    const session = randomUUID();
    const sourceRunId = randomUUID();
    const newRunId = randomUUID();
    const first = { session, run: randomUUID(), generation: 1 };
    const old = { session, run: sourceRunId, generation: 2 };
    const fresh = { session, run: newRunId, generation: 3 };
    const call = (grant: typeof first, body: object) => {
        const result = history.dispatch(JSON.stringify(body), grant);
        const parsed = JSON.parse(result.body);
        assert.equal(result.status, 200, result.body);
        return parsed.value;
    };
    const create = call(first, {
        method: 'create',
        header: {
            id: session,
            version: 4,
            createdAt: 1700000000000,
            isSeeded: false,
        },
    });
    const writeTurn = (grant: typeof first, key: string, turn: number) => {
        const seq = (turn - 1) * 2;
        const batch = randomUUID();
        const events = [
            {
                type: 'turn/start',
                seq,
                time: 1700000000001 + seq,
                data: { turn },
            },
            {
                type: 'turn/end',
                seq: seq + 1,
                time: 1700000000002 + seq,
                data: { turn, reason: { kind: 'completed' } },
            },
        ];
        call(grant, { method: 'stage', key, batch, events });
        call(grant, { method: 'append', key, batch, events });
        call(grant, { method: 'reconcile', key });
        call(grant, { method: 'flush', key });
        call(grant, { method: 'close', key });
    };
    const revoke = (generation: number) =>
        db
            .prepare(
                "UPDATE sessions SET owner='bento:revoked',handle=NULL WHERE id=? AND epoch=?",
            )
            .run(session, generation);
    writeTurn(first, create.key, 1);
    revoke(1);
    const checkpoint = history.checkpoint(session, sourceRunId, 2);
    db.prepare('UPDATE sessions SET owner=?,epoch=? WHERE id=?').run(
        old.run,
        old.generation,
        session,
    );
    const writer = call(old, { method: 'open', access: 'write' });
    writeTurn(old, writer.key, 2);
    revoke(2);
    const proof = {
        attemptId: randomUUID(),
        taskId: randomUUID(),
        sourceRunId,
        newRunId,
        sessionId: session,
        oldGeneration: 2,
        newGeneration: 3,
        checkpointSha256: checkpoint.sha256,
    } as VerifiedStopProof;
    const state = () => ({
        sessions: db.prepare('SELECT * FROM sessions').all(),
        events: db.prepare('SELECT * FROM events').all(),
        receipts: db.prepare('SELECT * FROM batch_receipts').all(),
        intents: db.prepare('SELECT * FROM batch_intents').all(),
        restores: db.prepare('SELECT * FROM history_restores').all(),
    });
    const expectUnchanged = (changes: Partial<VerifiedStopProof> = {}) => {
        const before = state();
        assert.throws(() => history.restore({ ...proof, ...changes }));
        assert.deepEqual(state(), before);
    };
    expectUnchanged({ sessionId: randomUUID() });
    expectUnchanged({ oldGeneration: 1, newGeneration: 2 });
    expectUnchanged({ checkpointSha256: 'invalid' });
    db.prepare("UPDATE sessions SET handle='in-use' WHERE id=?").run(session);
    expectUnchanged();
    db.prepare('UPDATE sessions SET handle=NULL WHERE id=?').run(session);
    db.prepare("INSERT INTO batch_intents VALUES (?,2,'pending','[]')").run(
        session,
    );
    expectUnchanged();
    db.prepare('DELETE FROM batch_intents WHERE id=?').run(session);
    const receipts = state().receipts;
    assert.deepEqual(history.restore(proof), checkpoint);
    assert.equal(call(fresh, { method: 'stat' }).eventCount, 2);
    assert.deepEqual(state().receipts, receipts);
    assert.equal(
        history.dispatch(
            JSON.stringify({ method: 'open', access: 'write' }),
            old,
        ).status,
        400,
    );
    history.close();
    history = new SessionHistory(path);
    assert.deepEqual(history.restore(proof), checkpoint);
    assert.equal(history.restoredDigest(proof), checkpoint.sha256);
    assert.deepEqual(history.checkpoint(session, newRunId, 3), checkpoint);
    expectUnchanged({ newRunId: randomUUID() });
});
