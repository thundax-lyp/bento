import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SingleHostExecution } from '@/apps/orchestrator/src/openshell/single-host.ts';
import type { Binding } from '@/apps/worker/protocol.ts';

test('shared volume keeps write authority and references across unconfirmed host operations', async () => {
    const path = await mkdtemp(join(tmpdir(), 'bento-shared-volume-'));
    const paths = {
        authority: join(path, 'authority.sqlite'),
        history: join(path, 'history.sqlite'),
    };
    const first: Binding = {
        tenant: 'owner',
        project: 'project',
        volume: 'volume',
        session: 'first',
        sandbox: 'first',
    };
    const second = { ...first, session: 'second', sandbox: 'second' };
    const running = (binding: Binding) => ({
        running: true,
        installed: true,
        volume: binding.volume,
        sandbox: binding.sandbox,
    });
    let confirmStop = true;
    let confirmReclaim = false;
    let detached = 0;
    let reclaimed = 0;
    const sandbox = {
        async start() {},
        async stop() {},
        async stopped() {
            return confirmStop;
        },
        async running(binding: Binding) {
            return running(binding);
        },
    };
    const host = {
        attach: sandbox.running,
        async detach() {
            detached++;
        },
        async reclaim() {
            if (!confirmReclaim) throw new Error('reclaim unavailable');
            reclaimed++;
        },
    };
    let control = new SingleHostExecution(paths, sandbox);
    try {
        control.bind(first, running(first));
        await assert.rejects(
            control.attach(first, { ...second, tenant: 'foreign' }, host),
            /binding denied/,
        );
        assert.equal(
            (await control.attach(first, second, host)).state,
            'READY',
        );
        control.admit(first.session, 1, 'first-run', 60_000);
        confirmStop = false;
        await assert.rejects(control.revoke(first), /stop unconfirmed/);
        assert.throws(
            () => control.admit(second.session, 1, 'second-run', 60_000),
            { code: 'volume_busy' },
        );
        control.close();
        control = new SingleHostExecution(paths, sandbox);
        assert.throws(
            () => control.admit(second.session, 1, 'second-run', 60_000),
            { code: 'volume_busy' },
        );
        confirmStop = true;
        await control.revoke(first);
        await control.release(first, host);
        await control.release(first, host);
        assert.equal(detached, 1);
        assert.equal(reclaimed, 0);
        control.admit(second.session, 1, 'second-run', 60_000);
        await assert.rejects(
            control.release(second, host),
            /reclaim unavailable/,
        );
        assert.equal(detached, 2);
        assert.throws(
            () => control.bind(first, running(first)),
            /binding denied/,
        );
        control.close();
        control = new SingleHostExecution(paths, sandbox);
        confirmReclaim = true;
        await control.release(second, host);
        await control.release(second, host);
        assert.equal(reclaimed, 1);
        assert.equal(detached, 2);
    } finally {
        control.close();
        await rm(path, { recursive: true, force: true });
    }
});
