import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createServer as h2Server, type ServerHttp2Session } from 'node:http2';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { SingleHostExecution } from '@/apps/orchestrator/src/openshell/single-host.ts';
import { prepareReuseSdk } from '@/apps/orchestrator/acceptance/worker-reuse/sdk.ts';
import { remoteSessionPersistence } from './remote-session.ts';
import { runDshWorker } from './dsh-worker.ts';
import type { WorkerRequest } from './protocol.ts';
import bootstrap, { type BaseBootstrapConfig } from './base-bootstrap.ts';

const opts = { timeout: 120_000, concurrency: false };
const effect: Parameters<typeof bootstrap>[1] = async (_id, _input, dispatch) =>
    dispatch();
let sdk: Awaited<ReturnType<typeof prepareReuseSdk>>;
let frame: (name: string, value: object) => Buffer;
let getName: (bytes: Buffer) => string;
let execInput: (bytes: Buffer) => { payload: { case: string; value: unknown } };
before(
    async () => {
        sdk = await prepareReuseSdk();
        const schemas = await import(pathToFileURL(sdk.raw).href);
        const protobuf = await import(
            pathToFileURL(createRequire(sdk.raw).resolve('@bufbuild/protobuf'))
                .href
        );
        frame = (name, value) => {
            const bytes = protobuf.toBinary(
                schemas[name],
                protobuf.create(schemas[name], value),
            );
            const result = Buffer.alloc(bytes.length + 5);
            result.writeUInt32BE(bytes.length, 1);
            result.set(bytes, 5);
            return result;
        };
        getName = (bytes) =>
            protobuf.fromBinary(schemas.GetSandboxRequestSchema, bytes).name;
        execInput = (bytes) =>
            protobuf.fromBinary(schemas.ExecSandboxInputSchema, bytes);
    },
    { timeout: 600_000 },
);
after(async () => sdk?.dispose());
const savedConfig = process.env.BENTO_DSH_RUNTIME_CONFIG;
after(() => {
    if (savedConfig === undefined) delete process.env.BENTO_DSH_RUNTIME_CONFIG;
    else process.env.BENTO_DSH_RUNTIME_CONFIG = savedConfig;
});

async function listen(server: Server | ReturnType<typeof h2Server>) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address === 'object');
    return 'http://127.0.0.1:' + address.port;
}
async function close(server: Server | ReturnType<typeof h2Server>) {
    const closing = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
    if ('closeAllConnections' in server) server.closeAllConnections();
    await closing;
}

