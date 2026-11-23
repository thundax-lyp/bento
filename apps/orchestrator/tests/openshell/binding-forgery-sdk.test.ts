import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { prepareSdk, type PreparedSdk } from './binding-grants/sdk.ts';
import { probeSdk } from './binding-grants/sdk-probe.ts';
import { createBindingFixture } from './binding-forgery/fixture.ts';
import { createBindingGateway } from './binding-forgery/gateway.ts';
import { sha256 } from './binding-forgery/state.ts';

let sdk: PreparedSdk;
before(
    async () => {
        sdk = await prepareSdk();
        probeSdk(sdk);
    },
    { timeout: 600000 },
);
after(async () => {
    await sdk?.dispose();
});
for (const method of [
    'GetSandbox',
    'ExecSandbox',
    'ExecSandboxInteractive',
] as const) {
    test('A1-02 SDK forged sandbox ' + method, { timeout: 60000 }, async () => {
        const fixture = await createBindingFixture();
        let gateway:
            Awaited<ReturnType<typeof createBindingGateway>> | undefined;
        try {
            fixture.admit();
            for (let attempt = 0; attempt < 2; attempt++) {
                gateway = await createBindingGateway(fixture, sdk);
                const legal = async () => {
                    for (const actor of ['A', 'B'] as const) {
                        const count = gateway!.calls().length;
                        const response = await gateway!.request(
                            actor,
                            method,
                            fixture.bindings[actor].sandbox,
                        );
                        assert.equal(response.grpcStatus, '0');
                        const payload =
                            method === 'GetSandbox'
                                ? new Uint8Array()
                                : sdk.exit(0);
                        const frame = Buffer.alloc(5);
                        frame.writeUInt32BE(payload.length, 1);
                        assert.deepEqual(
                            response.body,
                            Buffer.concat([frame, payload]),
                        );
                        assert.equal(gateway!.calls().length, count + 1);
                        assert.deepEqual(gateway!.calls().at(-1), {
                            sandbox: fixture.bindings[actor].sandbox,
                            method,
                            authenticated: true,
                            fileSha256: sha256(
                                await readFile(
                                    join(fixture.volumes[actor], 'canary.txt'),
                                ),
                            ),
                        });
                    }
                };
                await legal();
                const before = fixture.snapshot();
                const calls = gateway.calls();
                const rejected = await gateway.request(
                    'A',
                    method,
                    fixture.bindings.B.sandbox,
                );
                assert.equal(rejected.grpcStatus, '7');
                assert.equal(rejected.body.length, 0);
                const privateB = await readFile(
                    join(fixture.volumes.B, 'canary.txt'),
                    'utf8',
                );
                assert(!JSON.stringify(rejected.headers).includes(privateB));
                assert.deepEqual(gateway.calls(), calls);
                assert.deepEqual(fixture.snapshot(), before);
                await legal();
                await gateway.close();
                gateway = undefined;
                const settled = fixture.snapshot();
                if (attempt === 0) {
                    await fixture.reopen();
                    assert.deepEqual(fixture.snapshot(), settled);
                }
            }
        } finally {
            const results = [];
            results.push(...(await Promise.allSettled([gateway?.close()])));
            results.push(...(await Promise.allSettled([fixture.dispose()])));
            const errors = results
                .filter((result) => result.status === 'rejected')
                .map((result) => result.reason);
            if (errors.length)
                throw new AggregateError(errors, 'A1-02 SDK cleanup failed');
        }
    });
}
