import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence';
import { createOfficialRuntime } from './runtime.ts';
import { remoteSessionPersistence } from '@/apps/worker/src/remote-session.ts';
import { SingleHostExecution } from '@/apps/orchestrator/orchestrator-execution-host/src/openshell/single-host.ts';

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
        let closing: Promise<void> | undefined;
        let beforeStream: (options: GenerateOptions) => void;
        const shared = await createOfficialRuntime({
            workspaceRoot: folder,
            sessionId: session,
            beforeStream: (options) => beforeStream(options),
        });
        const { ctx, agentOptions } = shared;
        let lastSessionEventAt = performance.now();
        const inFlightFlushes = new Set<ReturnType<SessionHandle['flush']>>();
        const observedFlushFailures: unknown[] = [];
        const observedHandles = new WeakSet<SessionHandle>();
        const restoreFlushes: Array<() => void> = [];
        const removeObserver = ctx.on('session/event', (eventSession) => {
            if (eventSession.id === session)
                lastSessionEventAt = performance.now();
        });
        function observeFlush<T extends SessionHandle>(handle: T): T {
            if (handle.access !== 'write' || observedHandles.has(handle))
                return handle;
            observedHandles.add(handle);
            const original = handle.flush;
            const descriptor = Object.getOwnPropertyDescriptor(handle, 'flush');
            const observed = (...args: Parameters<SessionHandle['flush']>) => {
                const pending = original.apply(handle, args);
                inFlightFlushes.add(pending);
                void pending.then(
                    () => {
                        inFlightFlushes.delete(pending);
                    },
                    (error: unknown) => {
                        inFlightFlushes.delete(pending);
                        observedFlushFailures.push(error);
                    },
                );
                return pending;
            };
            handle.flush = observed;
            restoreFlushes.push(() => {
                if (handle.flush !== observed)
                    throw new Error('A2 flush observer ownership changed');
                if (descriptor)
                    Object.defineProperty(handle, 'flush', descriptor);
                else Reflect.deleteProperty(handle, 'flush');
                observedHandles.delete(handle);
            });
            return handle;
        }
        async function waitForAutomaticFlush(
            failureIndex: number,
        ): Promise<void> {
            const deadline = performance.now() + 10_000;
            for (;;) {
                let remaining = deadline - performance.now();
                if (remaining <= 0)
                    throw new Error('A2 automatic flush did not quiesce');
                const observedAt = lastSessionEventAt;
                // RemoteSession.Handle.enqueue arms a 200ms timer. Even a
                // zero delay yields to that already-due timer before probing.
                await delay(
                    Math.min(
                        remaining,
                        Math.max(
                            0,
                            Math.ceil(observedAt + 200 - performance.now()),
                        ),
                    ),
                );
                remaining = deadline - performance.now();
                if (remaining <= 0)
                    throw new Error('A2 automatic flush did not quiesce');
                let timer: NodeJS.Timeout | undefined;
                try {
                    await Promise.race([
                        Promise.allSettled([...inFlightFlushes]),
                        new Promise<never>((_, reject) => {
                            timer = setTimeout(
                                () =>
                                    reject(
                                        new Error(
                                            'A2 automatic flush did not quiesce',
                                        ),
                                    ),
                                remaining,
                            );
                        }),
                    ]);
                } finally {
                    clearTimeout(timer);
                }
                if (performance.now() >= deadline)
                    throw new Error('A2 automatic flush did not quiesce');
                if (lastSessionEventAt !== observedAt || inFlightFlushes.size)
                    continue;
                const failures = observedFlushFailures.slice(failureIndex);
                if (failures.length === 1) throw failures[0];
                if (failures.length)
                    throw new AggregateError(
                        failures,
                        'A2 automatic flush failed',
                    );
                return;
            }
        }
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
                        value: {
                            batch: string;
                            digest: string;
                            first: number;
                            count: number;
                        };
                    };
                    assert.equal(upstream.status, 200);
                    assert.equal(parsed.ok, true);
                    assert.equal(
                        after.receipts.filter(
                            (row) => row.batch === parsed.value.batch,
                        ).length,
                        1,
                    );
                    const payload = JSON.parse(body) as {
                        events: SessionEvent[];
                    };
                    const committed = after.events.slice(
                        parsed.value.first,
                        parsed.value.first + parsed.value.count,
                    );
                    assert.equal(committed.length, parsed.value.count);
                    assert.deepEqual(
                        committed.map((row) => JSON.parse(String(row.event))),
                        payload.events,
                    );
                    assert.equal(
                        createHash('sha256')
                            .update(JSON.stringify(payload.events))
                            .digest('hex'),
                        parsed.value.digest,
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
                () => cleanup([removeObserver, ...restoreFlushes.splice(0)]),
                () => shared.dispose({ revoked }),
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
                const failureIndex = observedFlushFailures.length;
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
                await waitForAutomaticFlush(failureIndex);
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
            beforeStream = (options: GenerateOptions) => {
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
            await shared.initialize();
            const persistence = ctx.sessionPersistence;
            const create = persistence.create.bind(persistence);
            persistence.create = async (...args) => {
                const writer = observeFlush(await create(...args));
                runtime.writer = writer;
                return writer;
            };
            const open = persistence.open.bind(persistence);
            persistence.open = async (...args) => {
                const handle = observeFlush(await open(...args));
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
