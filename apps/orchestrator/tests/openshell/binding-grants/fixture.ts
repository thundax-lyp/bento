import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { type Server as HttpServer } from 'node:http';
import {
    connect,
    createSecureServer,
    type ClientHttp2Session,
    type ServerHttp2Session,
    type ServerHttp2Stream,
    type Http2Server,
    type Http2SecureServer,
} from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type { TLSSocket } from 'node:tls';
import { promisify } from 'node:util';
import { SingleHostExecution } from '@/apps/orchestrator/src/openshell/single-host.ts';
import type { PreparedSdk, SdkMethod } from './sdk.ts';

type Row = Record<string, SQLOutputValue>;
export const methods: readonly SdkMethod[] = [
    'GetSandbox',
    'ExecSandbox',
    'ExecSandboxInteractive',
];
const rpcPrefix = '/openshell.v1.OpenShell/';
const exec = promisify(execFile);

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}

export async function bounded<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
) {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(label + ' timed out')),
                    ms,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
export function frame(bytes: Uint8Array): Buffer {
    const header = Buffer.alloc(5);
    header.writeUInt32BE(bytes.length, 1);
    return Buffer.concat([header, bytes]);
}
async function listen(server: HttpServer | Http2Server | Http2SecureServer) {
    server.listen(0, '127.0.0.1');
    await bounded(once(server, 'listening'), 5000, 'listen');
    const address = server.address();
    assert(address && typeof address === 'object');
    return address.port;
}
function closed(session: ClientHttp2Session | ServerHttp2Session) {
    const promise = new Promise<void>((resolve) =>
        session.once('close', resolve),
    );
    session.on('error', () => {});
    return promise;
}

