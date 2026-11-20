import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import {
    createSecureServer,
    type Http2Server,
    type Http2SecureServer,
    type ServerHttp2Session,
    type ServerHttp2Stream,
} from 'node:http2';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { TLSSocket } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { SingleHostExecution } from '@/apps/orchestrator/src/openshell/single-host.ts';
import type { PreparedSdk } from '@/apps/orchestrator/tests/openshell/binding-grants/sdk.ts';
import type { WorkerRequest } from '@/apps/worker/protocol.ts';
import {
    observeSdk,
    sha256,
    readReuseSnapshot,
    readWorkerProcesses,
    type ReusePaths,
} from './observer.ts';

const exec = promisify(execFile);
const workspaceRoot = '/sandbox/project';
const prefix = '/openshell.v1.OpenShell/';
type Server = HttpServer | Http2Server | Http2SecureServer;
async function listen(server: Server) {
    server.on('error', () => undefined);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address === 'object');
    return address.port;
}
async function closeServer(server: Server | undefined) {
    if (!server?.listening) return;
    const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
    if ('closeAllConnections' in server) server.closeAllConnections();
    await closed;
}

/** Owns only this local fixture. Sandbox stop is deliberately unconfirmed. */
export async function createReuseFixture(
    sdk: PreparedSdk,
    sessionCount: 2 | 65,
) {
    const directory = await fs.mkdtemp(join(tmpdir(), 'bento-reuse-fixture-'));
    await fs.chmod(directory, 0o700);
    const paths: ReusePaths = {
        authority: join(directory, 'authority.sqlite'),
        history: join(directory, 'history.sqlite'),
    };
    const entries = Array.from({ length: sessionCount }, (_, index) => ({
        binding: {
            tenant: 'reuse-tenant-' + (index % 8),
            project: randomUUID(),
            session: randomUUID(),
            sandbox: 'reuse-' + randomUUID(),
            volume: randomUUID(),
        },
        prompt: 'reuse-marker-' + randomUUID(),
    }));
    const grants = new Map<number, WorkerRequest['grant']>();
    let controller: SingleHostExecution | undefined;
    let ingress: Http2Server | undefined;
    let persistence: HttpServer | undefined;
    let operation: HttpServer | undefined;
    let upstream: Http2SecureServer | undefined;
    let observed: ReturnType<typeof observeSdk> | undefined;
    let addresses = { gateway: '', persistenceUrl: '', operationUrl: '' };
    const upstreamSessions = new Set<ServerHttp2Session>();
    const upstreamStreams = new Set<ServerHttp2Stream>();
    const held = new Map<number, ServerHttp2Stream>();
    const problems: string[] = [];
    const controlRequests: {
        interface: 'persistence' | 'operation';
        tokenSha256: string;
        path: string;
        at: number;
        status: number | null;
        finishedAt: number | null;
    }[] = [];
    let upstreamCalls = 0;
    let authenticatedSessions = 0;
    let closing: Promise<void> | undefined;
    const revocations: {
        index: number;
        state: string;
        generation: number;
        stopConfirmed: false;
        at: number;
    }[] = [];
    async function closeControl() {
        const errors: unknown[] = [];
        const attempt = async (action: () => unknown | Promise<unknown>) => {
            try {
                await action();
            } catch (error) {
                errors.push(error);
            }
        };
        await attempt(() => observed?.close());
        await attempt(() => closeServer(ingress));
        await attempt(() => closeServer(persistence));
        await attempt(() => closeServer(operation));
        await attempt(() => controller?.close());
        if (errors.length)
            throw new AggregateError(errors, 'Reuse control cleanup failed');
    }
    async function cleanup() {
        const errors: unknown[] = [];
        const attempt = async (action: () => unknown | Promise<unknown>) => {
            try {
                await action();
            } catch (error) {
                errors.push(error);
            }
        };
        await attempt(closeControl);
        for (const stream of upstreamStreams) stream.destroy();
        await attempt(async () => {
            await Promise.all(
                [...upstreamSessions].map(
                    (session) =>
                        new Promise<void>((resolve) => {
                            session.once('close', resolve);
                            session.destroy();
                        }),
                ),
            );
        });
        await attempt(() => closeServer(upstream));
        await attempt(() => fs.rm(directory, { recursive: true, force: true }));
        if (errors.length)
            throw new AggregateError(errors, 'Reuse fixture cleanup failed');
    }

    try {
        async function openssl(args: string[]) {
            await exec('openssl', args, {
                cwd: directory,
                timeout: 30000,
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
            '/CN=reuse-ca',
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
                '/CN=reuse-' + name,
                '-keyout',
                name + '.key',
                '-out',
                name + '.csr',
            ]);
            await fs.writeFile(
                join(directory, name + '.ext'),
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
            for (const suffix of ['key', 'csr', 'crt'])
                await fs.chmod(join(directory, name + '.' + suffix), 0o600);
        }
        await fs.chmod(join(directory, 'ca.key'), 0o600);
        await fs.chmod(join(directory, 'ca.crt'), 0o600);
        const ca = await fs.readFile(join(directory, 'ca.crt'));
        const credentials = {
            ca,
            cert: await fs.readFile(join(directory, 'client.crt')),
            key: await fs.readFile(join(directory, 'client.key')),
        };
        const schemas = await import(pathToFileURL(sdk.raw).href);
        const protobuf = await import(
            pathToFileURL(createRequire(sdk.raw).resolve('@bufbuild/protobuf'))
                .href
        );
        const frame = (name: string, value: object) => {
            const data: Uint8Array = protobuf.toBinary(
                schemas[name],
                protobuf.create(schemas[name], value),
            );
            const header = Buffer.alloc(5);
            header.writeUInt32BE(data.length, 1);
            return Buffer.concat([header, data]);
        };
        const stdout = (data: Buffer) =>
            frame('ExecSandboxEventSchema', {
                payload: { case: 'stdout', value: { data } },
            });
        upstream = createSecureServer({
            ca,
            cert: await fs.readFile(join(directory, 'server.crt')),
            key: await fs.readFile(join(directory, 'server.key')),
            requestCert: true,
            rejectUnauthorized: true,
        });
        upstream.on('session', (session) => {
            upstreamSessions.add(session);
            session.on('error', () => undefined);
            if ((session.socket as TLSSocket).authorized)
                authenticatedSessions++;
            session.once('close', () => upstreamSessions.delete(session));
        });
        upstream.on('tlsClientError', () => {
            problems.push('unexpected mTLS handshake rejection');
        });
        upstream.on('stream', (stream, headers) => {
            upstreamCalls++;
            upstreamStreams.add(stream);
            stream.on('error', () => undefined);
            stream.once('close', () => {
                upstreamStreams.delete(stream);
                for (const [index, value] of held)
                    if (value === stream) held.delete(index);
            });
            const chunks: Buffer[] = [];
            let total = 0;
            let responded = false;
            const respond = () => {
                stream.respond(
                    { ':status': 200, 'content-type': 'application/grpc' },
                    { waitForTrailers: true },
                );
                stream.on('wantTrailers', () =>
                    stream.sendTrailers({ 'grpc-status': '0' }),
                );
                responded = true;
            };
            stream.on('data', (chunk: Buffer) => {
                total += chunk.length;
                if (total > 1024 * 1024) {
                    problems.push('oversized helper request');
                    stream.close(2);
                } else {
                    chunks.push(chunk);
                    handle(true);
                }
            });
            stream.on('end', () => handle(false));
            function handle(holdOnly: boolean) {
                if (responded) return;
                try {
                    assert((stream.session!.socket as TLSSocket).authorized);
                    let input = Buffer.concat(chunks);
                    const messages: Buffer[] = [];
                    while (input.length) {
                        if (input.length < 5 && holdOnly) return;
                        assert(input.length >= 5 && input[0] === 0);
                        const size = input.readUInt32BE(1);
                        if (input.length < size + 5 && holdOnly) return;
                        assert(size <= 1024 * 1024 && input.length >= size + 5);
                        messages.push(input.subarray(5, size + 5));
                        input = input.subarray(size + 5);
                    }
                    assert(messages.length);
                    const method = String(headers[':path']).slice(
                        prefix.length,
                    );
                    assert(
                        ['GetSandbox', 'ExecSandboxInteractive'].includes(
                            method,
                        ),
                    );
                    const decoded = sdk.decode(
                        method as 'GetSandbox' | 'ExecSandboxInteractive',
                        messages[0]!,
                    );
                    assert(decoded !== 'stdin');
                    const index = entries.findIndex(
                        (entry) => entry.binding.sandbox === decoded.sandbox,
                    );
                    assert(index >= 0);
                    const entry = entries[index]!;
                    if (method === 'GetSandbox') {
                        if (holdOnly) return;
                        assert.equal(messages.length, 1);
                        respond();
                        stream.end(
                            frame('SandboxResponseSchema', {
                                sandbox: {
                                    metadata: {
                                        id: entry.binding.sandbox,
                                        name: entry.binding.sandbox,
                                        workspace: 'default',
                                    },
                                },
                            }),
                        );
                        return;
                    }
                    const start = protobuf.fromBinary(
                        schemas.ExecSandboxInputSchema,
                        messages[0]!,
                    ).payload;
                    assert.equal(start.case, 'start');
                    assert.equal(start.value.tty, false);
                    assert.equal(start.value.noLoginShell, true);
                    assert.equal(start.value.workdir, workspaceRoot);
                    assert.deepEqual(start.value.command, [
                        '/usr/local/bin/node',
                        '/runtime/fs.mjs',
                    ]);
                    const stdin = Buffer.concat(
                        messages.slice(1).map((bytes) => {
                            const decoded = protobuf.fromBinary(
                                schemas.ExecSandboxInputSchema,
                                bytes,
                            ).payload;
                            assert.equal(decoded.case, 'stdin');
                            return Buffer.from(decoded.value);
                        }),
                    );
                    if (holdOnly && !stdin.length) return;
                    let query: {
                        version: string;
                        method: string;
                        path: string;
                        workspaceRoot: string;
                        defaultMode: string;
                    };
                    try {
                        query = JSON.parse(stdin.toString());
                    } catch (error) {
                        if (holdOnly) return;
                        throw error;
                    }
                    if (holdOnly && query.method !== 'streamText') return;
                    assert.equal(query.version, '0.2.1-rc.4');
                    assert.equal(query.workspaceRoot, workspaceRoot);
                    assert.equal(query.defaultMode, 'workspace-write');
                    let value: unknown;
                    if (query.method === 'resolve') {
                        assert(
                            [
                                workspaceRoot,
                                workspaceRoot + '/marker',
                                workspaceRoot + '/hold',
                            ].includes(query.path),
                        );
                        value = { targetKey: query.path };
                    } else if (query.method === 'stat') {
                        assert.equal(query.path, workspaceRoot);
                        value = { type: 'directory' };
                    } else if (query.method === 'readText') {
                        assert.equal(query.path, workspaceRoot + '/marker');
                        value = entry.prompt;
                    } else {
                        assert.equal(query.method, 'streamText');
                        assert.equal(query.path, workspaceRoot + '/hold');
                        respond();
                        held.set(index, stream);
                        stream.write(
                            stdout(
                                Buffer.from(
                                    JSON.stringify({
                                        version: '0.2.1-rc.4',
                                        value: 'held',
                                    }) + '\n',
                                ),
                            ),
                        );
                        return;
                    }
                    respond();
                    stream.end(
                        Buffer.concat([
                            stdout(
                                Buffer.from(
                                    JSON.stringify({
                                        version: '0.2.1-rc.4',
                                        value,
                                    }),
                                ),
                            ),
                            frame('ExecSandboxEventSchema', {
                                payload: {
                                    case: 'exit',
                                    value: { exitCode: 0 },
                                },
                            }),
                        ]),
                    );
                } catch {
                    problems.push('upstream protocol assertion failed');
                    stream.close(2);
                }
            }
        });
        const upstreamPort = await listen(upstream);
        async function openControl(initial: boolean) {
            controller = new SingleHostExecution(paths, {
                async stop() {
                    /* No independent sandbox exit witness exists. */
                },
                async stopped() {
                    return false;
                },
                async start() {
                    throw new Error('Unconfirmed sandbox cannot restart');
                },
                async running(session) {
                    return {
                        sandbox: session.sandbox,
                        volume: session.volume,
                        running: true,
                        installed: true,
                    };
                },
            });
            if (initial)
                for (const { binding } of entries)
                    controller.bind(binding, {
                        sandbox: binding.sandbox,
                        volume: binding.volume,
                        running: true,
                        installed: true,
                    });
            persistence = controller.persistenceIngress();
            operation = controller.operationIngress();
            for (const [name, server] of [
                ['persistence', persistence],
                ['operation', operation],
            ] as const) {
                server.on('request', (request, response) => {
                    const path = request.url?.split('?')[0];
                    const observed = {
                        interface: name,
                        tokenSha256: sha256(
                            String(request.headers.authorization ?? '').replace(
                                /^Bearer /,
                                '',
                            ),
                        ),
                        path:
                            path === '/rpc' || path === '/operations'
                                ? path
                                : 'other',
                        at: performance.now(),
                        status: null as number | null,
                        finishedAt: null as number | null,
                    };
                    controlRequests.push(observed);
                    response.once('finish', () => {
                        observed.status = response.statusCode;
                        observed.finishedAt = performance.now();
                    });
                });
            }
            ingress = controller.sdkIngress({
                upstream: new URL('https://127.0.0.1:' + upstreamPort),
                credentials,
                workspace: 'default',
                decode: sdk.decode,
                decodeExecEvent: sdk.decodeExecEvent,
            });
            observed = observeSdk(ingress, sdk);
            addresses = {
                gateway: 'http://127.0.0.1:' + (await listen(ingress)),
                persistenceUrl:
                    'http://127.0.0.1:' + (await listen(persistence)),
                operationUrl: 'http://127.0.0.1:' + (await listen(operation)),
            };
        }
        await openControl(true);

        function request(index: number): WorkerRequest {
            assert(
                Number.isInteger(index) && index >= 0 && index < entries.length,
            );
            const entry = entries[index]!;
            if (!grants.has(index))
                grants.set(
                    index,
                    controller!.admit(
                        entry.binding.session,
                        1,
                        randomUUID(),
                        120000,
                    ),
                );
            return {
                mode: 'execute',
                binding: { ...entry.binding },
                grant: { ...grants.get(index)! },
                prompt: entry.prompt,
                ...addresses,
            };
        }
        async function quiescent() {
            const deadline = performance.now() + 5000;
            while (
                observed!.activeConnections ||
                observed!.activeStreams ||
                upstreamSessions.size ||
                upstreamStreams.size
            ) {
                if (performance.now() >= deadline)
                    throw new Error('Observed SDK resources did not close');
                await delay(10);
            }
            assert.equal(observed!.decodeErrors, 0);
            assert.deepEqual(problems, []);
        }
        return {
            directory,
            paths,
            request,
            quiescent,
            revocations,
            get controlRequests() {
                return controlRequests;
            },
            get wire() {
                return observed!.wire;
            },
            get connections() {
                return observed!.connections;
            },
            get authenticatedSessions() {
                return authenticatedSessions;
            },
            get upstreamCalls() {
                return upstreamCalls;
            },
            get activeHeld() {
                return held.size;
            },
            snapshot() {
                return readReuseSnapshot(
                    paths,
                    [...grants.keys()].map(request),
                    {
                        sdkConnections: observed!.activeConnections,
                        sdkStreams: observed!.activeStreams,
                        upstreamCalls,
                        workerPids: readWorkerProcesses(process.pid).map(
                            (worker) => worker.pid,
                        ),
                    },
                );
            },
            async waitHeld(index: number) {
                const deadline = performance.now() + 5000;
                while (!held.has(index)) {
                    if (performance.now() >= deadline)
                        throw new Error(
                            'Expected real held stream was not observed',
                        );
                    await delay(10);
                }
            },
            async takeover(index: number) {
                const current = request(index);
                await assert.rejects(
                    controller!.takeover(
                        current.binding.session,
                        current.grant.generation,
                    ),
                    /old execution unconfirmed/,
                );
                const state = controller!.inspect(current.binding.session);
                assert.equal(state.state, 'UNKNOWN');
                assert.equal(state.hasCapability, false);
                revocations.push({
                    index,
                    state: state.state,
                    generation: state.generation,
                    stopConfirmed: false,
                    at: performance.now(),
                });
            },
            async reopen() {
                assert.equal(readWorkerProcesses(process.pid).length, 0);
                await quiescent();
                await closeControl();
                await openControl(false);
            },
            close() {
                return (closing ??= cleanup());
            },
        };
    } catch (error) {
        try {
            await cleanup();
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                'Reuse fixture setup and cleanup failed',
                { cause: cleanupError },
            );
        }
        throw error;
    }
}
