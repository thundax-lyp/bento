import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionOwnershipLostError } from '@deepseek-ai/dsh-session-persistence';
import { createProviderFixture } from './provider-lifecycle/fixture.ts';

type Fixture = Awaited<ReturnType<typeof createProviderFixture>>;
function verifyStored(fixture: Fixture) {
    const state = fixture.snapshot();
    assert.equal(state.sessions.length, 1);
    assert.equal(state.intents.length, 0);
    const row = state.sessions[0]!;
    assert.equal(row.id, fixture.session);
    assert.equal(row.materialized, 1);
    assert.equal(row.next, state.events.length);
    assert.deepEqual(
        state.events.map((event) => event.seq),
        state.events.map((_, seq) => seq),
    );
    for (const receipt of state.receipts) {
        assert.equal(receipt.id, fixture.session);
        assert.equal(typeof receipt.batch, 'string');
        const events = state.events.slice(
            Number(receipt.first),
            Number(receipt.first) + Number(receipt.count),
        );
        assert.equal(events.length, receipt.count);
        const digest = createHash('sha256')
            .update(
                JSON.stringify(
                    events.map((event) => JSON.parse(String(event.event))),
                ),
            )
            .digest('hex');
        assert.equal(receipt.digest, digest);
        assert(Number(receipt.count) > 0);
    }
    for (const event of state.events) {
        assert.equal(
            state.receipts.filter(
                (receipt) =>
                    Number(receipt.first) <= Number(event.seq) &&
                    Number(receipt.first) + Number(receipt.count) >
                        Number(event.seq),
            ).length,
            1,
        );
    }
    const authority = fixture.controller.inspect(fixture.session);
    assert.equal(row.epoch, authority.generation);
    assert.equal(row.owner, authority.run);
    return state;
}
async function withFixture(body: (fixture: Fixture) => Promise<void>) {
    const fixture = await createProviderFixture();
    const failures: unknown[] = [];
    try {
        await body(fixture);
    } catch (error) {
        failures.push(error);
    }
    try {
        await fixture.dispose();
    } catch (error) {
        failures.push(error);
    }
    assert.equal(existsSync(dirname(fixture.historyPath)), false);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
        throw new AggregateError(failures, 'A2 case and cleanup failed');
}

test(
    'A2-01 official provider checkpoint survives reopen and continues',
    { timeout: 30_000 },
    async () => {
        await withFixture(async (fixture) => {
            const first = await fixture.start(1);
            const handle = await first.create();
            const events = await first.turn();
            const stored = verifyStored(fixture);
            assert.deepEqual(
                stored.events.map((row) => JSON.parse(String(row.event))),
                events,
            );
            assert(stored.receipts.every((row) => row.epoch === 1));
            assert.equal(
                first.ctx.sessions.get(fixture.session),
                handle.agent.session,
            );
            assert(
                first.trace.some(
                    (row) => row.method === 'flush' && row.status === 200,
                ),
            );
            await first.close();
            assert.equal(fixture.snapshot().sessions[0]?.handle, null);
            await fixture.controller.takeover(fixture.session, 1);
            assert.equal(
                fixture.controller.inspect(fixture.session).state,
                'READY',
            );
            assert.equal(
                fixture.controller.inspect(fixture.session).generation,
                2,
            );
            await fixture.reopen();
            const second = await fixture.start(2);
            const resumed = await second.resume();
            const restored = resumed.agent.session.snapshotEvents();
            assert.deepEqual(restored.slice(0, events.length), events);
            assert(
                restored
                    .slice(events.length)
                    .every((event) => event.type === 'session/end-seed'),
            );
            assert.deepEqual(
                fixture.snapshot().receipts.filter((row) => row.epoch === 1),
                stored.receipts,
            );
            const continued = await second.turn();
            assert.deepEqual(continued.slice(0, events.length), events);
            const final = verifyStored(fixture);
            assert.deepEqual(
                final.events.map((row) => JSON.parse(String(row.event))),
                continued,
            );
            assert(final.receipts.some((row) => row.epoch === 2));
            assert.deepEqual(
                final.receipts.filter((row) => row.epoch === 1),
                stored.receipts,
            );
            assert.equal(
                continued.filter((event) => event.type === 'turn/end').length,
                2,
            );
            await second.close();
            assert.equal(fixture.snapshot().sessions[0]?.handle, null);
        });
    },
);