async function fixture(
    mode: 'normal' | 'singleton' | 'dispose-error' | 'extra-field' = 'normal',
) {
    const directory = await fs.mkdtemp(join(tmpdir(), 'bento-base-unit-'));
    const log = join(directory, 'model.ndjson');
    const module = join(directory, 'model.mjs');
    await fs.writeFile(
        module,
        `
        import { LlmAdapter } from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-llm'))};
        import { appendFileSync } from 'node:fs';
        const record = (phase, keys=[]) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({phase,keys})+'\\n');
        class Adapter extends LlmAdapter {
            async *stream(options) {
                options.signal?.throwIfAborted(); record('stream');
                yield {type:'block-start',index:0,blockType:'text'};
                yield {type:'text-delta',index:0,text:'official-base-unit'};
                yield {type:'block-end',index:0,block:{type:'text',text:'official-base-unit'}};
                yield {type:'finish',reason:{kind:'stop'}};
            }
        }
        const shared = new Adapter();
        export default async (options) => {
            record('factory',Object.keys(options).sort());
            const result = {
                adapter: ${JSON.stringify(mode)}==='singleton' ? shared : new Adapter(),
                async dispose() { record('dispose'); if(${JSON.stringify(mode)}==='dispose-error') throw new Error('fixture model disposal failed'); }
            };
            if(${JSON.stringify(mode)}==='extra-field') result.ctx='not-allowed';
            return result;
        };
    `,
        { mode: 0o600 },
    );
    const binding = {
        tenant: 'unit-tenant',
        project: randomUUID(),
        session: randomUUID(),
        sandbox: 'unit-' + randomUUID(),
        volume: randomUUID(),
    };
    let running = true;
    const observation = () => ({
        sandbox: binding.sandbox,
        volume: binding.volume,
        running,
        installed: true,
    });
    const history = join(directory, 'history.sqlite');
    const controller = new SingleHostExecution(
        { authority: join(directory, 'authority.sqlite'), history },
        {
            async stop() {
                running = false;
            },
            async stopped() {
                return !running;
            },
            async start() {
                running = true;
            },
            async running() {
                return observation();
            },
        },
    );
    controller.bind(binding, observation());
    const grant = controller.admit(binding.session, 1, randomUUID(), 120000);
    const ingress = controller.persistenceIngress();
    const rpc: string[] = [];
    ingress.on('request', (request) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            rpc.push(JSON.parse(Buffer.concat(chunks).toString()).method);
        });
    });
    const persistenceUrl = await listen(ingress);
    const gateway = h2Server();
    const peers = new Set<ServerHttp2Session>();
    const sdkCalls: string[] = [];
    const helperQueries: object[] = [];
    gateway.on('session', (peer) => {
        peers.add(peer);
        peer.on('error', () => undefined);
        peer.once('close', () => peers.delete(peer));
    });
    // Deterministic helper protocol for cwd lookup; T4 covers production ingress.
    gateway.on('stream', (stream, headers) => {
        sdkCalls.push(String(headers[':path']));
        stream.on('error', () => undefined);
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
            try {
                assert.equal(headers.authorization, 'Bearer ' + grant.token);
                let input = Buffer.concat(chunks);
                const messages: Buffer[] = [];
                while (input.length) {
                    assert(input.length >= 5 && input[0] === 0);
                    const size = input.readUInt32BE(1);
                    assert(size <= 1024 * 1024 && input.length >= size + 5);
                    messages.push(input.subarray(5, size + 5));
                    input = input.subarray(size + 5);
                }
                let output: Buffer;
                if (headers[':path'] === '/openshell.v1.OpenShell/GetSandbox') {
                    assert.equal(messages.length, 1);
                    assert.equal(getName(messages[0]!), binding.sandbox);
                    output = frame('SandboxResponseSchema', {
                        sandbox: {
                            metadata: {
                                id: binding.sandbox,
                                name: binding.sandbox,
                                workspace: 'default',
                            },
                        },
                    });
                } else {
                    assert.equal(
                        headers[':path'],
                        '/openshell.v1.OpenShell/ExecSandboxInteractive',
                    );
                    const decoded = messages.map(execInput);
                    const start = decoded[0]!.payload.value as {
                        sandbox: string;
                        tty: boolean;
                        command: string[];
                    };
                    assert.equal(decoded[0]!.payload.case, 'start');
                    assert.equal(start.sandbox, binding.sandbox);
                    assert.equal(start.tty, false);
                    assert.deepEqual(start.command, [
                        '/usr/local/bin/node',
                        '/runtime/fs.mjs',
                    ]);
                    const stdin = Buffer.concat(
                        decoded.slice(1).map((item) => {
                            assert.equal(item.payload.case, 'stdin');
                            return Buffer.from(
                                item.payload.value as Uint8Array,
                            );
                        }),
                    );
                    const query = JSON.parse(stdin.toString()) as {
                        version: string;
                        method: string;
                        path: string;
                    };
                    helperQueries.push({
                        method: query.method,
                        path: query.path,
                    });
                    assert.equal(query.version, '0.2.1-rc.4');
                    assert(['resolve', 'stat'].includes(query.method));
                    assert.equal(query.path, '/sandbox/project');
                    const result = Buffer.from(
                        JSON.stringify({
                            version: '0.2.1-rc.4',
                            value:
                                query.method === 'stat'
                                    ? { type: 'directory' }
                                    : { targetKey: '/sandbox/project' },
                        }),
                    );
                    output = Buffer.concat([
                        frame('ExecSandboxEventSchema', {
                            payload: {
                                case: 'stdout',
                                value: { data: result },
                            },
                        }),
                        frame('ExecSandboxEventSchema', {
                            payload: { case: 'exit', value: { exitCode: 0 } },
                        }),
                    ]);
                }
                stream.respond(
                    { ':status': 200, 'content-type': 'application/grpc' },
                    { waitForTrailers: true },
                );
                stream.on('wantTrailers', () =>
                    stream.sendTrailers({ 'grpc-status': '0' }),
                );
                stream.end(output);
            } catch {
                stream.close(2);
            }
        });
    });
    const gatewayUrl = await listen(gateway);
    const config: BaseBootstrapConfig = {
        schema: 1,
        sdkModule: join(dirname(sdk.raw), 'index.js'),
        modelAdapterModule: module,
        provider: 'base-unit',
        model: 'fixture',
        workspaceRoot: '/sandbox/project',
        helper: '/runtime/confine.mjs',
        fileSystemHelper: '/runtime/fs.mjs',
        node: '/usr/local/bin/node',
    };
    const configPath = join(directory, 'config.json');
    await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    process.env.BENTO_DSH_RUNTIME_CONFIG = configPath;
    const request: WorkerRequest = {
        mode: 'execute',
        binding,
        grant,
        gateway: gatewayUrl,
        persistenceUrl,
        operationUrl: persistenceUrl,
        prompt: 'unit prompt',
    };
    return {
        request,
        config,
        configPath,
        controller,
        rpc,
        peers,
        sdkCalls,
        helperQueries,
        async modelTrace() {
            try {
                return (await fs.readFile(log, 'utf8'))
                    .trim()
                    .split('\n')
                    .filter(Boolean)
                    .map(
                        (line) =>
                            JSON.parse(line) as {
                                phase: string;
                                keys: string[];
                            },
                    );
            } catch {
                return [];
            }
        },
        snapshot() {
            const db = new DatabaseSync(history, { readOnly: true });
            try {
                return db.prepare('SELECT id,handle FROM sessions').all();
            } finally {
                db.close();
            }
        },
        async assertSdkClosed() {
            // Allow the peer-side close event to follow the client-side close.
            await Promise.all([...peers].map((peer) => once(peer, 'close')));
            assert.equal(peers.size, 0);
        },
        async close() {
            for (const peer of peers) peer.destroy();
            await close(gateway);
            await close(ingress);
            controller.close();
            await fs.rm(directory, { recursive: true, force: true });
        },
    };
}

