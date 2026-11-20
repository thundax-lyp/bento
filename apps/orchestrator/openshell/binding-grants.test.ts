import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
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
