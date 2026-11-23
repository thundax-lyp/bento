import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import {
    connect,
    createSecureServer,
    type ClientHttp2Session,
    type ServerHttp2Session,
    type Http2Server,
    type Http2SecureServer,
} from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PreparedSdk, SdkMethod } from '../binding-grants/sdk.ts';
import type { Actor, BindingFixture } from './fixture.ts';
import { sha256 } from './state.ts';

const exec = promisify(execFile);
function frame(bytes: Uint8Array) {
    const header = Buffer.alloc(5);
    header.writeUInt32BE(bytes.length, 1);
    return Buffer.concat([header, bytes]);
}
export async function createBindingGateway(
    fixture: BindingFixture,
    sdk: PreparedSdk,
) {
    const folder = await mkdtemp(join(tmpdir(), 'bento-a102-tls-'));
    const clients = new Set<ClientHttp2Session>();
    const sessions = new Set<ServerHttp2Session>();
    const records: {
        sandbox: string;
        method: SdkMethod;
        fileSha256: string;
        authenticated: boolean;
    }[] = [];
    const failures: unknown[] = [];
    let upstream: Http2SecureServer | undefined;
    let ingress: Http2Server | undefined;
    let url = '';
    let closed = false;
    async function listen(server: Http2Server | Http2SecureServer) {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        assert(address && typeof address === 'object');
        server.on('sessionError', () => {});
        server.on('session', (session) => {
            sessions.add(session);
            session.on('error', () => {});
            session.once('close', () => sessions.delete(session));
        });
        return address.port;
    }
    async function close() {
        if (closed) return;
        const closingSessions = [...clients, ...sessions].map(
            async (session) => {
                if (session.destroyed) return;
                const done = new Promise<void>((resolve) =>
                    session.once('close', resolve),
                );
                session.destroy();
                await done;
            },
        );
        const closingServers = [ingress, upstream]
            .filter((server) => server?.listening)
            .map(
                (server) =>
                    new Promise<void>((resolve, reject) =>
                        server!.close((error) =>
                            error ? reject(error) : resolve(),
                        ),
                    ),
            );
        const results = await Promise.allSettled([
            ...closingSessions,
            ...closingServers,
        ]);
        const errors = results
            .filter((result) => result.status === 'rejected')
            .map((result) => result.reason);
        if (errors.length)
            throw new AggregateError(
                errors,
                'A1-02 gateway cleanup failed; retained private TLS directory',
            );
        await rm(folder, { recursive: true, force: true });
        closed = true;
        if (failures.length)
            throw new AggregateError(failures, 'A1-02 upstream failed');
    }
    try {
        const openssl = (args: string[]) =>
            exec('openssl', args, {
                cwd: folder,
                timeout: 30000,
                maxBuffer: 1024 * 1024,
            });
        await openssl([
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-days',
            '1',
            '-subj',
            '/CN=a102-ca',
            '-addext',
            'basicConstraints=critical,CA:TRUE',
            '-keyout',
            'ca.key',
            '-out',
            'ca.crt',
        ]);
        for (const name of ['server', 'client']) {
            await openssl([
                'req',
                '-new',
                '-newkey',
                'rsa:2048',
                '-nodes',
                '-subj',
                '/CN=a102-' + name,
                '-keyout',
                name + '.key',
                '-out',
                name + '.csr',
            ]);
            await writeFile(
                join(folder, name + '.ext'),
                'basicConstraints=CA:FALSE\nextendedKeyUsage=' +
                    (name === 'server'
                        ? 'serverAuth\nsubjectAltName=IP:127.0.0.1\n'
                        : 'clientAuth\n'),
                { mode: 0o600 },
            );
            await openssl([
                'x509',
                '-req',
                '-in',
                name + '.csr',
                '-CA',
                'ca.crt',
                '-CAkey',
                'ca.key',
                '-CAcreateserial',
                '-days',
                '1',
                '-extfile',
                name + '.ext',
                '-out',
                name + '.crt',
            ]);
            for (const extension of ['key', 'crt', 'csr'])
                await chmod(join(folder, name + '.' + extension), 0o600);
        }
        for (const name of ['ca.key', 'ca.crt'])
            await chmod(join(folder, name), 0o600);
        const read = (name: string) => readFile(join(folder, name));
        const ca = await read('ca.crt');
        upstream = createSecureServer({
            ca,
            cert: await read('server.crt'),
            key: await read('server.key'),
            requestCert: true,
            rejectUnauthorized: true,
        });
        upstream.on('stream', (stream, headers) => {
            stream.on('error', () => {});
            void (async () => {
                const chunks: Buffer[] = [];
                for await (const chunk of stream)
                    chunks.push(Buffer.from(chunk));
                const bytes = Buffer.concat(chunks);
                assert.equal(bytes[0], 0);
                assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
                const method = (
                    [
                        'GetSandbox',
                        'ExecSandbox',
                        'ExecSandboxInteractive',
                    ] as const
                ).find(
                    (method) =>
                        headers[':path'] ===
                        '/openshell.v1.OpenShell/' + method,
                );
                assert(method);
                const target = sdk.decode(method, bytes.subarray(5));
                assert(target !== 'stdin');
                const actor = (['A', 'B'] as const).find(
                    (actor) =>
                        fixture.bindings[actor].sandbox === target.sandbox,
                );
                assert(actor);
                const socket = stream.session!
                    .socket as import('node:tls').TLSSocket;
                assert.equal(socket.authorized, true);
                const file = await readFile(
                    join(fixture.volumes[actor], 'canary.txt'),
                );
                records.push({
                    sandbox: target.sandbox,
                    method,
                    fileSha256: sha256(file),
                    authenticated: socket.authorized,
                });
                stream.respond(
                    { ':status': 200, 'content-type': 'application/grpc' },
                    { waitForTrailers: true },
                );
                stream.once('wantTrailers', () =>
                    stream.sendTrailers({ 'grpc-status': '0' }),
                );
                stream.end(
                    frame(
                        method === 'GetSandbox'
                            ? new Uint8Array()
                            : sdk.exit(0),
                    ),
                );
            })().catch((error) => {
                failures.push(error);
                stream.close();
            });
        });
        const port = await listen(upstream);
        ingress = fixture.controller.sdkIngress({
            upstream: new URL('https://127.0.0.1:' + port),
            credentials: {
                ca,
                cert: await read('client.crt'),
                key: await read('client.key'),
            },
            workspace: 'default',
            decode: sdk.decode,
            decodeExecEvent: sdk.decodeExecEvent,
        });
        url = 'http://127.0.0.1:' + (await listen(ingress));
        return {
            calls: () => records.map((record) => ({ ...record })),
            async request(actor: Actor, method: SdkMethod, target: string) {
                const client = connect(url);
                clients.add(client);
                client.on('error', () => {});
                const stream = client.request({
                    ':method': 'POST',
                    ':path': '/openshell.v1.OpenShell/' + method,
                    'content-type': 'application/grpc',
                    te: 'trailers',
                    authorization: 'Bearer ' + fixture.grant(actor).token,
                });
                const chunks: Buffer[] = [];
                let grpcStatus: string | undefined;
                let responseHeaders: Record<string, unknown> = {};
                stream.on('response', (headers) => {
                    responseHeaders = { ...headers };
                    grpcStatus = headers['grpc-status'] as string | undefined;
                });
                stream.on('trailers', (headers) => {
                    grpcStatus = headers['grpc-status'] as string | undefined;
                });
                stream.on('data', (chunk: Buffer) => chunks.push(chunk));
                const ended = new Promise<void>((resolve, reject) => {
                    stream.once('end', resolve);
                    stream.once('error', reject);
                });
                stream.setTimeout(5000, () =>
                    stream.destroy(new Error('A1-02 SDK request timeout')),
                );
                stream.end(frame(sdk.encode(method, 'start', target)));
                try {
                    await ended;
                    return {
                        grpcStatus,
                        headers: responseHeaders,
                        body: Buffer.concat(chunks),
                    };
                } finally {
                    stream.close();
                    const done = new Promise<void>((resolve) =>
                        client.once('close', resolve),
                    );
                    client.destroy();
                    await done;
                    clients.delete(client);
                }
            },
            close,
        };
    } catch (error) {
        try {
            await close();
        } catch (cleanup) {
            throw new AggregateError(
                [error, cleanup],
                'A1-02 gateway setup and cleanup failed',
                { cause: cleanup },
            );
        }
        throw error;
    }
}
