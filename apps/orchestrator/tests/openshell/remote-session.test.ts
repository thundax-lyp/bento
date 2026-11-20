import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
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
import {
    HistoryCheckpointUnavailable,
    SessionHistory,
    type VerifiedStopProof,
} from '@/apps/orchestrator/openshell/session-history.ts';
import { PersistenceFence } from '@/apps/orchestrator/openshell/persistence-fence.ts';

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
    const fresh = { session, run: randomUUID(), generation: 3 };
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
        checkpoints: db.prepare('SELECT * FROM history_checkpoints').all(),
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
    const validate = (sha256 = checkpoint.sha256) =>
        history.validateRestoreCheckpoint(session, sourceRunId, 2, sha256);
    const expectUnavailable = (sha256?: string) => {
        const before = state();
        assert.throws(() => validate(sha256), HistoryCheckpointUnavailable);
        assert.deepEqual(state(), before);
    };
    const before = state();
    validate();
    assert.deepEqual(state(), before);

    const original = before.checkpoints[0]!;
    assert(typeof original.body === 'string');
    const originalSnapshot = JSON.parse(original.body);
    const updateBody = db.prepare(
        'UPDATE history_checkpoints SET body=?,sha256=? WHERE runId=?',
    );
    db.prepare('DELETE FROM history_checkpoints WHERE runId=?').run(
        sourceRunId,
    );
    expectUnavailable();
    db.prepare('INSERT INTO history_checkpoints VALUES (?,?,?,?,?)').run(
        sourceRunId,
        session,
        2,
        original.body,
        checkpoint.sha256,
    );
    updateBody.run('{}', checkpoint.sha256, sourceRunId);
    expectUnavailable();
    for (const body of [
        '{"kind":"present","next":0}',
        ' ' + original.body,
        JSON.stringify({
            ...originalSnapshot,
            events: ['{}', originalSnapshot.events[1]],
        }),
    ]) {
        const sha256 = createHash('sha256').update(body).digest('hex');
        updateBody.run(body, sha256, sourceRunId);
        expectUnavailable(sha256);
    }
    updateBody.run(original.body, checkpoint.sha256, sourceRunId);

    db.prepare(
        'UPDATE history_checkpoints SET sessionId=?,authorityGeneration=? WHERE runId=?',
    ).run(randomUUID(), 1, sourceRunId);
    expectUnavailable();
    db.prepare(
        'UPDATE history_checkpoints SET sessionId=?,authorityGeneration=? WHERE runId=?',
    ).run(session, 2, sourceRunId);

    const setOwner = db.prepare(
        'UPDATE sessions SET owner=?,epoch=? WHERE id=?',
    );
    setOwner.run(sourceRunId, 2, session);
    expectUnavailable();
    setOwner.run('bento:revoked', 1, session);
    expectUnavailable();
    setOwner.run('bento:revoked', 2, session);

    const originalHeader = before.sessions[0]?.header;
    assert(typeof originalHeader === 'string');
    const setHeader = db.prepare('UPDATE sessions SET header=? WHERE id=?');
    setHeader.run('{', session);
    expectUnavailable();
    setHeader.run(originalHeader, session);

    const receipts = state().receipts;
    assert.deepEqual(history.restore(proof), checkpoint);
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

    // The queued retry was cancelled without admission; a different Run may acquire this generation.
    assert.deepEqual(history.checkpoint(session, fresh.run, 3), checkpoint);
    const fence = new PersistenceFence(path);
    try {
        assert(fence.isRevoked(session, 2));
        fence.grant(session, 3, fresh.run);
        assert.equal(call(fresh, { method: 'stat' }).eventCount, 2);
        const skipped = history.dispatch(
            JSON.stringify({ method: 'open', access: 'write' }),
            { ...fresh, run: newRunId },
        );
        assert.equal(skipped.status, 400);
        const opened = call(fresh, { method: 'open', access: 'write' });
        writeTurn(fresh, opened.key, 2);
        assert.equal(call(fresh, { method: 'stat' }).eventCount, 4);
    } finally {
        fence.close();
    }
});

test('explicit absent history checkpoint validates without writes', async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'bento-history-absent-'));
    const path = join(folder, 'history.sqlite');
    const history = new SessionHistory(path);
    const db = new DatabaseSync(path);
    t.after(async () => {
        history.close();
        db.close();
        await rm(folder, { recursive: true, force: true });
    });
    const session = randomUUID();
    const run = randomUUID();
    const checkpoint = history.checkpoint(session, run, 1);
    const state = () =>
        ['sessions', 'events', 'history_checkpoints', 'history_restores'].map(
            (table) => db.prepare('SELECT * FROM ' + table).all(),
        );
    const before = state();
    assert.equal(before[2]?.[0]?.body, '{"kind":"absent"}');
    history.validateRestoreCheckpoint(session, run, 1, checkpoint.sha256);
    assert.deepEqual(state(), before);
    db.prepare('DELETE FROM history_checkpoints WHERE runId=?').run(run);
    assert.throws(
        () =>
            history.validateRestoreCheckpoint(
                session,
                run,
                1,
                checkpoint.sha256,
            ),
        HistoryCheckpointUnavailable,
    );
});