export async function createGrantFixture(sdk: PreparedSdk) {
    const folder = await mkdtemp(join(tmpdir(), 'bento-a103-grant-'));
    await chmod(folder, 0o700);
    const paths = {
        authority: join(folder, 'authority.sqlite'),
        history: join(folder, 'history.sqlite'),
    };
    const binding = {
        tenant: 'a103-tenant',
        project: randomUUID(),
        session: randomUUID(),
        sandbox: 'a103-sandbox',
        volume: randomUUID(),
    };
    const clients = new Map<ClientHttp2Session, Promise<void>>();
    const sessions = new Map<ServerHttp2Session, Promise<void>>();
    const failures: unknown[] = [];
    const upstreamSessions = new Map<ServerHttp2Session, Promise<void>>();
    const sdkStreams = new Map<ServerHttp2Stream, Promise<void>>();
    let stopCalls = 0;
    let startCalls = 0;
    let revokeBarrier:
        | { resolve(): void; reject(error: unknown): void; deadline: number }
        | undefined;
    let nextHeld:
        | {
              ready: ReturnType<typeof deferred<void>>;
              upstreamClosed: ReturnType<typeof deferred<void>>;
          }
        | undefined;
    let requests = 0;
    let stdin = 0;
    const running = true;
    const observation = () => ({
        sandbox: binding.sandbox,
        volume: binding.volume,
        running,
        installed: true,
    });
    const sandbox = {
        async stop() {
            stopCalls++;
            assert(revokeBarrier);
            const row = snapshot();
            assert.equal(row.revoked, 1);
            assert.equal(row.generation, 1);
            assert.equal(row.state, 'UNKNOWN');
            for (const [key, value] of Object.entries(binding))
                assert.equal(row[key], value);
            assert.equal(fence().revoked, true);
            revokeBarrier.resolve();
        },
        async stopped() {
            return false;
        },
        async start() {
            startCalls++;
            throw new Error('A1-03 cannot start without stop proof');
        },
        async running() {
            return observation();
        },
    };
    let controller: SingleHostExecution | undefined;
    let sdkServer: Http2Server | undefined;
    let operationServer: HttpServer | undefined;
    let upstream: Http2SecureServer | undefined;
    let sdkUrl = '';
    let operationUrl = '';
    let disposal: Promise<void> | undefined;
    function track(server: Http2Server | Http2SecureServer, ingress = false) {
        if (ingress)
            server.on('stream', (stream) => {
                sdkStreams.set(
                    stream,
                    new Promise<void>((resolve) =>
                        stream.once('close', resolve),
                    ),
                );
            });
        server.on('sessionError', () => {});
        server.on('session', (session) => {
            sessions.set(session, closed(session));
        });
    }
    function query(path: string, sql: string): Row[] {
        const db = new DatabaseSync(path, { readOnly: true });
        try {
            return db.prepare(sql).all(binding.session);
        } finally {
            db.close();
        }
    }
    function snapshot() {
        const rows = query(
            paths.authority,
            'SELECT tenant,project,session,sandbox,volume,generation,state,run,expires,capability IS NULL AS revoked FROM execution_sessions WHERE session=?',
        );
        assert.equal(rows.length, 1);
        return rows[0]!;
    }
    function fence() {
        const rows = query(
            paths.history,
            'SELECT epoch,owner,handle FROM sessions WHERE id=?',
        );
        assert(rows.length <= 1);
        const row = rows[0];
        return {
            hasHistory: !!row,
            revoked:
                !row ||
                (row.epoch === 1 &&
                    row.owner === 'bento:revoked' &&
                    row.handle === null),
        };
    }
    function history() {
        return {
            sessions: query(
                paths.history,
                'SELECT * FROM sessions WHERE id=? ORDER BY id',
            ),
            events: query(
                paths.history,
                'SELECT * FROM events WHERE id=? ORDER BY id,seq',
            ),
            receipts: query(
                paths.history,
                'SELECT * FROM batch_receipts WHERE id=? ORDER BY id,epoch,batch',
            ),
            intents: query(
                paths.history,
                'SELECT * FROM batch_intents WHERE id=? ORDER BY id',
            ),
        };
    }
    async function closeNetwork() {
        const errors: unknown[] = [];
        async function attempt(action: () => unknown | Promise<unknown>) {
            try {
                await action();
            } catch (error) {
                errors.push(error);
            }
        }
        for (const [client, done] of clients) {
            client.destroy();
            await attempt(() => bounded(done, 5000, 'client close'));
        }
        for (const server of [sdkServer, upstream, operationServer]) {
            if (!server?.listening) continue;
            const done = new Promise<void>((resolve, reject) =>
                server.close((error?: Error) =>
                    error ? reject(error) : resolve(),
                ),
            );
            if ('closeAllConnections' in server) server.closeAllConnections();
            for (const session of sessions.keys()) session.destroy();
            await attempt(() => bounded(done, 5000, 'server close'));
        }
        for (const done of sessions.values())
            await attempt(() => bounded(done, 5000, 'accepted session close'));
        if (errors.length)
            throw new AggregateError(errors, 'Grant network cleanup failed');
    }
    async function dispose() {
        disposal ??= (async () => {
            const errors: unknown[] = [...failures];
            async function attempt(action: () => unknown | Promise<unknown>) {
                try {
                    await action();
                } catch (error) {
                    errors.push(error);
                }
            }
            await attempt(closeNetwork);
            await attempt(() => controller?.close());
            await attempt(() => rm(folder, { recursive: true, force: true }));
            if (errors.length)
                throw new AggregateError(
                    errors,
                    'Grant fixture cleanup failed',
                );
        })();
        return disposal;
    }
    function beginRevoke() {
        assert(controller);
        const current = controller;
        const before = snapshot();
        const deadline = performance.now() + 10_000;
        let resolveRevoked!: () => void;
        let rejectRevoked!: (error: unknown) => void;
        const revoked = new Promise<void>((resolve, reject) => {
            resolveRevoked = resolve;
            rejectRevoked = reject;
        });
        void revoked.catch(() => {});
        revokeBarrier = {
            resolve: resolveRevoked,
            reject: rejectRevoked,
            deadline,
        };
        const remaining = () => {
            const ms = deadline - performance.now();
            if (ms <= 0) throw new Error('Revocation deadline exceeded');
            return ms;
        };
        const operation = current.takeover(binding.session, 1);
        void operation.catch((error: unknown) => {
            if (stopCalls === 0) rejectRevoked(error);
        });
        const settled = (async () => {
            try {
                await bounded(
                    assert.rejects(operation, (error: unknown) => {
                        assert(error instanceof Error);
                        assert.equal(
                            error.message,
                            'old execution unconfirmed',
                        );
                        return true;
                    }),
                    remaining(),
                    'expected takeover rejection',
                );
                await bounded(
                    Promise.all([
                        ...sdkStreams.values(),
                        ...upstreamSessions.values(),
                    ]),
                    remaining(),
                    'revoked endpoint close',
                );
                const row = snapshot();
                assert.equal(row.state, 'UNKNOWN');
                assert.equal(row.generation, 1);
                assert.equal(row.revoked, 1);
                assert.equal(row.run, before.run);
                for (const [key, value] of Object.entries(binding))
                    assert.equal(row[key], value);
                assert.equal(fence().revoked, true);
                assert.equal(stopCalls, 1);
                assert.equal(startCalls, 0);
                return {
                    state: 'UNKNOWN' as const,
                    generation: 1 as const,
                    revoked: true as const,
                    stopConfirmed: false as const,
                    error: 'old execution unconfirmed' as const,
                };
            } catch (error) {
                rejectRevoked(error);
                for (const session of sessions.keys()) session.destroy();
                try {
                    await bounded(
                        operation.catch(() => {}),
                        5000,
                        'failed revocation cleanup',
                    );
                } catch (cleanupError) {
                    throw new AggregateError(
                        [error, cleanupError],
                        'Revocation and cleanup failed',
                        { cause: cleanupError },
                    );
                }
                throw error;
            }
        })();
        void settled.catch(() => {});
        return { revoked, settled };
    }
    try {
        async function openssl(args: string[]) {
            await exec('openssl', args, {
                cwd: folder,
                timeout: 30_000,
                killSignal: 'SIGKILL',
                maxBuffer: 1024 * 1024,
            });
        }
        await openssl([
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-days',
            '1',
            '-subj',
            '/CN=a103-ca',
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
                '/CN=a103-' + name,
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
            for (const ext of ['key', 'csr', 'crt'])
                await chmod(join(folder, name + '.' + ext), 0o600);
        }
        await chmod(join(folder, 'ca.key'), 0o600);
        await chmod(join(folder, 'ca.crt'), 0o600);
        const read = (name: string) => readFile(join(folder, name));
        const ca = await read('ca.crt');
        const upstreamOptions = {
            ca,
            cert: await read('server.crt'),
            key: await read('server.key'),
            requestCert: true,
            rejectUnauthorized: true,
        };
        function makeUpstream() {
            const server = createSecureServer(upstreamOptions);
            track(server);
            server.on('session', (session) =>
                upstreamSessions.set(session, sessions.get(session)!),
            );
            server.on('stream', (stream, headers) => {
                stream.on('error', () => {});
                try {
                    assert.equal(
                        (stream.session!.socket as TLSSocket).authorized,
                        true,
                    );
                    const method = methods.find(
                        (name) => headers[':path'] === rpcPrefix + name,
                    );
                    assert(method);
                    const held =
                        method === 'ExecSandboxInteractive'
                            ? nextHeld
                            : undefined;
                    if (held) {
                        nextHeld = undefined;
                        stream.session!.once('close', () =>
                            held.upstreamClosed.resolve(),
                        );
                    }
                    requests++;
                    let buffer = Buffer.alloc(0);
                    let started = false;
                    stream.on('data', (chunk: Buffer) => {
                        try {
                            buffer = Buffer.concat([buffer, chunk]);
                            while (buffer.length >= 5) {
                                const size = buffer.readUInt32BE(1);
                                assert.equal(buffer[0], 0);
                                assert(size <= 1024 * 1024);
                                if (buffer.length < size + 5) break;
                                const decoded = sdk.decode(
                                    method,
                                    buffer.subarray(5, size + 5),
                                );
                                if (!started) {
                                    assert.notEqual(decoded, 'stdin');
                                    assert(typeof decoded !== 'string');
                                    assert.equal(
                                        decoded.sandbox,
                                        binding.sandbox,
                                    );
                                    assert.equal(decoded.workspace, 'default');
                                    started = true;
                                } else {
                                    assert.equal(decoded, 'stdin');
                                    stdin++;
                                    held?.ready.resolve();
                                }
                                buffer = buffer.subarray(size + 5);
                            }
                        } catch (error) {
                            failures.push(error);
                            stream.destroy();
                        }
                    });
                    stream.on('end', () => {
                        if (held) return;
                        try {
                            assert(started);
                            assert.equal(buffer.length, 0);
                            stream.respond(
                                {
                                    ':status': 200,
                                    'content-type': 'application/grpc',
                                },
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
                        } catch (error) {
                            failures.push(error);
                            stream.destroy();
                        }
                    });
                } catch (error) {
                    failures.push(error);
                    stream.destroy();
                }
            });
            return server;
        }
        upstream = makeUpstream();
        let upstreamPort = await listen(upstream);
        controller = new SingleHostExecution(paths, sandbox);
        controller.bind(binding, observation());
        const grant = controller.admit(
            binding.session,
            1,
            randomUUID(),
            300_000,
        );
        const credentials = {
            ca,
            cert: await read('client.crt'),
            key: await read('client.key'),
        };
        async function openIngresses() {
            assert(controller);
            sdkServer = controller.sdkIngress({
                upstream: new URL('https://127.0.0.1:' + upstreamPort),
                credentials,
                workspace: 'default',
                decode: sdk.decode,
                decodeExecEvent: sdk.decodeExecEvent,
            });
            track(sdkServer, true);
            sdkUrl = 'http://127.0.0.1:' + (await listen(sdkServer));
            operationServer = controller.operationIngress();
            operationUrl =
                'http://127.0.0.1:' + (await listen(operationServer));
        }
        await openIngresses();
        return {
            get controller() {
                assert(controller);
                return controller;
            },
            binding,
            grant,
            get sdkUrl() {
                return sdkUrl;
            },
            get operationUrl() {
                return operationUrl;
            },
            connect() {
                const client = connect(sdkUrl);
                clients.set(client, closed(client));
                return client;
            },
            async request(
                client: ClientHttp2Session,
                method: SdkMethod,
                {
                    authorization = 'Bearer ' + grant.token,
                }: { authorization?: string | null } = {},
            ) {
                const stream = client.request({
                    ':method': 'POST',
                    ':path': rpcPrefix + method,
                    'content-type': 'application/grpc',
                    te: 'trailers',
                    ...(authorization === null ? {} : { authorization }),
                });
                let status: string | undefined;
                let headerStatus: string | undefined;
                const response: Buffer[] = [];
                stream.on('data', (bytes: Buffer) => response.push(bytes));
                stream.on('response', (headers) => {
                    headerStatus = headers['grpc-status'] as string | undefined;
                    status = headerStatus;
                });
                stream.on('trailers', (headers) => {
                    status = headers['grpc-status'] as string | undefined;
                });
                stream.resume();
                const done = new Promise<void>((resolve, reject) => {
                    stream.once('end', resolve);
                    stream.once('error', reject);
                });
                stream.end(frame(sdk.encode(method, 'start', binding.sandbox)));
                try {
                    await bounded(done, 5000, method);
                } finally {
                    stream.close();
                }
                assert.equal(typeof status, 'string');
                if (status === '0')
                    assert.deepEqual(
                        Buffer.concat(response),
                        frame(
                            method === 'GetSandbox'
                                ? new Uint8Array()
                                : sdk.exit(0),
                        ),
                    );
                return {
                    status: status!,
                    headerStatus,
                    upstreamCalls: requests,
                };
            },
            async openInteractive(client: ClientHttp2Session) {
                assert.equal(nextHeld, undefined);
                const held = {
                    ready: deferred<void>(),
                    upstreamClosed: deferred<void>(),
                };
                nextHeld = held;
                const stream = client.request({
                    ':method': 'POST',
                    ':path': rpcPrefix + 'ExecSandboxInteractive',
                    'content-type': 'application/grpc',
                    te: 'trailers',
                    authorization: 'Bearer ' + grant.token,
                });
                const status = deferred<string>();
                const done = new Promise<void>((resolve) =>
                    stream.once('close', resolve),
                );
                stream.on('response', (headers) => {
                    const value = headers['grpc-status'];
                    status.resolve(
                        typeof value === 'string' ? value : 'missing',
                    );
                });
                stream.on('error', status.reject);
                // A denied bidirectional response ends before its caller's send side.
                stream.once('end', () => stream.close());
                stream.resume();
                stream.write(
                    frame(
                        sdk.encode(
                            'ExecSandboxInteractive',
                            'start',
                            binding.sandbox,
                        ),
                    ),
                );
                stream.write(
                    frame(
                        sdk.encode(
                            'ExecSandboxInteractive',
                            'stdin',
                            binding.sandbox,
                        ),
                    ),
                );
                await bounded(
                    held.ready.promise,
                    5000,
                    'held start and stdin upstream',
                );
                return {
                    sendStdin() {
                        if (stream.closed || stream.destroyed)
                            throw new Error('Held stream already closed');
                        stream.write(
                            frame(
                                sdk.encode(
                                    'ExecSandboxInteractive',
                                    'stdin',
                                    binding.sandbox,
                                ),
                            ),
                        );
                    },
                    status: status.promise,
                    closed: done,
                    upstreamClosed: held.upstreamClosed.promise,
                };
            },
            beginRevoke,
            revoke: async () => await beginRevoke().settled,
            async reopen() {
                await closeNetwork();
                controller!.close();
                controller = new SingleHostExecution(paths, sandbox);
                upstream = makeUpstream();
                upstreamPort = await listen(upstream);
                await openIngresses();
            },
            snapshot,
            fence,
            history,
            counts: () => ({ requests, stdin }),
            operations: () =>
                query(
                    paths.authority,
                    'SELECT session,generation,id,digest,state FROM operations WHERE session=? ORDER BY id',
                ),
            dispose,
        };
    } catch (error) {
        try {
            await dispose();
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                'Grant fixture setup failed',
                { cause: cleanupError },
            );
        }
        throw error;
    }
}
