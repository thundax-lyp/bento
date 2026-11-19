import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { Context } from '@deepseek-ai/cordis';
import {
    AgentRegistry,
    type AgentHandle,
    type AgentOptions,
} from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import {
    LlmRuntime,
    LlmAdapter,
    createUserMessage,
    type GenerateOptions,
    type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import {
    SessionStore,
    SessionId,
    type SessionEvent,
} from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import * as checkpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy';
import {
    SessionOwnershipLostError,
    type SessionHandle,
} from '@deepseek-ai/dsh-session-persistence';
import { remoteSessionPersistence } from '@/apps/worker/remote-session.ts';
import { SingleHostExecution } from '../single-host.ts';

const agentOptions: AgentOptions = { provider: 'a2-local', model: 'fixture' };
type Row = Record<string, SQLOutputValue>;
type PersistedSnapshot = {
    sessions: Row[];
    events: Row[];
    receipts: Row[];
    intents: Row[];
};
type RpcTrace = {
    method: string;
    status: number;
    request: string;
    response: string;
    dropped: boolean;
    before: PersistedSnapshot;
    after: PersistedSnapshot;
};
type Runtime = {
    ctx: Context;
    agentHandle: AgentHandle | undefined;
    writer: SessionHandle | undefined;
    trace: RpcTrace[];
    create(): Promise<AgentHandle>;
    resume(): Promise<AgentHandle>;
    turn(): Promise<readonly SessionEvent[]>;
    checkpoint(): Promise<void>;
    close(): Promise<void>;
    expectRevokedDispose(): Promise<void>;
    dropNextAppendAck(): void;
    waitForDroppedAck(): Promise<void>;
};
type ProviderFixture = {
    readonly controller: SingleHostExecution;
    session: SessionId;
    historyPath: string;
    authorityPath: string;
    start(generation: 1 | 2): Promise<Runtime>;
    reopen(): Promise<void>;
    snapshot(): PersistedSnapshot;
    dispose(): Promise<void>;
};

class LocalTurnAdapter extends LlmAdapter {
    private readonly beforeStream: (options: GenerateOptions) => void;
    constructor(beforeStream: (options: GenerateOptions) => void) {
        super();
        this.beforeStream = beforeStream;
    }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        options.signal?.throwIfAborted();
        this.beforeStream(options);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'a2-local-response' };
        yield {
            type: 'block-end',
            index: 0,
            block: { type: 'text', text: 'a2-local-response' },
        };
        yield { type: 'finish', reason: { kind: 'stop' } };
    }
}

function closeHttpServer(server: Server): Promise<void> {
    if (!server.listening) return Promise.resolve();
    const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    return closed;
}

