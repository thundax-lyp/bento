import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SessionOwnershipLostError } from '@deepseek-ai/dsh-session-persistence';
import { createProviderFixture } from './provider-lifecycle/fixture.ts';
import {
    bounded,
    createGrantFixture,
    methods,
} from './binding-grants/fixture.ts';
import { probeSdk } from './binding-grants/sdk-probe.ts';
import { prepareSdk, type PreparedSdk } from './binding-grants/sdk.ts';

let sdk: PreparedSdk;
before(
    async () => {
        sdk = await prepareSdk();
        probeSdk(sdk);
    },
    { timeout: 600_000 },
);
after(async () => {
    await sdk?.dispose();
});

test(
    'A1-03 H current grant reaches production ingresses',
    { timeout: 60_000, concurrency: false },
    async () => {
        const fixture = await createGrantFixture(sdk);
        try {
            const client = fixture.connect();
            for (const method of methods) {
                const before = fixture.counts().requests;
                const result = await fixture.request(client, method);
                assert.equal(result.status, '0');
                assert.equal(result.upstreamCalls, before + 1);
            }
            const row = fixture.snapshot();
            assert.equal(row.state, 'RUNNING');
            assert.equal(row.revoked, 0);
            assert.equal(row.generation, 1);
            for (const [key, value] of Object.entries(fixture.binding))
                assert.equal(row[key], value);
            assert.equal(row.run, fixture.grant.run);
            const response = await fetch(
                new URL('/operations', fixture.operationUrl),
                {
                    method: 'POST',
                    headers: {
                        authorization: 'Bearer ' + fixture.grant.token,
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify({
                        id: 'a103:' + randomUUID() + ':before',
                        input: 'a103-operation-input-v1',
                    }),
                    signal: AbortSignal.timeout(5000),
                },
            );
            await response.body?.cancel();
            assert.equal(response.status, 201);
            assert.equal(fixture.operations().length, 3);
            assert.deepEqual(fixture.history(), {
                sessions: [],
                events: [],
                receipts: [],
                intents: [],
            });
        } finally {
            await fixture.dispose();
        }
    },
);

test(
    'A1-04 SDK ingress rejects absent and invalid execution authorization',
    { timeout: 60_000, concurrency: false },
    async () => {
        const fixture = await createGrantFixture(sdk);
        try {
            const client = fixture.connect();
            const counts = fixture.counts();
            const state = fixture.snapshot();
            const operations = fixture.operations();
            for (const authorization of [null, 'Bearer ' + randomUUID()]) {
                for (const method of methods) {
                    const result = await fixture.request(client, method, {
                        authorization,
                    });
                    assert.equal(result.status, '16');
                }
            }
            assert.deepEqual(fixture.counts(), counts);
            assert.deepEqual(fixture.snapshot(), state);
            assert.deepEqual(fixture.operations(), operations);
            assert.equal(
                (await fixture.request(client, 'GetSandbox')).status,
                '0',
            );
        } finally {
            await fixture.dispose();
        }
    },
);

for (const mode of ['N', 'R'] as const)
    for (const method of methods)
        test(
            `A1-03 ${mode} ${method}`,
            { timeout: 60_000, concurrency: false },
            async () => {
                const fixture = await createGrantFixture(sdk);
                try {
                    let client = fixture.connect();
                    assert.equal(
                        (await fixture.request(client, method)).status,
                        '0',
                    );
                    const requests = fixture.counts().requests;
                    const original = fixture.snapshot();
                    assert.equal(original.revoked, 0);
                    if (mode === 'R') {
                        const close = once(client, 'close');
                        client.destroy();
                        await bounded(close, 5000, 'original connection close');
                    }
                    assert.deepEqual(await fixture.revoke(), {
                        state: 'UNKNOWN',
                        generation: 1,
                        revoked: true,
                        stopConfirmed: false,
                        error: 'old execution unconfirmed',
                    });
                    const revoked = fixture.snapshot();
                    assert.equal(revoked.revoked, 1);
                    assert.equal(revoked.generation, 1);
                    assert.equal(fixture.fence().revoked, true);
                    assert.equal(revoked.run, original.run);
                    assert.equal(revoked.state, 'UNKNOWN');
                    for (const [key, value] of Object.entries(fixture.binding))
                        assert.equal(revoked[key], value);
                    if (mode === 'R') client = fixture.connect();
                    else assert.equal(client.destroyed, false);
                    const history = fixture.history();
                    const result = await fixture.request(client, method);
                    assert.equal(result.headerStatus, '16');
                    assert.equal(result.status, '16');
                    assert.equal(fixture.counts().requests, requests);
                    assert.deepEqual(fixture.snapshot(), revoked);
                    assert.deepEqual(fixture.history(), history);
                    await fixture.reopen();
                    assert.deepEqual(fixture.snapshot(), revoked);
                    const reopened = await fixture.request(
                        fixture.connect(),
                        method,
                    );
                    assert.equal(reopened.headerStatus, '16');
                    assert.equal(reopened.status, '16');
                    assert.equal(fixture.counts().requests, requests);
                    assert.deepEqual(fixture.snapshot(), revoked);
                    assert.deepEqual(fixture.history(), history);
                } finally {
                    await fixture.dispose();
                }
            },
        );

test(
    'A1-03 O old capability cannot reserve an operation',
    { timeout: 60_000, concurrency: false },
    async () => {
        const fixture = await createGrantFixture(sdk);
        try {
            const prefix = 'a103:' + randomUUID();
            const input = 'a103-operation-input-v1';
            async function post(suffix: string) {
                const response = await fetch(
                    new URL('/operations', fixture.operationUrl),
                    {
                        method: 'POST',
                        headers: {
                            authorization: 'Bearer ' + fixture.grant.token,
                            'content-type': 'application/json',
                        },
                        body: JSON.stringify({
                            id: prefix + ':' + suffix,
                            input,
                        }),
                        signal: AbortSignal.timeout(5000),
                    },
                );
                await response.body?.cancel();
                return response.status;
            }
            assert.deepEqual(fixture.operations(), []);
            assert.equal(await post('before'), 201);
            const operations = fixture.operations();
            assert.deepEqual(
                operations.map((row) => ({ ...row })),
                [
                    {
                        session: fixture.binding.session,
                        generation: 1,
                        id: prefix + ':before',
                        digest: createHash('sha256')
                            .update(input)
                            .digest('hex'),
                        state: 'UNKNOWN',
                    },
                ],
            );
            assert.deepEqual(await fixture.revoke(), {
                state: 'UNKNOWN',
                generation: 1,
                revoked: true,
                stopConfirmed: false,
                error: 'old execution unconfirmed',
            });
            const revoked = fixture.snapshot();
            assert.equal(revoked.revoked, 1);
            assert.deepEqual(fixture.operations(), operations);
            assert.equal(await post('after'), 403);
            assert.deepEqual(fixture.operations(), operations);
            assert.deepEqual(fixture.snapshot(), revoked);
            await fixture.reopen();
            assert.deepEqual(fixture.operations(), operations);
            assert.deepEqual(fixture.snapshot(), revoked);
            assert.equal(await post('reopen'), 403);
            assert.deepEqual(fixture.operations(), operations);
            assert.deepEqual(fixture.snapshot(), revoked);
            assert.equal(
                fixture
                    .operations()
                    .some(
                        (row) =>
                            row.id === prefix + ':after' ||
                            row.id === prefix + ':reopen',
                    ),
                false,
            );
            assert.deepEqual(fixture.counts(), { requests: 0, stdin: 0 });
        } finally {
            await fixture.dispose();
        }
    },
);

test(
    'A1-03 I held interactive rejects post-revoke stdin',
    { timeout: 60_000, concurrency: false },
    async () => {
        const fixture = await createGrantFixture(sdk);
        try {
            const client = fixture.connect();
            assert.equal(
                (await fixture.request(client, 'ExecSandboxInteractive'))
                    .status,
                '0',
            );
            const held = await fixture.openInteractive(client);
            const counts = fixture.counts();
            assert.deepEqual(counts, { requests: 2, stdin: 1 });
            const operations = fixture.operations();
            assert.equal(operations.length, 2);
            assert.equal(
                operations.filter((row) => row.state === 'UNKNOWN').length,
                1,
            );
            const history = fixture.history();
            const revocation = fixture.beginRevoke();
            await bounded(revocation.revoked, 10_000, 'revocation barrier');
            const revoked = fixture.snapshot();
            assert.equal(revoked.revoked, 1);
            assert.equal(revoked.state, 'UNKNOWN');
            assert.equal(revoked.generation, 1);
            assert.equal(fixture.fence().revoked, true);
            try {
                held.sendStdin();
            } catch (error) {
                assert(error instanceof Error);
                assert.equal(error.message, 'Held stream already closed');
            }
            const [status, , , result] = await bounded(
                Promise.all([
                    held.status,
                    held.closed,
                    held.upstreamClosed,
                    revocation.settled,
                ]),
                10_000,
                'held revocation evidence',
            );
            assert.equal(status, '7');
            assert.deepEqual(result, {
                state: 'UNKNOWN',
                generation: 1,
                revoked: true,
                stopConfirmed: false,
                error: 'old execution unconfirmed',
            });
            assert.deepEqual(fixture.counts(), counts);
            assert.deepEqual(fixture.operations(), operations);
            assert.deepEqual(fixture.history(), history);
            assert.deepEqual(fixture.snapshot(), revoked);
            assert.equal(client.destroyed, false);
            for (const connection of [client, fixture.connect()]) {
                const denied = await fixture.request(
                    connection,
                    'ExecSandboxInteractive',
                );
                assert.equal(denied.headerStatus, '16');
                assert.equal(denied.status, '16');
            }
            await fixture.reopen();
            assert.deepEqual(fixture.snapshot(), revoked);
            const denied = await fixture.request(
                fixture.connect(),
                'ExecSandboxInteractive',
            );
            assert.equal(denied.headerStatus, '16');
            assert.equal(denied.status, '16');
            assert.deepEqual(fixture.operations(), operations);
            assert.deepEqual(fixture.history(), history);
            assert.deepEqual(fixture.counts(), counts);
        } finally {
            await fixture.dispose();
        }
    },
);

test(
    'A1-03 P old provider cannot append after controller revocation',
    { timeout: 60_000, concurrency: false },
    async () => {
        const fixture = await createProviderFixture();
        try {
            function authority() {
                const db = new DatabaseSync(fixture.authorityPath, {
                    readOnly: true,
                });
                try {
                    return db
                        .prepare(
                            'SELECT generation,state,capability IS NULL AS revoked FROM execution_sessions WHERE session=?',
                        )
                        .get(fixture.session);
                } finally {
                    db.close();
                }
            }
            function fence() {
                const db = new DatabaseSync(fixture.historyPath, {
                    readOnly: true,
                });
                try {
                    return db
                        .prepare(
                            'SELECT epoch,owner,handle FROM sessions WHERE id=?',
                        )
                        .get(fixture.session);
                } finally {
                    db.close();
                }
            }
            const runtime = await fixture.start(1);
            const handle = await runtime.create();
            const events = await runtime.turn();
            assert.deepEqual(handle.agent.session.snapshotEvents(), events);
            assert(runtime.writer);
            assert(events.length > 0);
            assert(fixture.snapshot().events.length > 0);
            assert(fixture.snapshot().receipts.length > 0);
            assert.equal(authority()?.revoked, 0);
            const writer = runtime.writer;
            runtime.trace.length = 0;
            await fixture.controller.takeover(fixture.session, 1);
            const revoked = authority();
            assert.deepEqual(revoked && { ...revoked }, {
                generation: 2,
                state: 'READY',
                revoked: 1,
            });
            const fenced = fence();
            assert.deepEqual(fenced && { ...fenced }, {
                epoch: 1,
                owner: 'bento:revoked',
                handle: null,
            });
            const before = fixture.snapshot();
            await assert.rejects(
                writer.append(events.slice(0, 1)),
                SessionOwnershipLostError,
            );
            assert.deepEqual(
                runtime.trace.map((row) => ({
                    method: row.method,
                    status: row.status,
                })),
                [{ method: 'stage', status: 403 }],
            );
            assert.deepEqual(fixture.snapshot(), before);
            assert.deepEqual(authority(), revoked);
            assert.deepEqual(fence(), fenced);
            await runtime.expectRevokedDispose();
            await fixture.reopen();
            assert.deepEqual(authority(), revoked);
            assert.deepEqual(fence(), fenced);
            assert.deepEqual(fixture.snapshot(), before);
        } finally {
            await fixture.dispose();
        }
    },
);
