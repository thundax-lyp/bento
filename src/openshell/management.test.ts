import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Authority } from './authority.ts';
import { SandboxManagement } from './management.ts';

const binding = {
    tenant: 'tenant',
    project: 'project',
    session: 'session',
    sandbox: 'sandbox',
    volume: 'volume',
};
const stop = {
    sandbox: binding.sandbox,
    generation: 1,
    stopped: true,
    channelsClosed: true,
    credentialsRevoked: true,
    writesRevoked: true,
};

test('only the original dispatcher can confirm a stop while draining', () => {
    const authority = new Authority(':memory:');
    try {
        const dispatcher = new SandboxManagement(authority, 'dispatcher');
        const other = new SandboxManagement(authority, 'other');
        authority.bind(binding, { ...stop, installed: true });
        authority.beginDrain(binding.session, 1);
        assert.equal(dispatcher.prepareStop(binding.session, 1, 'stop'), true);
        assert.equal(other.claimRecovery(binding.session, 1), false);
        assert.throws(() => other.confirmStop(binding.session, stop));
        assert.throws(() =>
            dispatcher.confirmStop(binding.session, {
                ...stop,
                sandbox: 'other',
            }),
        );

        dispatcher.confirmStop(binding.session, stop);
        assert.equal(authority.inspect(binding.session).state, 'STOPPED');
        assert.equal(other.prepareStart(binding.session, 1, 'start'), false);
        assert.equal(
            dispatcher.prepareStart(binding.session, 1, 'start'),
            true,
        );
        dispatcher.confirmStart(binding.session, 1, {
            sandbox: binding.sandbox,
            volume: binding.volume,
            generation: 2,
            running: true,
            installed: true,
        });
        assert.equal(authority.inspect(binding.session).state, 'READY');
        assert.equal(authority.inspect(binding.session).generation, 2);
    } finally {
        authority.close();
    }
});

test('an inconclusive initial stop leaves recovery available without redispatch', () => {
    const authority = new Authority(':memory:');
    try {
        const dispatcher = new SandboxManagement(authority, 'dispatcher');
        const recovery = new SandboxManagement(authority, 'recovery');
        authority.bind(binding, { ...stop, installed: true });
        authority.beginDrain(binding.session, 1);
        assert.equal(dispatcher.prepareStop(binding.session, 1, 'stop'), true);
        dispatcher.confirmStop(binding.session, {
            ...stop,
            channelsClosed: false,
        });
        assert.equal(authority.inspect(binding.session).state, 'UNKNOWN');
        assert.equal(recovery.prepareStop(binding.session, 1, 'retry'), false);
        assert.equal(recovery.claimRecovery(binding.session, 1), true);
        assert.throws(() => dispatcher.confirmStop(binding.session, stop));
        recovery.confirmStop(binding.session, stop);
        assert.equal(recovery.prepareStart(binding.session, 1, 'start'), true);
    } finally {
        authority.close();
    }
});
