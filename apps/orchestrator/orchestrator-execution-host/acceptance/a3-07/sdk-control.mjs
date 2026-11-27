import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { SandboxClient } from '/gateway/sdk/dist/index.js';
import { OpenShell } from '/gateway/sdk/dist/gen/openshell_pb.js';
import { buildTransport } from '/gateway/sdk/dist/transport.js';
import { createRequire } from 'node:module';
const require = createRequire('/gateway/sdk/probe.mjs');
const { createClient } = await import(require.resolve('@connectrpc/connect'));
const config = {
    gateway: process.env.A307_GATEWAY_URL,
    caCert: readFileSync('/gateway/client/ca.crt'),
    clientCert: readFileSync('/gateway/client/tls.crt'),
    clientKey: readFileSync('/gateway/client/tls.key'),
};
const client = await SandboxClient.connect(config);
const raw = createClient(OpenShell, buildTransport(config));
const workspaceScope = { selection: { case: 'workspace', value: 'default' } };
let request = '';
if (!process.argv[2]) for await (const part of process.stdin) request += part;
const { action, binding } = request
    ? JSON.parse(request)
    : { action: process.argv[2] };
const name = process.env.A307_SANDBOX;
const vol = process.env.A307_VOLUME;
assert.match(name, /^a307-[a-z0-9-]+$/);
if (binding) {
    assert.equal(binding.sandbox, name);
    assert.equal(binding.volume, vol);
}
async function waitStopped() {
    for (let i = 0; i < 60; ++i) {
        if ((await client.get(name)).phase === 'stopped') return;
        await setTimeout(250);
    }
    assert.fail('sandbox did not stop');
}
let result = {};
switch (action) {
    case 'create':
        await client.create({
            name,
            image: 'node:22-bookworm-slim',
            tty: false,
            rawSpec: {
                template: {
                    image: 'node:22-bookworm-slim',
                    driverConfig: {
                        docker: {
                            mounts: [
                                {
                                    type: 'volume',
                                    source: vol,
                                    target: '/sandbox/a5-volume',
                                    read_only: false,
                                },
                            ],
                        },
                    },
                },
            },
        });
        await client.waitReady(name, 35);
        break;
    case 'delete':
        await client.delete(name);
        await client.waitDeleted(name, 30);
        break;
    case 'stop':
        await raw.stopSandbox({ name, workspaceScope }, { timeoutMs: 22000 });
        await waitStopped();
        break;
    case 'stopped':
        result = (await client.get(name)).phase === 'stopped';
        break;
    case 'start':
        assert.equal(binding.state, 'START_UNKNOWN');
        writeFileSync('rpc-dispatched', '1', { flag: 'wx' });
        while (true) await setTimeout(1000);
    // The broker has its own lifetime, as in the deployed command host.
    case 'broker-start': {
        const pending = raw.startSandbox(
            { name, workspaceScope },
            { timeoutMs: 22000 },
        );
        pending.catch(() => {});
        writeFileSync('rpc-sent', String(Date.now()), { flag: 'wx' });
        await pending;
        writeFileSync('rpc-returned', String(Date.now()), { flag: 'wx' });
        await client.waitReady(name, 35);
        writeFileSync('rpc-ready', String(Date.now()), { flag: 'wx' });
        break;
    }
    case 'running': {
        const running = (await client.get(name)).phase === 'ready';
        result = { sandbox: name, volume: vol, running, installed: running };
        break;
    }
    default:
        assert.fail('unrecognized action');
}
console.log(JSON.stringify(result));
