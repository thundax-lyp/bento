import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import { materializeAppendBatch } from '@deepseek-ai/dsh-session-persistence';
import {
    createBindingFixture,
    type Actor,
    type BindingFixture,
} from './binding-forgery/fixture.ts';

const expectedEvents = {
    A: [
        {
            type: 'turn/start',
            seq: SessionSeq(0),
            time: 1700000000001,
            data: { turn: 1 },
        },
        {
            type: 'turn/end',
            seq: SessionSeq(1),
            time: 1700000000002,
            data: { turn: 1, reason: { kind: 'completed' } },
        },
    ],
    B: [
        {
            type: 'turn/start',
            seq: SessionSeq(0),
            time: 1700000000101,
            data: { turn: 1 },
        },
        {
            type: 'turn/end',
            seq: SessionSeq(1),
            time: 1700000000102,
            data: { turn: 1, reason: { kind: 'completed' } },
        },
    ],
} as const;

type Value = {
    key: string;
    header: { id: string };
    events: unknown[];
    batch: string;
    first: number;
    count: number;
    digest: string;
};
async function rpc(fixture: BindingFixture, actor: Actor, body: unknown) {
    const result = await fixture.rpc(actor, body);
    assert.equal(result.status, 200);
    const envelope = result.body as { ok: boolean; value: Value };
    assert.equal(envelope.ok, true);
    return envelope.value;
}
async function seed(fixture: BindingFixture, actor: Actor) {
    const id = fixture.bindings[actor].session;
    const { key } = await rpc(fixture, actor, {
        method: 'create',
        id,
        header: { id, version: 4, createdAt: 1700000000000, isSeeded: false },
    });
    const batch = randomUUID();
    const events = materializeAppendBatch([...expectedEvents[actor]]);
    const fields = { id, key, batch, events };
    await rpc(fixture, actor, { method: 'stage', ...fields });
    const receipt = await rpc(fixture, actor, { method: 'append', ...fields });
    assert.deepEqual(receipt, {
        epoch: 1,
        batch,
        first: 0,
        count: 2,
        digest: createHash('sha256')
            .update(JSON.stringify(events))
            .digest('hex'),
    });
    await rpc(fixture, actor, { method: 'reconcile', id, key, batch });
    await rpc(fixture, actor, { method: 'flush', id, key });
    await rpc(fixture, actor, { method: 'close', id, key });
}
async function readOwn(fixture: BindingFixture, actor: Actor) {
    const id = fixture.bindings[actor].session;
    const stat = await rpc(fixture, actor, { method: 'stat', id });
    assert.equal(stat.header.id, id);
    const { key } = await rpc(fixture, actor, {
        method: 'open',
        id,
        access: 'read',
    });
    try {
        const value = await rpc(fixture, actor, {
            method: 'read',
            id,
            key,
            offset: 0,
            length: 2,
        });
        assert.deepEqual(value.events, expectedEvents[actor]);
        assert.notDeepEqual(
            value.events,
            expectedEvents[actor === 'A' ? 'B' : 'A'],
        );
    } finally {
        await rpc(fixture, actor, { method: 'close', id, key });
    }
}

for (const attack of [
    'stat',
    'open',
    'read',
    'create-other-header',
    'create-new-header',
] as const) {
    test(
        'A1-02 persistence session target ' + attack,
        { timeout: 15000 },
        async () => {
            const fixture = await createBindingFixture();
            try {
                fixture.admit();
                for (const actor of ['A', 'B'] as const)
                    await seed(fixture, actor);
                assert.equal(fixture.snapshot().history.events.length, 4);
                for (let attempt = 0; attempt < 2; attempt++) {
                    for (const actor of ['A', 'B'] as const)
                        await readOwn(fixture, actor);
                    const original = fixture.snapshot();
                    const a = fixture.bindings.A.session;
                    const b = fixture.bindings.B.session;
                    const body = attack.startsWith('create')
                        ? {
                              method: 'create',
                              id: a,
                              header: {
                                  id:
                                      attack === 'create-other-header'
                                          ? b
                                          : randomUUID(),
                                  version: 4,
                                  createdAt: 1700000000000,
                                  isSeeded: false,
                              },
                          }
                        : {
                              method: attack,
                              id: b,
                              ...(attack === 'open' ? { access: 'read' } : {}),
                              ...(attack === 'read'
                                  ? { key: randomUUID(), offset: 0, length: 2 }
                                  : {}),
                          };
                    const result = await fixture.rpc('A', body);
                    assert.equal(result.status, 403);
                    assert.deepEqual(result.body, {
                        ok: false,
                        error: { name: 'GrantDenied' },
                    });
                    assert(
                        !JSON.stringify(result.body).includes(
                            JSON.stringify(expectedEvents.B),
                        ),
                    );
                    assert.deepEqual(fixture.snapshot(), original);
                    for (const actor of ['A', 'B'] as const)
                        await readOwn(fixture, actor);
                    assert.deepEqual(fixture.snapshot(), original);
                    if (attempt === 0) {
                        await fixture.reopen();
                        assert.deepEqual(fixture.snapshot(), original);
                    }
                }
            } finally {
                await fixture.dispose();
            }
        },
    );
}
