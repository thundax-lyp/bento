import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Authority } from '@/apps/orchestrator/src/openshell/authority.ts';
import { SandboxManagement } from '@/apps/orchestrator/src/openshell/management.ts';
import { SingleHostExecution } from '@/apps/orchestrator/src/openshell/single-host.ts';

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

test('a reopened controller continues a reserved stop through a generation-scoped host', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'bento-stop-recovery-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const paths = {
        authority: join(directory, 'authority.sqlite'),
        history: join(directory, 'history.sqlite'),
    };
    const observation = {
        sandbox: binding.sandbox,
        volume: binding.volume,
        installed: true,
        running: true,
    };
    const running = new Set([1]);
    const stopRequests: number[] = [];
    const host = {
        async stop() {
            assert.fail('an unscoped stop must not be dispatched');
        },
        async stopGeneration({ generation }: { generation: number }) {
            stopRequests.push(generation);
            if (stopRequests.length === 1)
                throw new Error('interrupted before delivery');
            running.delete(generation);
        },
        async stopped({ generation }: { generation: number }) {
            return !running.has(generation);
        },
        async start({ generation }: { generation: number }) {
            assert.equal(running.size, 0);
            running.add(generation + 1);
        },
        async running() {
            return observation;
        },
    };
    const first = new SingleHostExecution(paths, host);
    try {
        first.bind(binding, observation);
        first.admit(binding.session, 1, 'original-run', 60_000);
        await assert.rejects(
            first.takeover(binding.session, 1),
            /interrupted before delivery/,
        );
        assert.equal(first.inspect(binding.session).state, 'UNKNOWN');
    } finally {
        first.close();
    }

    const reopened = new SingleHostExecution(paths, host);
    try {
        const next = await reopened.takeover(binding.session, 1);
        assert.equal(next.state, 'READY');
        assert.equal(next.generation, 2);
        assert.deepEqual(stopRequests, [1, 1]);
        assert.deepEqual(await reopened.takeover(binding.session, 1), next);
        assert.deepEqual(stopRequests, [1, 1]);
        await host.stopGeneration({ generation: 1 });
        assert.deepEqual([...running], [2]);
    } finally {
        reopened.close();
    }
});

test('a reopened controller resumes a reserved start without restarting an exited instance', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'bento-start-recovery-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const paths = {
        authority: join(directory, 'authority.sqlite'),
        history: join(directory, 'history.sqlite'),
    };
    const observation = {
        sandbox: binding.sandbox,
        volume: binding.volume,
        installed: true,
    };
    let interrupt = true;
    let running = false;
    let launches = 0;
    const host = {
        async stop() {},
        async stopped() {
            return true;
        },
        async start() {
            assert.fail('an unscoped start must not be dispatched');
        },
        async startGeneration({ generation }: { generation: number }) {
            assert.equal(generation, 1);
            if (interrupt) throw new Error('interrupted before start delivery');
            if (launches === 0) {
                launches++;
                running = true;
                throw new Error('start response lost');
            }
        },
        async running() {
            return { ...observation, running };
        },
    };
    const initial = new SingleHostExecution(paths, host);
    try {
        initial.bind(binding, { ...observation, running: true });
        initial.admit(binding.session, 1, 'original-run', 60_000);
        await assert.rejects(
            initial.takeover(binding.session, 1),
            /interrupted before start delivery/,
        );
        assert.equal(initial.inspect(binding.session).state, 'START_UNKNOWN');
    } finally {
        initial.close();
    }

    const reopened = new SingleHostExecution(paths, host);
    try {
        interrupt = false;
        await assert.rejects(
            reopened.takeover(binding.session, 1),
            /start response lost/,
        );
        running = false;
        await assert.rejects(reopened.takeover(binding.session, 1));
        const current = reopened.inspect(binding.session);
        assert.equal(current.state, 'START_UNKNOWN');
        assert.equal(current.run, 'original-run');
        assert.equal(current.hasCapability, false);
        assert.equal(launches, 1);
    } finally {
        reopened.close();
    }
});
