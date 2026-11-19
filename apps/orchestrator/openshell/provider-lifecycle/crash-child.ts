import assert from 'node:assert/strict';
import { writeSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import { runDshWorker } from '@/apps/worker/dsh-worker.ts';
import { remoteSessionPersistence } from '@/apps/worker/remote-session.ts';
import type { Binding, WorkerRequest } from '@/apps/worker/protocol.ts';
import { SingleHostExecution } from '../single-host.ts';
import {
    createOfficialRuntime,
    createWorkerBootstrapRuntime,
} from './runtime.ts';

type Command = {
    command: string;
    authorityPath: string;
    historyPath: string;
    binding: Binding;
    fresh: boolean;
    generation: number;
    run: string;
    point: string;
    request: WorkerRequest;
    workspaceRoot: string;
    action: string;
};
function frame(value: object) {
    writeSync(1, JSON.stringify(value) + '\n');
}
let intentionalDisconnect = false;
function finish(code: number) {
    intentionalDisconnect = true;
    process.stdin.destroy();
    if (process.connected) process.disconnect();
    process.exitCode = code;
}
process.on('disconnect', () => {
    if (!intentionalDisconnect) process.exit(1);
});

function snapshot(db: DatabaseSync, session: string) {
    return {
        sessions: db
            .prepare('SELECT * FROM sessions WHERE id=?')
            .all(session)
            .map((row) => ({ ...row })),
        events: db
            .prepare('SELECT * FROM events WHERE id=? ORDER BY seq')
            .all(session)
            .map((row) => ({ ...row })),
        receipts: db
            .prepare(
                'SELECT * FROM batch_receipts WHERE id=? ORDER BY epoch,batch',
            )
            .all(session)
            .map((row) => ({ ...row })),
        intents: db
            .prepare('SELECT * FROM batch_intents WHERE id=?')
            .all(session)
            .map((row) => ({ ...row })),
    };
}
async function listen(server: Server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
}
async function closeServer(server: Server | undefined) {
    if (!server?.listening) return;
    const done = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await done;
}

async function host() {
    let controller: SingleHostExecution | undefined;
    let ingress: Server | undefined;
    let proxy: Server | undefined;
    let config: Command;
    let point: string | undefined;
    let armed = false;
    let preparedBaseline: ReturnType<typeof snapshot> | undefined;
    let hits = 0;
    let held: { response: ServerResponse; release: () => void } | undefined;
    let running = true;
    const active = new Set<Promise<void>>();
    const fetches = new Set<AbortController>();
    const transportErrors: unknown[] = [];
    const originalExec = DatabaseSync.prototype.exec;
    let closing = false;
    let disposal: Promise<void> | undefined;
    function readSnapshot() {
        const db = new DatabaseSync(realpathSync(config.historyPath), {
            readOnly: true,
        });
        try {
            return snapshot(db, config.binding.session);
        } finally {
            db.close();
        }
    }
    function close() {
        disposal ??= (async () => {
            closing = true;
            const errors: unknown[] = [];
            async function attempt(action: () => unknown | Promise<unknown>) {
                try {
                    await action();
                } catch (error) {
                    errors.push(error);
                }
            }
            held?.response.destroy();
            held?.release();
            const proxyClosed = closeServer(proxy);
            for (const abort of fetches) abort.abort();
            await attempt(() => proxyClosed);
            await attempt(async () => {
                const results = await Promise.allSettled([...active]);
                errors.push(
                    ...results.flatMap((result) =>
                        result.status === 'rejected' ? [result.reason] : [],
                    ),
                );
            });
            await attempt(() => closeServer(ingress));
            await attempt(() => controller?.close());
            DatabaseSync.prototype.exec = originalExec;
            errors.push(...transportErrors);
            if (errors.length === 1) throw errors[0];
            if (errors.length)
                throw new AggregateError(errors, 'A2 host cleanup failed');
        })();
        return disposal;
    }
    DatabaseSync.prototype.exec = function (sql: string) {
        let evidence:
            | {
                  preparedBaseline: ReturnType<typeof snapshot>;
                  priorCommitted: ReturnType<typeof snapshot>;
                  transactionView: ReturnType<typeof snapshot>;
                  target: object;
              }
            | undefined;
        if (
            armed &&
            (point === 'before-commit' || point === 'after-commit') &&
            sql === 'COMMIT'
        ) {
            const main = this.prepare('PRAGMA database_list')
                .all()
                .filter((row) => row.name === 'main');
            assert.equal(main.length, 1);
            assert(
                typeof main[0]!.file === 'string' && main[0]!.file.length > 0,
            );
            if (
                realpathSync(main[0]!.file) === realpathSync(config.historyPath)
            ) {
                const pending = this.prepare(
                    'SELECT payload FROM batch_intents JOIN batch_receipts USING(id,epoch,batch) WHERE id=?',
                ).get(config.binding.session);
                if (pending) {
                    const events = JSON.parse(
                        String(pending.payload),
                    ) as SessionEvent[];
                    if (
                        events.some(
                            (event) => event.type === 'request/header',
                        ) &&
                        events.some((event) => event.type === 'user/message')
                    ) {
                        assert(preparedBaseline);
                        const transactionView = snapshot(
                            this,
                            config.binding.session,
                        );
                        const priorCommitted = readSnapshot();
                        assert.equal(transactionView.intents.length, 1);
                        const intent = transactionView.intents[0]!;
                        const receipt = transactionView.receipts.find(
                            (row) =>
                                row.batch === intent.batch &&
                                row.epoch === intent.epoch,
                        );
                        assert(receipt);
                        const { batch, digest, epoch, first, count } = receipt;
                        evidence = {
                            preparedBaseline,
                            priorCommitted,
                            transactionView,
                            target: { batch, digest, epoch, first, count },
                        };
                    }
                }
            }
        }
        function stop() {
            armed = false;
            frame({ command: 'barrier', point, hits: ++hits, ...evidence });
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        if (evidence && point === 'before-commit') stop();
        const result = originalExec.call(this, sql);
        if (evidence && point === 'after-commit') stop();
        return result;
    };
    try {
        for await (const line of createInterface({ input: process.stdin })) {
            const input = JSON.parse(line) as Command;
            switch (input.command) {
                case 'init': {
                    assert(!controller);
                    config = input;
                    const observation = () => ({
                        sandbox: input.binding.sandbox,
                        volume: input.binding.volume,
                        installed: true,
                        running,
                    });
                    controller = new SingleHostExecution(
                        {
                            authority: input.authorityPath,
                            history: input.historyPath,
                        },
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
                    if (input.fresh)
                        controller.bind(input.binding, observation());
                    ingress = controller.persistenceIngress();
                    const ingressUrl = await listen(ingress);
                    proxy = createServer((request, response) => {
                        const abort = new AbortController();
                        fetches.add(abort);
                        const task = (async () => {
                            try {
                                assert.equal(request.method, 'POST');
                                assert.equal(request.url, '/rpc');
                                const chunks: Buffer[] = [];
                                for await (const chunk of request)
                                    chunks.push(Buffer.from(chunk));
                                const body =
                                    Buffer.concat(chunks).toString('utf8');
                                const authorization =
                                    request.headers.authorization;
                                assert(typeof authorization === 'string');
                                const query = JSON.parse(body) as {
                                    method: string;
                                    batch?: string;
                                    events?: SessionEvent[];
                                };
                                const callerTarget =
                                    armed &&
                                    ((point === 'after-stage' &&
                                        query.method === 'stage') ||
                                        (point === 'after-append' &&
                                            query.method === 'append')) &&
                                    query.events?.some(
                                        (event) =>
                                            event.type === 'request/header',
                                    ) &&
                                    query.events.some(
                                        (event) =>
                                            event.type === 'user/message',
                                    );
                                const priorCommitted = callerTarget
                                    ? readSnapshot()
                                    : undefined;
                                const before =
                                    query.method === 'reconcile'
                                        ? readSnapshot()
                                        : undefined;
                                const upstream = await fetch(
                                    new URL('/rpc', ingressUrl),
                                    {
                                        method: 'POST',
                                        headers: {
                                            authorization,
                                            'content-type': 'application/json',
                                        },
                                        body,
                                        signal: abort.signal,
                                    },
                                );
                                const result = await upstream.text();
                                frame({
                                    command: 'rpc',
                                    request: body,
                                    status: upstream.status,
                                    response: result,
                                    before,
                                    after:
                                        query.method === 'reconcile'
                                            ? readSnapshot()
                                            : undefined,
                                });
                                if (callerTarget) {
                                    assert(
                                        priorCommitted &&
                                            preparedBaseline &&
                                            query.events &&
                                            query.batch,
                                    );
                                    assert.equal(upstream.status, 200);
                                    const transactionView = readSnapshot();
                                    assert.equal(
                                        transactionView.intents.length,
                                        1,
                                    );
                                    const intent = transactionView.intents[0]!;
                                    const payload = JSON.stringify(
                                        query.events,
                                    );
                                    assert.equal(intent.batch, query.batch);
                                    assert.equal(intent.payload, payload);
                                    const target = {
                                        batch: query.batch,
                                        digest: createHash('sha256')
                                            .update(payload)
                                            .digest('hex'),
                                        epoch: intent.epoch,
                                        first: priorCommitted.sessions[0]!.next,
                                        count: query.events.length,
                                    };
                                    if (point === 'after-append') {
                                        const receipt =
                                            transactionView.receipts.find(
                                                (row) =>
                                                    row.batch ===
                                                        target.batch &&
                                                    row.epoch === target.epoch,
                                            );
                                        assert(receipt);
                                        assert.deepEqual(receipt, {
                                            id: config.binding.session,
                                            ...target,
                                        });
                                        assert.deepEqual(
                                            JSON.parse(result).value,
                                            target,
                                        );
                                    } else
                                        assert(
                                            !transactionView.receipts.some(
                                                (row) =>
                                                    row.batch === target.batch,
                                            ),
                                        );
                                    assert(!held);
                                    let release!: () => void;
                                    const gate = new Promise<void>(
                                        (resolve) => {
                                            release = resolve;
                                        },
                                    );
                                    held = { response, release };
                                    armed = false;
                                    frame({
                                        command: 'barrier',
                                        point,
                                        hits: ++hits,
                                        preparedBaseline,
                                        priorCommitted,
                                        transactionView,
                                        target,
                                    });
                                    await gate;
                                    return;
                                }
                                response
                                    .writeHead(upstream.status, {
                                        'content-type': 'application/json',
                                    })
                                    .end(result);
                            } catch (error) {
                                if (!(
                                    closing &&
                                    abort.signal.aborted &&
                                    error instanceof Error &&
                                    error.name === 'AbortError'
                                ))
                                    transportErrors.push(error);
                                response.destroy();
                            } finally {
                                fetches.delete(abort);
                            }
                        })();
                        active.add(task);
                        void task.finally(() => active.delete(task));
                    });
                    frame({
                        command: 'ready',
                        ok: true,
                        persistenceUrl: await listen(proxy),
                    });
                    break;
                }
                case 'admit':
                    assert(controller);
                    frame({
                        command: 'admit',
                        ok: true,
                        grant: controller.admit(
                            config!.binding.session,
                            input.generation,
                            input.run,
                            120_000,
                        ),
                    });
                    break;
                case 'takeover':
                    assert(controller);
                    frame({
                        command: 'takeover',
                        ok: true,
                        state: await controller.takeover(
                            config!.binding.session,
                            input.generation,
                        ),
                    });
                    break;
                case 'arm':
                    assert(!armed && hits === 0);
                    assert(
                        [
                            'before-commit',
                            'after-commit',
                            'after-stage',
                            'after-append',
                        ].includes(input.point),
                    );
                    point = input.point;
                    preparedBaseline = readSnapshot();
                    armed = true;
                    frame({ command: 'arm', ok: true });
                    break;
                case 'drop-ack': {
                    assert(held && hits === 1);
                    held.response.destroy();
                    held.release();
                    await Promise.all([...active]);
                    held = undefined;
                    assert.equal(active.size, 0);
                    frame({ command: 'drop-ack', ok: true, pending: 0 });
                    break;
                }
                case 'close':
                    await close();
                    frame({ command: 'close', ok: true, pending: active.size });
                    finish(0);
                    return;
                default:
                    throw new Error('Unknown host command');
            }
        }
    } finally {
        await close();
    }
}

async function worker() {
    let shared: Awaited<ReturnType<typeof createOfficialRuntime>> | undefined;
    let handle: AgentHandle | undefined;
    let config: Command;
    let recoveredEvents: readonly SessionEvent[] = [];
    try {
        for await (const line of createInterface({ input: process.stdin })) {
            const input = JSON.parse(line) as Command;
            switch (input.command) {
                case 'init': {
                    assert(!shared);
                    assert(
                        ['seed', 'produce', 'recover', 'continue'].includes(
                            input.action,
                        ),
                    );
                    config = input;
                    shared = await createOfficialRuntime({
                        workspaceRoot: input.workspaceRoot,
                        sessionId: SessionId(input.request.grant.session),
                        beforeStream(options) {
                            assert.equal(
                                options.sessionId,
                                input.request.grant.session,
                            );
                            assert(handle);
                            const db = new DatabaseSync(
                                join(input.workspaceRoot, 'history.sqlite'),
                                { readOnly: true },
                            );
                            try {
                                const state = snapshot(
                                    db,
                                    input.request.grant.session,
                                );
                                const live =
                                    handle.agent.session.snapshotEvents();
                                assert.deepEqual(
                                    state.events.map((row) =>
                                        JSON.parse(String(row.event)),
                                    ),
                                    live,
                                );
                                assert.equal(state.intents.length, 0);
                                for (const event of live.filter(
                                    (event) =>
                                        event.type === 'request/header' ||
                                        event.type === 'user/message',
                                ))
                                    assert(
                                        state.receipts.some(
                                            (row) =>
                                                Number(row.first) <=
                                                    event.seq &&
                                                Number(row.first) +
                                                    Number(row.count) >
                                                    event.seq,
                                        ),
                                    );
                            } finally {
                                db.close();
                            }
                        },
                    });
                    if (input.action === 'recover') {
                        assert.equal(input.request.mode, 'recover');
                        const runtime = createWorkerBootstrapRuntime(shared);
                        const flush = runtime.flush.bind(runtime);
                        runtime.flush = async (agent) => {
                            await flush(agent);
                            const session = runtime.ctx.sessions.get(
                                SessionId(input.request.grant.session),
                            );
                            assert(session);
                            recoveredEvents = session.snapshotEvents();
                        };
                        const result = await runDshWorker(
                            input.request,
                            async () => runtime,
                        );
                        assert.equal(result, 'recovered');
                        frame({
                            command: 'recover',
                            ok: true,
                            result,
                            events: recoveredEvents,
                        });
                        finish(0);
                        return;
                    }
                    await shared.ctx.plugin(remoteSessionPersistence, {
                        url: input.request.persistenceUrl,
                        token: input.request.grant.token,
                    });
                    await shared.initialize();
                    frame({ command: 'ready', ok: true });
                    break;
                }
                case 'prepare':
                    assert(shared && !handle);
                    handle =
                        config!.action === 'seed'
                            ? await shared.agents.create({
                                  sessionId: SessionId(
                                      config!.request.grant.session,
                                  ),
                                  meta: { cwd: config!.workspaceRoot },
                                  agentOptions: shared.agentOptions,
                              })
                            : await shared.agents.resume({
                                  resumeSessionId: SessionId(
                                      config!.request.grant.session,
                                  ),
                                  agentOptions: shared.agentOptions,
                              });
                    await shared.flush(handle.agent);
                    frame({
                        command: 'prepared',
                        ok: true,
                        events: handle.agent.session.snapshotEvents(),
                    });
                    break;
                case 'turn': {
                    assert(shared && handle);
                    const first = handle.agent.session.snapshotEvents().length;
                    handle.agent.followup(shared.userMessage('a2-crash-input'));
                    await handle.agent.whenIdle();
                    await shared.flush(handle.agent);
                    const events = handle.agent.session.snapshotEvents();
                    const tail = events.slice(first);
                    assert.equal(
                        tail.filter((event) => event.type === 'user/message')
                            .length,
                        1,
                    );
                    assert.equal(
                        tail.filter(
                            (event) => event.type === 'assistant/message',
                        ).length,
                        1,
                    );
                    const end = tail.findLast(
                        (event) => event.type === 'turn/end',
                    );
                    assert(end?.type === 'turn/end');
                    assert.equal(end.data.reason.kind, 'completed');
                    frame({ command: 'completed', ok: true, events });
                    break;
                }
                case 'close':
                    assert(shared);
                    await shared.dispose();
                    frame({ command: 'close', ok: true });
                    finish(0);
                    return;
                default:
                    throw new Error('Unknown worker command');
            }
        }
    } finally {
        await shared?.dispose();
    }
}
try {
    assert(process.argv[2] === 'host' || process.argv[2] === 'worker');
    await (process.argv[2] === 'host' ? host() : worker());
} catch (error) {
    // Never serialize grant-bearing input, RPC bodies, or exception messages.
    frame({
        command: 'error',
        ok: false,
        error: error instanceof Error ? error.name : 'UnknownError',
    });
    finish(1);
}
