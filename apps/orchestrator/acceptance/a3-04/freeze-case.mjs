import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:http2';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { SingleHostExecution } from './apps/orchestrator/src/openshell/single-host.ts';
import {
    schemaDecoder,
    schemaExecEventDecoder,
} from './apps/orchestrator/src/execution-service/command-host.ts';
const raw = '/candidate/sdk/dist/raw.js';
const schemas = await import(raw);
const { create, toBinary } = await import(
    pathToFileURL(createRequire(raw).resolve('@bufbuild/protobuf')).href
);
const d = mkdtempSync(join(tmpdir(), 'a304-'));
const c = new SingleHostExecution(
    { authority: join(d, 'authority.db'), history: join(d, 'history.db') },
    {
        async stop() {},
        async stopped() {
            return false;
        },
    },
);
const binding = {
    tenant: 'worker-a-acceptance',
    project: randomUUID(),
    session: randomUUID(),
    sandbox: process.env.A304_SANDBOX,
    volume: process.env.A304_VOLUME,
};
c.bind(binding, {
    sandbox: binding.sandbox,
    volume: binding.volume,
    running: true,
    installed: true,
});
const grant = c.admit(binding.session, 1, randomUUID(), 60000);
const decisions = [];
const server = c.sdkIngress({
    upstream: new URL(process.env.A304_GATEWAY_URL),
    workspace: 'default',
    audit: (event) => decisions.push(event.outcome),
    credentials: {
        ca: readFileSync('/candidate/ca.crt'),
        key: readFileSync('/candidate/pki/tls.key'),
        cert: readFileSync('/candidate/pki/tls.crt'),
    },
    decode: await schemaDecoder(raw),
    decodeExecEvent: await schemaExecEventDecoder(raw),
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const client = connect('http://127.0.0.1:' + server.address().port);
const route = '/openshell.v1.OpenShell/ExecSandboxInteractive';
const open = () =>
    client.request({
        ':method': 'POST',
        ':path': route,
        'content-type': 'application/grpc',
        te: 'trailers',
        authorization: 'Bearer ' + grant.token,
    });
const frame = (payload) => {
    const b = Buffer.from(
        toBinary(
            schemas.ExecSandboxInputSchema,
            create(schemas.ExecSandboxInputSchema, { payload }),
        ),
    );
    const h = Buffer.alloc(5);
    h.writeUInt32BE(b.length, 1);
    return Buffer.concat([h, b]);
};
const stdin = (value) =>
    frame({ case: 'stdin', value: Buffer.from(value + '\n') });
const deadline = setTimeout(() => {
    console.error('A304_PROBE_TIMEOUT');
    process.exit(2);
}, 18000);
const suffix = process.env.A304_SUFFIX;
assert.match(suffix, /^[a-z0-9]+$/);
const path = '/sandbox/work/a304-' + suffix;
const stream = open();
stream.on('error', () => {});
let status,
    seen = Buffer.alloc(0);
const heldClosed = once(stream, 'close');
stream.on('response', (h) => {
    status = h['grpc-status'] ?? status;
});
stream.on('trailers', (h) => {
    status = h['grpc-status'] ?? status;
});
try {
    const ready = new Promise((resolve) =>
        stream.on('data', (chunk) => {
            seen = Buffer.concat([seen, chunk]);
            if (seen.includes(Buffer.from('a304-positive-control'))) resolve();
        }),
    );
    stream.write(
        frame({
            case: 'start',
            value: {
                sandbox: binding.sandbox,
                workspaceScope: {
                    selection: { case: 'workspace', value: 'default' },
                },
                command: [
                    '/bin/sh',
                    '-c',
                    'read line; command -v setsid >/dev/null || exit 45; setsid sh -c "touch ' +
                        path +
                        '.ready; sleep 3; printf child > ' +
                        path +
                        '.after" </dev/null >/dev/null 2>&1 & child=$!; for i in 1 2 3 4 5 6 7 8 9 10; do test -e ' +
                        path +
                        '.ready && break; sleep 0.1; done; test -e ' +
                        path +
                        '.ready && kill -0 "$child" && printf "%s" "$line" > ' +
                        path +
                        '.before; printf a304-positive-control; wait "$child"',
                ],
                tty: false,
            },
        }),
    );
    stream.write(stdin('positive'));
    await Promise.race([
        ready,
        heldClosed.then(() => {
            throw Error('Stream ended before positive control, grpc ' + status);
        }),
    ]);
    console.log('A304_FENCE_READY');
    while (!existsSync('/tmp/a304-fenced-' + suffix))
        await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(
        c.takeover(binding.session, 1),
        /old execution unconfirmed/,
    );
    assert.equal(c.inspect(binding.session).state, 'UNKNOWN');

    stream.end();
    await heldClosed;
    assert(decisions.includes('deny'));
    assert(stream.closed);
    const retry = open();
    const [headers] = await (async () => {
        const result = once(retry, 'response');
        retry.end();
        return result;
    })();
    assert.equal(headers['grpc-status'], '16');
    retry.resume();
    console.log('A304_REVOCATION_AFTER_CONFIRMED_FREEZE');
} finally {
    clearTimeout(deadline);
    client.destroy();
    server.close();
    c.close();
    rmSync(d, { recursive: true, force: true });
}
