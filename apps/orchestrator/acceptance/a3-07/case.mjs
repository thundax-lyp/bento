import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setInterval } from 'node:timers';
import { setTimeout } from 'node:timers/promises';
import { SingleHostExecution } from './src/apps/orchestrator/src/openshell/single-host.ts';

const [mode, observed] = process.argv.slice(2);
const binding = {
    tenant: 'tenant',
    project: 'project',
    session: 'session',
    sandbox: 'sandbox',
    volume: 'volume',
};
const observation = {
    sandbox: binding.sandbox,
    volume: binding.volume,
    installed: true,
    running: true,
};
const paths = {
    authority: process.cwd() + '/authority.sqlite',
    history: process.cwd() + '/history.sqlite',
    goControl: '/lease/control',
};
const control = new SingleHostExecution(paths, {
    async stop() {
        assert.equal(mode, 'initial');
    },
    async stopped() {
        return true;
    },
    async start(current) {
        assert.equal(mode, 'initial');
        assert.equal(current.state, 'START_UNKNOWN');
        assert.equal(current.generation, 1);
        writeFileSync('start-request', '1', { flag: 'wx' });
        await new Promise(() => setInterval(() => {}, 1000));
    },
    async running() {
        if (mode === 'race') await setTimeout(250);
        return { ...observation, running: observed === 'true' };
    },
});
try {
    if (mode === 'initial') {
        control.bind(binding, observation);
        control.admit(binding.session, 1, 'run', 300000);
    } else if (mode === 'pending') {
        assert.equal(control.inspect(binding.session).state, 'START_UNKNOWN');
        assert.equal(control.inspect(binding.session).run, 'run');
    }
    if (mode === 'pending') {
        await assert.rejects(control.takeover(binding.session, 1));
        const { generation, state, run, hasCapability } = control.inspect(
            binding.session,
        );
        assert.deepEqual(
            { generation, state, run, hasCapability },
            {
                generation: 1,
                state: 'START_UNKNOWN',
                run: 'run',
                hasCapability: false,
            },
        );
    } else if (mode !== 'race-check') {
        try {
            const result = await control.takeover(binding.session, 1);
            assert.equal(result.state, 'READY');
            assert.equal(result.generation, 2);
            console.log('READY generation 2');
        } catch (error) {
            if (
                mode !== 'race' ||
                !/authority|stale|denied/i.test(String(error))
            )
                throw error;
            console.log('concurrent CAS rejected');
        }
    } else {
        const result = control.inspect(binding.session);
        assert.equal(result.generation, 2);
        assert.equal(result.state, 'READY');
        assert.equal(readFileSync('start-request', 'utf8'), '1');
    }
} finally {
    control.close();
}
