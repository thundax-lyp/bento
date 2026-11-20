import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerHttp2Session } from 'node:http2';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { PreparedSdk } from '@/apps/orchestrator/openshell/binding-grants/sdk.ts';
import { prepareReuseSdk } from '@/apps/orchestrator/acceptance/worker-reuse/sdk.ts';
import { createRunSdkTransport } from './sdk-transport.ts';

let sdk: PreparedSdk;
let createClient: (run: ReturnType<typeof createRunSdkTransport>) => {
    get(name: string): Promise<{ name: string }>;
};
let response: Buffer;
const timeout = { timeout: 30_000, concurrency: false };
before(
    async () => {
        sdk = await prepareReuseSdk();
        const api = await import(
            pathToFileURL(join(dirname(sdk.raw), 'index.js')).href
        );
        const schemas = await import(pathToFileURL(sdk.raw).href);
        const require = createRequire(sdk.raw);
        const protobuf = await import(
            pathToFileURL(require.resolve('@bufbuild/protobuf')).href
        );
        const bytes = protobuf.toBinary(
            schemas.SandboxResponseSchema,
            protobuf.create(schemas.SandboxResponseSchema, {
                sandbox: {
                    metadata: { id: 'fixture-id', name: 'fixture-sandbox' },
                },
            }),
        );
        response = Buffer.alloc(bytes.length + 5);
        response.writeUInt32BE(bytes.length, 1);
        response.set(bytes, 5);
        createClient = (run) => new api.SandboxClient(run.transport);
    },
    { timeout: 600_000 },
);
after(async () => sdk?.dispose());

async function gateway(hold = false) {
    const server = createServer();
    const sessions = new Set<ServerHttp2Session>();
    const headers: string[] = [];
    let connections = 0;
    let received!: () => void;
    const request = new Promise<void>((resolve) => (received = resolve));
    server.on('session', (session) => {
        connections++;
        sessions.add(session);
        session.on('error', () => undefined);
        session.once('close', () => sessions.delete(session));
    });
    server.on('stream', (stream, header) => {
        stream.on('error', () => undefined);
        headers.push(String(header.authorization));
        stream.on('data', () => undefined);
        stream.on('end', () => {
            received();
            if (hold) return;
            stream.respond(
                { ':status': 200, 'content-type': 'application/grpc' },
                { waitForTrailers: true },
            );
            stream.on('wantTrailers', () =>
                stream.sendTrailers({ 'grpc-status': '0' }),
            );
            stream.end(response);
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address === 'object');
    return {
        url: 'http://127.0.0.1:' + address.port,
        request,
        headers,
        sessions,
        get connections() {
            return connections;
        },
        async close() {
            for (const session of sessions) session.destroy();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        },
    };
}

test(
    'Run SDK rejects external gateways and malformed credentials',
    timeout,
    () => {
        for (const url of [
            'https://127.0.0.1:1234',
            'http://localhost:1234',
            'http://127.0.0.1:0',
            'http://127.0.0.1:65536',
            'http://127.0.0.1:1234/path',
            'http://127.0.0.1:1234?token=secret',
            'http://user@127.0.0.1:1234',
            'http://127.0.0.1:1234#fragment',
        ])
            assert.throws(() => createRunSdkTransport(url, 'fixture-token'));
        for (const token of [
            '',
            'space token',
            'a\rb',
            'a\nb',
            'a'.repeat(1025),
        ])
            assert.throws(() =>
                createRunSdkTransport('http://127.0.0.1:1234', token),
            );
    },
);

test(
    'official SDK uses each Run credential and closes each real connection',
    timeout,
    async () => {
        const host = await gateway();
        try {
            for (const token of ['fixture-first', 'fixture-next']) {
                const run = createRunSdkTransport(host.url, token);
                const client = createClient(run);
                assert.equal(
                    (await client.get('fixture-sandbox')).name,
                    'fixture-sandbox',
                );
                const peerClosed = once([...host.sessions][0]!, 'close');
                const firstClose = run.close();
                assert.equal(run.close(), firstClose);
                await firstClose;
                await peerClosed;
                assert.equal(host.sessions.size, 0);
                await assert.rejects(client.get('fixture-sandbox'));
            }
            assert.deepEqual(host.headers, [
                'Bearer fixture-first',
                'Bearer fixture-next',
            ]);
            assert.equal(host.connections, 2);
        } finally {
            await host.close();
        }
    },
);

test(
    'Run close terminates a held RPC before allowing another request',
    timeout,
    async () => {
        const host = await gateway(true);
        const run = createRunSdkTransport(host.url, 'fixture-held');
        try {
            const client = createClient(run);
            const call = assert.rejects(client.get('fixture-sandbox'));
            await host.request;
            const peerClosed = once([...host.sessions][0]!, 'close');
            await run.close();
            await peerClosed;
            assert.equal(host.sessions.size, 0);
            await call;
            await assert.rejects(client.get('fixture-sandbox'));
            assert.equal(host.connections, 1);
            assert.equal(host.headers.length, 1);
        } finally {
            await run.close();
            await host.close();
        }
    },
);

test(
    'a real server disconnect is not hidden by reconnecting the Run client',
    timeout,
    async () => {
        const host = await gateway();
        const run = createRunSdkTransport(host.url, 'fixture-disconnect');
        try {
            const client = createClient(run);
            await client.get('fixture-sandbox');
            const session = [...host.sessions][0]!;
            const closed = once(session, 'close');
            session.destroy();
            await closed;
            await assert.rejects(client.get('fixture-sandbox'));
            assert.equal(host.connections, 1);
        } finally {
            await run.close();
            await host.close();
        }
    },
);

test(
    'close deadline reports residuals instead of reporting release',
    timeout,
    async (t) => {
        const host = await gateway();
        const run = createRunSdkTransport(host.url, 'fixture-private-secret');
        try {
            await createClient(run).get('fixture-sandbox');
            t.mock.timers.enable({ apis: ['setTimeout'] });
            const close = run.close();
            const failed = assert.rejects(close, (error: Error) => {
                assert.match(error.message, /resources remained.*sdk-close/);
                assert(!error.message.includes('fixture-private-secret'));
                return true;
            });
            t.mock.timers.tick(5000);
            await failed;
        } finally {
            t.mock.timers.reset();
            await host.close();
        }
    },
);
