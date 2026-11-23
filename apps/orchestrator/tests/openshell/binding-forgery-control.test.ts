import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBindingFixture } from './binding-forgery/fixture.ts';

test('A1-02 fixture legal binding and reopen', { timeout: 10000 }, async () => {
    const fixture = await createBindingFixture();
    try {
        const before = fixture.snapshot();
        assert.equal(before.authority.execution_sessions?.length, 3);
        assert.equal(before.files.length, 3);
        assert.equal(new Set(before.files.map((file) => file.sha256)).size, 3);
        for (const binding of Object.values(fixture.bindings)) {
            const current = fixture.controller.inspect(binding.session);
            for (const [key, value] of Object.entries(binding))
                assert.equal(current[key as keyof typeof binding], value);
            assert.equal(current.state, 'READY');
            assert.equal(current.hasCapability, false);
        }
        await fixture.reopen();
        assert.deepEqual(fixture.snapshot(), before);
    } finally {
        await fixture.dispose();
    }
});

for (const field of ['tenant', 'session', 'volume'] as const) {
    test('A1-02 forged ' + field, { timeout: 10000 }, async () => {
        const fixture = await createBindingFixture();
        try {
            const { A, B, C } = fixture.bindings;
            const original = fixture.snapshot();
            const forged = { ...A, [field]: B[field] };
            for (let attempt = 0; attempt < 2; attempt++) {
                for (const binding of [A, B]) {
                    const row = fixture.controller.inspect(binding.session);
                    assert.equal(row.state, 'READY');
                    assert.equal(row.hasCapability, false);
                }
                await assert.rejects(
                    fixture.controller.purge(forged, fixture.remove),
                    { message: 'Session is not safe to purge' },
                );
                assert.equal(fixture.removeCalls.length, 0);
                assert.deepEqual(fixture.snapshot(), original);
                if (attempt === 0) await fixture.reopen();
            }
            await fixture.controller.purge(C, fixture.remove);
            assert.deepEqual(fixture.removeCalls, [C]);
            const after = fixture.snapshot();
            assert.equal(after.authority.execution_sessions.length, 2);
            assert.throws(
                () => fixture.controller.inspect(C.session),
                /unknown session/,
            );
            assert.deepEqual(
                after.authority.execution_sessions,
                original.authority.execution_sessions.filter(
                    (row) => row.session !== C.session,
                ),
            );
            assert.deepEqual(after.history, original.history);
            for (const actor of ['A', 'B'] as const) {
                assert.deepEqual(
                    after.files.find(
                        (file) => file.volume === fixture.volumes[actor],
                    ),
                    original.files.find(
                        (file) => file.volume === fixture.volumes[actor],
                    ),
                );
            }
            assert.equal(
                after.files.find((file) => file.volume === fixture.volumes.C)
                    ?.bytes,
                null,
            );
            await fixture.reopen();
            assert.deepEqual(fixture.snapshot(), after);
        } finally {
            await fixture.dispose();
        }
    });
}