async function initialized(request: WorkerRequest) {
    const runtime = await bootstrap(request, async (_id, _input, dispatch) =>
        dispatch(),
    );
    await runtime.ctx.plugin(remoteSessionPersistence, {
        url: request.persistenceUrl,
        token: request.grant.token,
    });
    await runtime.initialize?.();
    return runtime;
}

test(
    'configuration and execution identity reject before creating resources',
    opts,
    async (t) => {
        const f = await fixture();
        t.after(() => f.close());
        for (const change of [
            { schema: 2 },
            { unknown: true },
            { helper: 'relative' },
            { model: '' },
            { sdkModule: 'relative' },
        ]) {
            await fs.writeFile(
                f.configPath,
                JSON.stringify({ ...f.config, ...change }),
            );
            await assert.rejects(bootstrap(f.request, effect), /configuration/);
        }
        await fs.writeFile(f.configPath, JSON.stringify(f.config));
        await assert.rejects(
            bootstrap(
                {
                    ...f.request,
                    grant: { ...f.request.grant, session: randomUUID() },
                },
                effect,
            ),
            /identity/,
        );
        assert.deepEqual(await f.modelTrace(), []);
        assert.equal(f.peers.size, 0);
    },
);

test(
    'official handle disposal finishes before fiber cleanup and closes history once',
    opts,
    async (t) => {
        const f = await fixture();
        t.after(() => f.close());
        const runtime = await initialized(f.request);
        t.after(() => runtime.dispose());
        const store = runtime.ctx.sessions;
        const { agent } = await runtime.agents.create({
            sessionId: f.request.grant.session as Parameters<
                typeof store.get
            >[0],
            meta: { cwd: runtime.workspaceRoot },
            agentOptions: runtime.agentOptions,
        });
        assert.equal(store.list().length, 1);
        await runtime.flush(agent);
        const first = runtime.dispose();
        assert.equal(runtime.dispose(), first);
        await first;
        assert.equal(store.list().length, 0);
        assert.equal(f.rpc.filter((method) => method === 'close').length, 1);
        assert.equal(f.snapshot()[0]?.handle, null);
        await f.assertSdkClosed();
        const trace = await f.modelTrace();
        assert.deepEqual(trace.find((row) => row.phase === 'factory')?.keys, [
            'model',
            'provider',
        ]);
        assert.equal(trace.filter((row) => row.phase === 'dispose').length, 1);
    },
);

