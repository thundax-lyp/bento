import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createGrantFixture, methods } from './binding-grants/fixture.ts';
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
