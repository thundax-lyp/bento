import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
    client,
    testToken,
    until,
} from '@/apps/orchestrator/orchestrator-execution-host/tests/execution-service/fixtures/service.ts';
import { localHost } from '@orchestrator/execution-service/local.ts';
import { serveExecution } from '@orchestrator/execution-service/service.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SingleHostExecution } from '@orchestrator/openshell/single-host.ts';
import type { Binding } from '@worker/protocol.ts';

test('reopening a single-host ledger preserves existing Session bindings', async (t) => {
    const path = await mkdtemp(join(tmpdir(), 'bento-existing-volume-'));
    t.after(() => rm(path, { recursive: true, force: true }));
    const authority = join(path, 'authority.sqlite');
    const previous = new DatabaseSync(authority);
    previous.exec(`
        CREATE TABLE execution_sessions(session TEXT PRIMARY KEY, tenant TEXT, project TEXT,
            sandbox TEXT, volume TEXT, generation INTEGER, state TEXT,
            run TEXT, capability TEXT, expires INTEGER);
        INSERT INTO execution_sessions VALUES
            ('session','owner','project','sandbox','volume',1,'READY',NULL,NULL,NULL);
    `);
    previous.close();
    const host = new SingleHostExecution(
        {
            authority,
            history: join(path, 'history.sqlite'),
            ...(process.env.BENTO_TEST_GO_CONTROL
                ? { goControl: process.env.BENTO_TEST_GO_CONTROL }
                : {}),
        },
        {
            async start() {},
            async stop() {},
            async stopped() {
                return true;
            },
            async running(binding) {
                return {
                    sandbox: binding.sandbox,
                    volume: binding.volume,
                    installed: true,
                    running: true,
                };
            },
        },
    );
    try {
        assert.equal(host.inspect('session').volume, 'volume');
        assert.equal(host.sessionAvailable('session'), true);
        assert.equal(host.admit('session', 1, 'run', 1000).run, 'run');
    } finally {
        host.close();
    }
});

test('shared volume keeps write authority and references across unconfirmed host operations', async () => {
    const path = await mkdtemp(join(tmpdir(), 'bento-shared-volume-'));
    const paths = {
        authority: join(path, 'authority.sqlite'),
        history: join(path, 'history.sqlite'),
        ...(process.env.BENTO_TEST_GO_CONTROL
            ? { goControl: process.env.BENTO_TEST_GO_CONTROL }
            : {}),
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

test('attachment uses the surviving source Session after releasing the original', async (t) => {
    const path = await mkdtemp(join(tmpdir(), 'bento-surviving-session-'));
    t.after(() => rm(path, { recursive: true, force: true }));
    const base = localHost(join(path, 'volume'));
    const service = await serveExecution({
        state: join(path, 'state'),
        token: testToken,
        ...(process.env.BENTO_TEST_GO_CONTROL
            ? { goControl: process.env.BENTO_TEST_GO_CONTROL }
            : {}),
        host: {
            ...base,
            async stop() {},
            async stopped() {
                return true;
            },
            sharedVolume: {
                async attach(binding) {
                    return {
                        sandbox: binding.sandbox,
                        volume: binding.volume,
                        running: true,
                        installed: true,
                    };
                },
                async detach() {},
                async reclaim() {},
            },
        },
    });
    try {
        const api = client(service.url);
        const created = await api(
            '',
            'POST',
            { name: 'Shared', files: [{ path: 'README.md', text: 'Shared' }] },
            'attach',
        );
        assert.equal(created.status, 201);
        const { id } = created.json();
        await until(
            () => api('/' + id),
            (result) => result.json().status === 'ready',
            'project ready',
        );
        const control = service.sharedSessions!;
        const first = control.projectBinding('account-a', id);
        const second = { ...first, session: randomUUID(), sandbox: 'second' };
        const third = { ...first, session: randomUUID(), sandbox: 'third' };
        await control.attach(first, second);
        assert.equal(await control.release(first), 'released');
        await assert.rejects(
            control.attach({ ...second, sandbox: 'wrong' }, third),
            /source binding denied/,
        );
        assert.equal((await control.attach(second, third)).state, 'READY');
        assert.equal(control.inspect(third.session).volume, first.volume);
        const body = { prompt: 'Shared volume Run', sessionId: third.session };
        const accepted = await api(
            '/' + id + '/runs',
            'POST',
            body,
            'shared-run',
        );
        assert.equal(accepted.status, 202);
        assert.equal(accepted.json().sessionId, third.session);
        const replay = await api(
            '/' + id + '/runs',
            'POST',
            body,
            'shared-run',
        );
        assert.equal(replay.status, 200);
        assert.equal(replay.json().id, accepted.json().id);
        const changed = await api(
            '/' + id + '/runs',
            'POST',
            { ...body, sessionId: second.session },
            'shared-run',
        );
        assert.equal(changed.status, 409);
    } finally {
        await service.close();
    }
});