test(
    'revoked official handle still releases its session and does not close twice',
    opts,
    async (t) => {
        const f = await fixture();
        t.after(() => f.close());
        const runtime = await initialized(f.request);
        t.after(async () => {
            await Promise.resolve(runtime.dispose()).catch(() => undefined);
        });
        const store = runtime.ctx.sessions;
        const { agent } = await runtime.agents.create({
            sessionId: f.request.grant.session as Parameters<
                typeof store.get
            >[0],
            meta: { cwd: runtime.workspaceRoot },
            agentOptions: runtime.agentOptions,
        });
        await runtime.flush(agent);
        await f.controller.takeover(f.request.grant.session, 1);
        await assert.rejects(Promise.resolve(runtime.dispose()));
        assert.equal(store.list().length, 0);
        assert.equal(f.rpc.filter((method) => method === 'close').length, 1);
        await f.assertSdkClosed();
        assert.equal(
            (await f.modelTrace()).filter((row) => row.phase === 'dispose')
                .length,
            1,
        );
    },
);

test(
    'empty recovery creates neither SDK transport nor model adapter',
    opts,
    async (t) => {
        const f = await fixture();
        t.after(() => f.close());
        const request: WorkerRequest = { ...f.request, mode: 'recover' };
        delete request.gateway;
        assert.equal(
            await runDshWorker({ ...request, mode: 'recover' }, bootstrap),
            'recovered',
        );
        assert.equal(f.peers.size, 0);
        assert.deepEqual(await f.modelTrace(), []);
    },
);

test(
    'Task without projection fails closed before submitting a model prompt',
    opts,
    async (t) => {
        const f = await fixture();
        t.after(() => f.close());
        assert.equal(
            await runDshWorker(
                {
                    ...f.request,
                    publicEventsUrl: f.request.operationUrl + '/task-events',
                },
                bootstrap,
            ),
            'review',
        );
        const trace = await f.modelTrace();
        assert.equal(trace.filter((row) => row.phase === 'stream').length, 0);
        assert.equal(trace.filter((row) => row.phase === 'dispose').length, 1);
        await f.assertSdkClosed();
    },
);

test(
    'production base completes a real official AgentLoop model turn',
    opts,
    async (t) => {
        const f = await fixture();
        t.after(() => f.close());
        const result = await runDshWorker(f.request, bootstrap);
        if (result !== 'completed')
            console.log(
                JSON.stringify({
                    phase: 'base-unit-diagnosis',
                    sdkCalls: f.sdkCalls,
                    helperQueries: f.helperQueries,
                    modelTrace: await f.modelTrace(),
                }),
            );
        assert.equal(result, 'completed');
        const trace = await f.modelTrace();
        assert.equal(trace.filter((row) => row.phase === 'stream').length, 1);
        assert.equal(trace.filter((row) => row.phase === 'dispose').length, 1);
        assert.equal(f.snapshot()[0]?.handle, null);
        assert.equal(f.rpc.filter((method) => method === 'close').length, 1);
        await f.assertSdkClosed();
    },
);

test(
    'adapter singleton and extra factory capabilities are rejected with cleanup',
    opts,
    async (t) => {
        const f = await fixture('singleton');
        t.after(() => f.close());
        const first = await bootstrap(f.request, effect);
        t.after(() => first.dispose());
        await first.dispose();
        await assert.rejects(
            bootstrap(f.request, effect),
            /fresh model adapter/,
        );
        await f.assertSdkClosed();
        assert.equal(
            (await f.modelTrace()).filter((row) => row.phase === 'dispose')
                .length,
            2,
        );
        const other = await fixture('extra-field');
        t.after(() => other.close());
        await assert.rejects(
            bootstrap(other.request, effect),
            /fresh model adapter/,
        );
        await other.assertSdkClosed();
        assert.equal(
            (await other.modelTrace()).filter((row) => row.phase === 'dispose')
                .length,
            1,
        );
    },
);

test(
    'partial initialization failure still closes SDK and model resources',
    opts,
    async (t) => {
        const f = await fixture();
        t.after(() => f.close());
        const runtime = await bootstrap(f.request, effect);
        t.after(() => runtime.dispose());
        const plugin = runtime.ctx.registry.plugin.bind(runtime.ctx.registry);
        let calls = 0;
        t.mock.method(
            runtime.ctx.registry,
            'plugin',
            (...args: Parameters<typeof runtime.ctx.registry.plugin>) => {
                if (++calls === 3)
                    throw new Error('fixture partial initialize');
                return plugin(...args);
            },
        );
        await assert.rejects(runtime.initialize!(), /partial initialize/);
        t.mock.restoreAll();
        await runtime.dispose();
        await f.assertSdkClosed();
        assert.equal(
            (await f.modelTrace()).filter((row) => row.phase === 'dispose')
                .length,
            1,
        );
    },
);

