import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
    connect,
    constants,
    createSecureServer,
    type OutgoingHttpHeaders,
    type ServerHttp2Stream,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { schemaExecEventDecoder } from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/command-host.ts';
import { Authority } from '@/apps/orchestrator/orchestrator-execution-host/src/openshell/authority.ts';
import {
    createSdkIngress,
    type SdkIngressOptions,
} from '@/apps/orchestrator/orchestrator-execution-host/src/openshell/sdk-ingress.ts';
import { SingleHostExecution } from '@/apps/orchestrator/orchestrator-execution-host/src/openshell/single-host.ts';
import { WorkerGate } from '@/apps/orchestrator/orchestrator-execution-host/src/openshell/worker-gate.ts';

const binding = {
    tenant: 'tenant',
    project: 'project',
    session: 'session',
    sandbox: 'sandbox',
    volume: 'volume',
};
const running = { ...binding, running: true, installed: true };
const rpcPrefix = '/openshell.v1.OpenShell/';

function frame(bytes: Buffer, compression = 0) {
    const header = Buffer.alloc(5);
    header[0] = compression;
    header.writeUInt32BE(bytes.length, 1);
    return Buffer.concat([header, bytes]);
}

const output = Buffer.from([0x0a, 3, 0x0a, 1, 65]);
const exitZero = Buffer.from([0x1a, 0]);
const exitError = Buffer.from([0x1a, 2, 8, 17]);
const input = frame(Buffer.from([1]));
const stdin = frame(Buffer.from([2]));

type Response = {
    headers?: OutgoingHttpHeaders;
    trailers?: OutgoingHttpHeaders | null;
    chunks?: Buffer[];
    reset?: true;
};

function send(stream: ServerHttp2Stream, response: Response) {
    const trailers =
        response.trailers === undefined
            ? { 'grpc-status': '0' }
            : response.trailers;
    stream.respond(
        {
            ':status': 200,
            'content-type': 'application/grpc',
            ...response.headers,
        },
        { waitForTrailers: trailers !== null },
    );
    if (trailers)
        stream.once('wantTrailers', () => stream.sendTrailers(trailers));
    for (const chunk of response.chunks ?? [frame(exitZero)])
        stream.write(chunk);
    if (response.reset) stream.close(constants.NGHTTP2_CANCEL);
    else stream.end();
}

async function codecFixture(dir: string) {
    const protobuf = join(dir, 'node_modules', '@bufbuild', 'protobuf');
    await mkdir(protobuf, { recursive: true });
    // The fixed SDK's ExecSandboxEvent wire tags. Model protobuf's last-oneof-wins
    // behavior so the loader must reject duplicates on its round trip.
    await writeFile(
        join(protobuf, 'index.js'),
        `exports.fromBinary = (_schema, bytes) => {
            let payload = {};
            const input = Array.from(bytes);
            while (input.length) {
                const tag = input.shift();
                const size = input.shift();
                if (size === undefined || size > input.length) throw new Error('invalid frame');
                const part = input.splice(0, size);
                if (tag === 10 || tag === 18) payload = { case: tag === 10 ? 'stdout' : 'stderr', value: part };
                if (tag === 26) payload = { case: 'exit', value: { exitCode: part[1] ?? 0 } };
            }
            return { payload };
        };
        exports.toBinary = (_schema, message) => {
            const { case: kind, value } = message.payload;
            if (kind === 'exit') return Buffer.from(value.exitCode ? [26, 2, 8, value.exitCode] : [26, 0]);
            if (kind === 'stdout' || kind === 'stderr') return Buffer.from([kind === 'stdout' ? 10 : 18, value.length, ...value]);
            return Buffer.alloc(0);
        };`,
    );
    const raw = join(dir, 'raw.mjs');
    await writeFile(raw, 'export const ExecSandboxEventSchema = {};');
    return schemaExecEventDecoder(raw);
}