for (const method of ['append', 'flush', 'close'] as const) {
    test(
        `A2-02 stale ${method} is independently fenced`,
        { timeout: 30_000 },
        async () => {
            await withFixture(async (fixture) => {
                const runtime = await fixture.start(1);
                const handle = await runtime.create();
                await runtime.turn();
                verifyStored(fixture);
                assert(runtime.writer);
                const writer = runtime.writer;
                runtime.trace.length = 0;
                await fixture.controller.takeover(fixture.session, 1);
                const before = fixture.snapshot();
                const authority = fixture.controller.inspect(fixture.session);
                assert.equal(authority.state, 'READY');
                assert.equal(authority.generation, 2);
                const attempt =
                    method === 'append'
                        ? writer.append(
                              handle.agent.session.snapshotEvents().slice(0, 1),
                          )
                        : method === 'flush'
                          ? writer.flush()
                          : writer.close();
                await assert.rejects(attempt, SessionOwnershipLostError);
                assert.deepEqual(
                    runtime.trace.map((row) => ({
                        method: row.method,
                        status: row.status,
                    })),
                    [
                        {
                            method: method === 'append' ? 'stage' : method,
                            status: 403,
                        },
                    ],
                );
                assert.deepEqual(fixture.snapshot(), before);
                assert.deepEqual(
                    fixture.controller.inspect(fixture.session),
                    authority,
                );
                await runtime.expectRevokedDispose();
            });
        },
    );
}

test(
    'A2-03 lost append ACK reuses durable batch and receipt',
    { timeout: 30_000 },
    async () => {
        await withFixture(async (fixture) => {
            const runtime = await fixture.start(1);
            const handle = await runtime.create();
            runtime.dropNextAppendAck();
            handle.agent.followup(
                createUserMessage({
                    source: { kind: 'user' },
                    content: [{ type: 'text', text: 'a2-local-input' }],
                }),
            );
            await handle.agent.whenIdle();
            assert.equal(runtime.trace.filter((row) => row.dropped).length, 1);
            await runtime.waitForDroppedAck();
            const dropped = runtime.trace.find((row) => row.dropped)!;
            assert.equal(dropped.method, 'append');
            assert.equal(dropped.status, 200);
            const request = JSON.parse(dropped.request) as {
                batch: string;
                events: Array<{ seq: number }>;
            };
            const original = JSON.parse(dropped.response) as {
                ok: boolean;
                value: {
                    epoch: number;
                    batch: string;
                    digest: string;
                    first: number;
                    count: number;
                };
            };
            assert.equal(original.ok, true);
            assert.equal(original.value.batch, request.batch);
            assert.equal(original.value.epoch, 1);
            assert.equal(original.value.first, request.events[0]?.seq);
            assert.equal(original.value.count, request.events.length);
            assert.equal(
                original.value.digest,
                createHash('sha256')
                    .update(JSON.stringify(request.events))
                    .digest('hex'),
            );
            assert.equal(
                dropped.after.receipts.filter(
                    (row) => row.batch === request.batch,
                ).length,
                1,
            );
            assert.equal(
                Number(dropped.after.sessions[0]!.revision),
                Number(dropped.before.sessions[0]!.revision) + 1,
            );
            assert(runtime.writer);
            await runtime.writer.flush();
            const attempts = runtime.trace.filter(
                (row) =>
                    row.method === 'append' &&
                    (JSON.parse(row.request) as { batch: string }).batch ===
                        request.batch,
            );
            assert.equal(attempts.length, 2);
            const replay = attempts[1]!;
            assert.equal(replay.status, 200);
            assert.equal(replay.dropped, false);
            assert.equal(replay.request, dropped.request);
            assert.equal(replay.response, dropped.response);
            assert.deepEqual(JSON.parse(replay.response), original);
            assert.equal(
                replay.after.sessions[0]!.revision,
                replay.before.sessions[0]!.revision,
            );
            const state = verifyStored(fixture);
            assert.equal(
                state.receipts.filter(
                    (row) => row.batch === request.batch && row.epoch === 1,
                ).length,
                1,
            );
            for (const event of request.events)
                assert.equal(
                    state.events.filter((row) => row.seq === event.seq).length,
                    1,
                );
            assert.deepEqual(
                state.events
                    .slice(
                        original.value.first,
                        original.value.first + original.value.count,
                    )
                    .map((row) => JSON.parse(String(row.event))),
                request.events,
            );
            await runtime.close();
            await fixture.controller.takeover(fixture.session, 1);
            await fixture.reopen();
            const fresh = await fixture.start(2);
            const resumed = await fresh.resume();
            assert.deepEqual(
                resumed.agent.session
                    .snapshotEvents()
                    .slice(
                        original.value.first,
                        original.value.first + original.value.count,
                    ),
                request.events,
            );
            assert.deepEqual(
                fixture
                    .snapshot()
                    .receipts.filter((row) => row.batch === request.batch),
                state.receipts.filter((row) => row.batch === request.batch),
            );
            await fresh.turn();
            verifyStored(fixture);
            assert.deepEqual(
                fixture
                    .snapshot()
                    .receipts.filter((row) => row.batch === request.batch),
                state.receipts.filter((row) => row.batch === request.batch),
            );
            await fresh.close();
        });
    },
);
