import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { writeFileSync } from 'node:fs';
import { commandHost } from '@orchestrator/execution-service/command-host.ts';
import { SingleHostExecution } from '@orchestrator/openshell/single-host.ts';
const mode = process.argv[2];
const sandbox = process.env.A307_SANDBOX;
const volume = process.env.A307_VOLUME;
const binding = {
    tenant: 'tenant',
    project: 'project',
    session: 'session',
    sandbox,
    volume,
};
const version = 'sha256:' + '0'.repeat(64);
writeFileSync(
    'sdk-host.json',
    JSON.stringify({
        imageDigest: version,
        policyDigest: version,
        gateway: process.env.A307_GATEWAY_URL,
        workspace: 'default',
        ca: '/gateway/client/ca.crt',
        cert: '/gateway/client/tls.crt',
        key: '/gateway/client/tls.key',
        sdkRaw: '/gateway/sdk/dist/gen/openshell_pb.js',
        control: {
            command: process.execPath,
            args: ['/lease/sdk-control.mjs'],
            env: {
                A307_SANDBOX: sandbox,
                A307_VOLUME: volume,
                A307_GATEWAY_URL: process.env.A307_GATEWAY_URL,
            },
        },
        worker: { command: '/bin/false' },
    }),
    { mode: 0o600 },
);
const host = await commandHost(process.cwd() + '/sdk-host.json');
const control = new SingleHostExecution(
    {
        authority: process.cwd() + '/authority.sqlite',
        history: process.cwd() + '/history.sqlite',
        goControl: '/lease/control',
    },
    host,
);
try {
    if (mode === 'initial') {
        control.bind(binding, {
            sandbox,
            volume,
            running: true,
            installed: true,
        });
        control.admit(binding.session, 1, 'run', 300000);
    } else if (mode === 'pending') {
        await assert.rejects(control.takeover(binding.session, 1));
        assert.equal(control.inspect(binding.session).state, 'START_UNKNOWN');
        assert.equal(control.inspect(binding.session).run, 'run');
        process.exitCode = 0;
    }
    if (mode !== 'pending') {
        const result = await control.takeover(binding.session, 1);
        assert.equal(result.state, 'READY');
        assert.equal(result.generation, 2);
        console.log('real OpenShell command host READY generation 2');
    }
} finally {
    control.close();
}