test('SDK ingress records only authenticated, complete Exec outcomes', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'bento-sdk-evidence-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const keyPath = join(root, 'key.pem');
    const certPath = join(root, 'cert.pem');
    execFileSync(
        'openssl',
        [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-days',
            '1',
            '-subj',
            '/CN=127.0.0.1',
            '-addext',
            'subjectAltName=IP:127.0.0.1',
            '-keyout',
            keyPath,
            '-out',
            certPath,
        ],
        { stdio: 'ignore' },
    );
    const [cert, key, decodeExecEvent] = await Promise.all([
        readFile(certPath),
        readFile(keyPath),
        codecFixture(root),
    ]);
    const credentials = { ca: cert, cert, key };
    assert.deepEqual(decodeExecEvent(exitZero), { kind: 'exit', code: 0 });
    assert.deepEqual(decodeExecEvent(exitError), { kind: 'exit', code: 17 });
    assert.deepEqual(decodeExecEvent(output), { kind: 'output' });
    for (const bytes of [
        Buffer.alloc(0),
        Buffer.from([8, 0]),
        Buffer.from([0x1a]),
        Buffer.from([0x1a, 2, 8, 0]),
        Buffer.concat([exitZero, exitError]),
    ])
        assert.throws(() => decodeExecEvent(bytes));

    const cases: {
        name: string;
        response?: Response;
        method?: string;
        outcome?: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
        untracked?: boolean;
        authorization?: 'stale' | 'wrong' | 'expire-before-end';
        invalidTarget?: 'sandbox' | 'workspace';
        reserveFailure?: boolean;
        abortClient?: boolean;
        untrustedGateway?: boolean;
    }[] = [
        { name: 'Exec exit 0', outcome: 'SUCCEEDED' },
        {
            name: 'interactive split output and nonzero exit',
            method: 'ExecSandboxInteractive',
            outcome: 'FAILED',
            response: {
                headers: {
                    'content-type': 'application/grpc+proto',
                    'grpc-encoding': 'identity',
                },
                chunks: [
                    frame(output),
                    frame(exitError).subarray(0, 3),
                    frame(exitError).subarray(3),
                ],
            },
        },
        { name: 'read-only GetSandbox', method: 'GetSandbox' },
        { name: 'legacy host', untracked: true },
        {
            name: 'wrong media type',
            response: { headers: { 'content-type': 'text/plain' } },
        },
        {
            name: 'invalid grpc media suffix',
            response: {
                headers: { 'content-type': 'application/grpc;foo=bar' },
            },
        },
        { name: 'HTTP error', response: { headers: { ':status': 502 } } },
        {
            name: 'compressed gRPC',
            response: { headers: { 'grpc-encoding': 'gzip' } },
        },
        {
            name: 'compressed HTTP',
            response: { headers: { 'content-encoding': 'gzip' } },
        },
        {
            name: 'status in headers',
            response: { headers: { 'grpc-status': '0' } },
        },
        {
            name: 'trailers-only status',
            response: {
                headers: { 'grpc-status': '0' },
                chunks: [],
                trailers: null,
            },
        },
        { name: 'missing trailers', response: { trailers: null } },
        {
            name: 'duplicate trailers status',
            response: { trailers: { 'grpc-status': ['0', '0'] } },
        },
        {
            name: 'combined trailers status',
            response: { trailers: { 'grpc-status': '0, 0' } },
        },
        {
            name: 'nonzero trailers status',
            response: { trailers: { 'grpc-status': '13' } },
        },
        {
            name: 'plain bytes',
            response: { chunks: [Buffer.from('plain body')] },
        },
        { name: 'missing exit', response: { chunks: [frame(output)] } },
        {
            name: 'default empty oneof',
            response: { chunks: [frame(Buffer.alloc(0))] },
        },
        {
            name: 'duplicate exit in protobuf',
            response: { chunks: [frame(Buffer.concat([exitZero, exitError]))] },
        },
        {
            name: 'duplicate exit frame',
            response: { chunks: [frame(exitZero), frame(exitZero)] },
        },
        {
            name: 'output after exit',
            response: { chunks: [frame(exitZero), frame(output)] },
        },
        {
            name: 'truncated exit',
            response: { chunks: [frame(exitZero).subarray(0, 6)] },
        },
        {
            name: 'oversized frame',
            response: { chunks: [Buffer.from([0, 0, 16, 0, 1])] },
        },
        {
            name: 'compressed frame',
            response: { chunks: [frame(exitZero, 1)] },
        },
        {
            name: 'upstream reset after exit',
            response: { reset: true, trailers: null },
        },
        { name: 'downstream abort', abortClient: true },
        { name: 'gateway TLS authentication failure', untrustedGateway: true },
        { name: 'untrusted grant', authorization: 'wrong' },
        { name: 'stale grant', authorization: 'stale' },
        {
            name: 'expired grant before poll or orderly end',
            authorization: 'expire-before-end',
        },
        { name: 'wrong sandbox', invalidTarget: 'sandbox' },
        { name: 'wrong workspace', invalidTarget: 'workspace' },
        { name: 'reservation failure', reserveFailure: true },
    ];
    for (const [index, scenario] of cases.entries()) {
        await t.test(scenario.name, async (t) => {
            const directory = join(root, String(index));
            await mkdir(directory);
            const path = join(directory, 'authority.sqlite');
            const db = new DatabaseSync(path);
            const controller = new SingleHostExecution(
                { authority: path, history: join(directory, 'history.sqlite') },
                {
                    async stop() {},
                    async stopped() {
                        return true;
                    },
                    async start() {},
                    async running() {
                        return running;
                    },
                },
            );
            controller.bind(binding, running);
            const grant = controller.admit(binding.session, 1, 'run', 60_000);
            const authority = new Authority(path);
            let controllerClosed = false;
            const reader = () =>
                db
                    .prepare(
                        'SELECT session,generation,id,digest,state FROM operations',
                    )
                    .all();
            const denied =
                scenario.authorization === 'wrong' ||
                scenario.authorization === 'stale' ||
                !!scenario.invalidTarget ||
                !!scenario.reserveFailure;
            const tracked =
                !scenario.untracked && scenario.method !== 'GetSandbox';
            let upstreamCalls = 0;
            let terminalCalls = 0;
            let authorizationDenied = 0;
            let failure: unknown;
            let abortClient: () => void = () => {};
            const gateway = createSecureServer({
                ...credentials,
                requestCert: true,
                rejectUnauthorized: true,
            });
            gateway.on('stream', (stream) => {
                stream.on('error', () => {});
                upstreamCalls++;
                stream.once('data', () => {
                    try {
                        const rows = reader();
                        assert.equal(rows.length, tracked ? 1 : 0);
                        if (tracked) {
                            assert.equal(rows[0]?.state, 'UNKNOWN');
                            assert.equal(rows[0]?.session, grant.session);
                            assert.equal(rows[0]?.generation, grant.generation);
                            assert.match(String(rows[0]?.id), /^sdk:/);
                        }
                        if (scenario.authorization === 'expire-before-end')
                            authority.beginDrain(
                                grant.session,
                                grant.generation,
                            );
                        if (scenario.abortClient) abortClient();
                        else send(stream, scenario.response ?? {});
                    } catch (error) {
                        failure = error;
                        stream.close(constants.NGHTTP2_CANCEL);
                    }
                });
                stream.resume();
            });
            gateway.listen(0, '127.0.0.1');
            await once(gateway, 'listening');
            const options: SdkIngressOptions = {
                upstream: new URL(
                    'https://127.0.0.1:' +
                        (gateway.address() as AddressInfo).port,
                ),
                credentials: scenario.untrustedGateway
                    ? { ...credentials, ca: Buffer.alloc(0) }
                    : credentials,
                workspace: 'workspace',
                decode: (_method, bytes) =>
                    bytes[0] === 2
                        ? 'stdin'
                        : {
                              sandbox:
                                  scenario.invalidTarget === 'sandbox'
                                      ? 'another'
                                      : binding.sandbox,
                              workspace:
                                  scenario.invalidTarget === 'workspace'
                                      ? 'another'
                                      : 'workspace',
                          },
                ...(scenario.untracked ? {} : { decodeExecEvent }),
            };
            // Its poll cannot run while the forced stale-grant race is observed.
            const gate = new WorkerGate(authority, 300_000);
            const isolated =
                scenario.reserveFailure ||
                scenario.authorization === 'expire-before-end';
            const ingress = isolated
                ? createSdkIngress(
                      gate,
                      () => grant,
                      options,
                      (trusted, payload) => {
                          assert.equal(trusted, grant);
                          if (scenario.reserveFailure)
                              throw new Error('Reservation unavailable');
                          const id = 'sdk:race';
                          assert(
                              authority.reserveOperation(
                                  trusted.token,
                                  id,
                                  payload.toString('base64'),
                              ),
                          );
                          return (outcome) => {
                              terminalCalls++;
                              authority.observeOperation(
                                  trusted.session,
                                  trusted.generation,
                                  id,
                                  outcome,
                              );
                          };
                      },
                  )
                : controller.sdkIngress(options);
            if (scenario.authorization === 'expire-before-end') {
                const require = gate.require.bind(gate);
                gate.require = (trusted) => {
                    try {
                        return require(trusted);
                    } catch (error) {
                        authorizationDenied++;
                        throw error;
                    }
                };
            }
            if (scenario.authorization === 'stale')
                authority.beginDrain(grant.session, 1);
            ingress.listen(0, '127.0.0.1');
            await once(ingress, 'listening');
            const client = connect(
                'http://127.0.0.1:' + (ingress.address() as AddressInfo).port,
            );
            t.after(async () => {
                client.destroy();
                gate.close();
                await Promise.all([
                    new Promise<void>((resolve) =>
                        ingress.close(() => resolve()),
                    ),
                    new Promise<void>((resolve) =>
                        gateway.close(() => resolve()),
                    ),
                ]);
                if (!controllerClosed) controller.close();
                authority.close();
                db.close();
            });
            const method = scenario.method ?? 'ExecSandbox';
            const call = client.request({
                ':method': 'POST',
                ':path': rpcPrefix + method,
                'content-type': 'application/grpc',
                authorization:
                    'Bearer ' +
                    (scenario.authorization === 'wrong'
                        ? 'wrong'
                        : grant.token),
            });
            abortClient = () => call.close(constants.NGHTTP2_CANCEL);
            call.setTimeout(3000, () =>
                call.destroy(new Error('SDK test call deadline')),
            );
            call.on('error', (error) => {
                failure ??= scenario.response?.reset ? undefined : error;
            });
            call.resume();
            const closed = new Promise<void>((resolve) =>
                call.once('close', resolve),
            );
            call.end(
                method === 'ExecSandboxInteractive'
                    ? Buffer.concat([input, stdin])
                    : input,
            );
            await closed;
            assert.equal(failure, undefined);
            assert.equal(
                upstreamCalls,
                denied || scenario.untrustedGateway ? 0 : 1,
            );
            assert.deepEqual(
                reader().map((row) => row.state),
                denied || !tracked ? [] : [scenario.outcome ?? 'UNKNOWN'],
            );
            if (scenario.authorization === 'expire-before-end') {
                assert.equal(terminalCalls, 0);
                assert.equal(authorizationDenied, 1);
            }
            if (scenario.response?.reset) {
                // Reopening the durable control ledger must not reinterpret a reset.
                controller.close();
                controllerClosed = true;
                const reopened = new Authority(path);
                try {
                    assert(
                        reopened.hasUnknownOperations(
                            grant.session,
                            grant.generation,
                        ),
                    );
                } finally {
                    reopened.close();
                }
            }
        });
    }
});
