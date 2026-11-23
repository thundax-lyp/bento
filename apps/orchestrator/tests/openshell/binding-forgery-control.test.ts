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