async function cleanup(
    actions: Array<() => unknown | Promise<unknown>>,
    failures: unknown[] = [],
) {
    for (const action of actions) {
        try {
            await action();
        } catch (error) {
            failures.push(error);
        }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
        throw new AggregateError(failures, 'A2 fixture cleanup failed');
}

async function listen(server: Server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
}

export async function createProviderFixture(): Promise<ProviderFixture> {
    const folder = await mkdtemp(join(tmpdir(), 'bento-a2-provider-'));
    const session = SessionId(randomUUID());
    const historyPath = join(folder, 'history.sqlite');
    const authorityPath = join(folder, 'authority.sqlite');
    const binding = {
        tenant: 'a2-tenant',
        project: 'a2-project',
        session,
        sandbox: 'a2-sandbox',
        volume: 'a2-volume',
    };
    let running = true;
    const observation = () => ({
        sandbox: binding.sandbox,
        volume: binding.volume,
        running,
        installed: true,
    });
    const sandbox = {
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
    };
    const paths = { authority: authorityPath, history: historyPath };
    let controller = new SingleHostExecution(paths, sandbox);
    let ingress = controller.persistenceIngress();
    let ingressUrl: string;
    const runtimes: Runtime[] = [];
    let disposing: Promise<void> | undefined;

    function snapshot(): PersistedSnapshot {
        const db = new DatabaseSync(historyPath, { readOnly: true });
        try {
            return {
                sessions: db
                    .prepare('SELECT * FROM sessions WHERE id=?')
                    .all(session),
                events: db
                    .prepare('SELECT * FROM events WHERE id=? ORDER BY seq')
                    .all(session),
                receipts: db
                    .prepare(
                        'SELECT * FROM batch_receipts WHERE id=? ORDER BY epoch,batch',
                    )
                    .all(session),
                intents: db
                    .prepare('SELECT * FROM batch_intents WHERE id=?')
                    .all(session),
            };
        } finally {
            db.close();
        }
    }

    async function start(generation: 1 | 2): Promise<Runtime> {
        const trace: RpcTrace[] = [];
        const transportFailures: unknown[] = [];
        let drop = false;
        let droppedResolve: (() => void) | undefined;
        let droppedAck: Promise<void> | undefined;
        let unregisterAdapter: (() => void) | undefined;
        let closing: Promise<void> | undefined;
        const ctx = new Context();
        const proxy = createServer(async (request, response) => {
            try {
                if (request.method !== 'POST' || request.url !== '/rpc') {
                    response.writeHead(404).end();
                    return;
                }
                const chunks: Buffer[] = [];
                for await (const chunk of request)
                    chunks.push(Buffer.from(chunk));
                const body = Buffer.concat(chunks).toString('utf8');
                const authorization = request.headers.authorization;
                assert(typeof authorization === 'string');
                const { method } = JSON.parse(body) as { method: string };
                const before = snapshot();
                const upstream = await fetch(new URL('/rpc', ingressUrl), {
                    method: 'POST',
                    headers: {
                        authorization,
                        'content-type': 'application/json',
                    },
                    body,
                    signal: AbortSignal.timeout(10_000),
                });
                const result = await upstream.text();
                const after = snapshot();
                const dropped = drop && method === 'append';
                const entry = {
                    method,
                    status: upstream.status,
                    request: body,
                    response: result,
                    dropped,
                    before,
                    after,
                };
                trace.push(entry);
                if (dropped) {
                    const parsed = JSON.parse(result) as {
                        ok: boolean;
                        value: { batch: string };
                    };
                    assert.equal(upstream.status, 200);
                    assert.equal(parsed.ok, true);
                    assert.equal(
                        after.receipts.filter(
                            (row) => row.batch === parsed.value.batch,
                        ).length,
                        1,
                    );
                    drop = false;
                    response.destroy();
                    droppedResolve!();
                } else {
                    response
                        .writeHead(upstream.status, {
                            'content-type': 'application/json',
                        })
                        .end(result);
                }
            } catch (error) {
                transportFailures.push(error);
                response.destroy();
            }
        });
        function close(revoked: boolean): Promise<void> {
            closing ??= cleanup([
                async () => {
                    if (!runtime.agentHandle) return;
                    if (revoked)
                        await assert.rejects(
                            runtime.agentHandle.dispose(),
                            SessionOwnershipLostError,
                        );
                    else await runtime.agentHandle.dispose();
                },
                async () => {
                    if (!revoked) return;
                    const persistence = ctx.sessionPersistence;
                    assert(
                        'dispose' in persistence &&
                            typeof persistence.dispose === 'function',
                    );
                    await assert.rejects(
                        persistence.dispose(),
                        (error: unknown) => {
                            assert(error instanceof AggregateError);
                            assert.equal(
                                error.message,
                                'Session persistence close failed',
                            );
                            assert.equal(error.errors.length, 1);
                            assert(
                                error.errors[0] instanceof
                                    SessionOwnershipLostError,
                            );
                            return true;
                        },
                    );
                },
                () => unregisterAdapter?.(),
                () => ctx.fiber.dispose(),
                () => closeHttpServer(proxy),
                () => {
                    if (transportFailures.length)
                        throw new AggregateError(
                            transportFailures,
                            'A2 proxy failed',
                        );
                },
            ]);
            return closing;
        }
        const runtime: Runtime = {
            ctx,
            agentHandle: undefined,
            writer: undefined,
            trace,
            async create() {
                runtime.agentHandle = await ctx.agents.create({
                    sessionId: session,
                    meta: { cwd: folder },
                    agentOptions,
                });
                return runtime.agentHandle;
            },
            async resume() {
                runtime.agentHandle = await ctx.agents.resume({
                    resumeSessionId: session,
                    agentOptions,
                });
                return runtime.agentHandle;
            },
            async checkpoint() {
                assert(runtime.agentHandle);
                assert.equal(
                    await ctx.sessions.flush(runtime.agentHandle.agent.session),
                    true,
                );
            },
            async turn() {
                assert(runtime.agentHandle);
                const agent = runtime.agentHandle.agent;
                const first = agent.session.snapshotEvents().length;
                agent.followup(
                    createUserMessage({
                        source: { kind: 'user' },
                        content: [{ type: 'text', text: 'a2-local-input' }],
                    }),
                );
                await agent.whenIdle();
                await runtime.checkpoint();
                const events = agent.session.snapshotEvents();
                const tail = events.slice(first);
                assert.equal(
                    tail.filter((event) => event.type === 'user/message')
                        .length,
                    1,
                );
                assert.equal(
                    tail.filter((event) => event.type === 'assistant/message')
                        .length,
                    1,
                );
                const end = tail.findLast((event) => event.type === 'turn/end');
                assert(end?.type === 'turn/end');
                assert.equal(end.data.reason.kind, 'completed');
                return events;
            },
            close: () => close(false),
            expectRevokedDispose: () => close(true),
            dropNextAppendAck() {
                assert(!drop && !droppedAck);
                drop = true;
                droppedAck = new Promise<void>((resolve) => {
                    droppedResolve = resolve;
                });
            },
            async waitForDroppedAck() {
                assert(droppedAck);
                await droppedAck;
            },
        };
        runtimes.push(runtime);
        try {
            const proxyUrl = await listen(proxy);
            const grant = controller.admit(
                session,
                generation,
                randomUUID(),
                60_000,
            );
            await ctx.plugin(remoteSessionPersistence, {
                url: proxyUrl,
                token: grant.token,
            });
            await ctx.plugin(AgentRegistry);
            await ctx.plugin(SessionStore);
            await ctx.plugin(SessionProjectionRegistry);
            await ctx.plugin(LlmRuntime);
            await ctx.plugin(SystemPrompt);
            await ctx.plugin(ToolRuntime);
            await ctx.plugin(AgentLoop);
            await ctx.plugin(checkpointPolicy);
            const beforeStream = (options: GenerateOptions) => {
                assert.equal(options.sessionId, session);
                assert(runtime.agentHandle);
                const stored = snapshot();
                const live = runtime.agentHandle.agent.session.snapshotEvents();
                assert.deepEqual(
                    stored.events.map((row) => JSON.parse(String(row.event))),
                    live,
                );
                assert(live.some((event) => event.type === 'request/header'));
                assert(live.some((event) => event.type === 'user/message'));
                assert.equal(stored.intents.length, 0);
                for (const event of live.filter(
                    (event) =>
                        event.type === 'request/header' ||
                        event.type === 'user/message',
                )) {
                    assert(
                        stored.receipts.some(
                            (row) =>
                                Number(row.first) <= event.seq &&
                                Number(row.first) + Number(row.count) >
                                    event.seq,
                        ),
                    );
                }
            };
            unregisterAdapter = ctx.llm.registerAdapter(
                ['a2-local'],
                new LocalTurnAdapter(beforeStream),
            );
            const persistence = ctx.sessionPersistence;
            const create = persistence.create.bind(persistence);
            persistence.create = async (...args) => {
                const writer = await create(...args);
                runtime.writer = writer;
                return writer;
            };
            const open = persistence.open.bind(persistence);
            persistence.open = async (...args) => {
                const handle = await open(...args);
                if (handle.access === 'write') runtime.writer = handle;
                return handle;
            };
            return runtime;
        } catch (error) {
            await cleanup([() => runtime.close()], [error]);
            throw error;
        }
    }
    const fixture: ProviderFixture = {
        get controller() {
            return controller;
        },
        session,
        historyPath,
        authorityPath,
        start,
        snapshot,
        async reopen() {
            for (const runtime of runtimes) await runtime.close();
            await closeHttpServer(ingress);
            controller.close();
            controller = new SingleHostExecution(paths, sandbox);
            ingress = controller.persistenceIngress();
            ingressUrl = await listen(ingress);
        },
        dispose() {
            disposing ??= cleanup([
                ...runtimes.map((runtime) => () => runtime.close()),
                () => closeHttpServer(ingress),
                () => controller.close(),
                () => rm(folder, { recursive: true, force: true }),
            ]);
            return disposing;
        },
    };
    try {
        controller.bind(binding, observation());
        ingressUrl = await listen(ingress);
        return fixture;
    } catch (error) {
        await cleanup([() => fixture.dispose()], [error]);
        throw error;
    }
}