test(
    'handle and fiber failures do not skip later cleanup and aggregate in order',
    opts,
    async (t) => {
        const f = await fixture('dispose-error');
        t.after(() => f.close());
        const runtime = await initialized(f.request);
        t.after(async () => {
            await Promise.resolve(runtime.dispose()).catch(() => undefined);
        });
        const handleError = new Error('fixture handle failure');
        const fiberError = new Error('fixture fiber failure');
        const seen: string[] = [];
        // Only this failure-path unit substitutes handles; positive tests above use official ones.
        t.mock.method(runtime.ctx.agents, 'create', async () => ({
            agent: {},
            async dispose() {
                seen.push('first');
                throw handleError;
            },
        }));
        const options = {
            sessionId: f.request.grant.session as Parameters<
                typeof runtime.ctx.sessions.get
            >[0],
            meta: { cwd: runtime.workspaceRoot },
            agentOptions: runtime.agentOptions,
        };
        await runtime.agents.create(options);
        t.mock.method(runtime.ctx.agents, 'create', async () => ({
            agent: {},
            async dispose() {
                seen.push('second');
            },
        }));
        await runtime.agents.create(options);
        const fiber = runtime.ctx.fiber.dispose.bind(runtime.ctx.fiber);
        t.mock.method(runtime.ctx.fiber, 'dispose', async () => {
            await fiber();
            throw fiberError;
        });
        const disposing = runtime.dispose();
        assert.equal(runtime.dispose(), disposing);
        await assert.rejects(
            Promise.resolve(disposing),
            (error: AggregateError) => {
                assert(error instanceof AggregateError);
                assert.equal(error.errors.length, 3);
                assert.equal(error.errors[0], handleError);
                assert.equal(error.errors[1], fiberError);
                assert.match(error.errors[2].message, /model disposal failed/);
                return true;
            },
        );
        t.mock.restoreAll();
        assert.deepEqual(seen, ['first', 'second']);
        await f.assertSdkClosed();
        assert.equal(
            (await f.modelTrace()).filter((row) => row.phase === 'dispose')
                .length,
            1,
        );
    },
);

test(
    'registered child persistence never sends a parent-granted RPC',
    opts,
    async () => {
        const { Context } = await import('@deepseek-ai/cordis');
        const { SessionStore } = await import('@deepseek-ai/dsh-session');
        const { bindWorkerSession } = await import('./remote-session.ts');
        const { createServer } = await import('node:http');
        const requests: unknown[] = [];
        const server = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(chunk);
            requests.push(JSON.parse(Buffer.concat(chunks).toString()));
            response.end('{"ok":true}');
        });
        const url = await listen(server);
        const ctx = new Context();
        type Id = Parameters<typeof bindWorkerSession>[1];
        const root = randomUUID() as Id;
        const child = randomUUID() as Id;
        const unrelated = randomUUID() as Id;
        try {
            await ctx.plugin(SessionStore);
            await ctx.plugin(remoteSessionPersistence, { url, token: 'test' });
            const persistence = ctx.sessionPersistence;
            const register = bindWorkerSession(persistence, root);
            const release = register(child);
            const prepared = ctx.sessions.prepare(child, {
                meta: {
                    cwd: '/sandbox/project/workspace',
                    parentSession: root,
                    origin: 'subagent',
                    delegationDepth: 1,
                },
            });
            try {
                assert.equal(await persistence.stat(child), undefined);
                assert.equal(await persistence.stat(unrelated), undefined);
                await assert.rejects(
                    persistence.open(unrelated, 'read'),
                    /ownership/i,
                );
                const writer = await persistence.create(prepared.header);
                assert.equal((await persistence.stat(child))?.header.id, child);
                const reader = await persistence.open(child, 'read');
                await assert.rejects(reader.flush(), {
                    name: 'SessionReadOnlyError',
                });
                await assert.rejects(
                    persistence.open(child, 'write'),
                    /owned/i,
                );
                await writer.append(prepared.snapshotEvents());
                assert.deepEqual(
                    (await reader.read()).events,
                    prepared.snapshotEvents(),
                );
                await persistence.flush();
                assert.deepEqual(requests, []);
                await reader.close();
                await writer.close();
                await assert.rejects(reader.read(), /closed/i);
                assert.equal((await persistence.stat(child))?.header.id, child);
            } finally {
                await release();
            }
            assert.equal(await persistence.stat(child), undefined);
            await persistence.stat(root);
            assert.deepEqual(requests, [{ id: root, method: 'stat' }]);
        } finally {
            await ctx.fiber.dispose();
            await close(server);
        }
    },
);
