import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { TestContext } from 'node:test';
import type { Grant, WorkerRequest } from '@worker/protocol.ts';

const repositoryRoot = fileURLToPath(
    new URL('../../../../../../', import.meta.url),
);

type Row = Record<string, SQLOutputValue>;
type PersistedSnapshot = {
    sessions: Row[];
    events: Row[];
    receipts: Row[];
    intents: Row[];
};
export type CrashPoint =
    'before-commit' | 'after-commit' | 'after-stage' | 'after-append';
type Frame = {
    command: string;
    ok?: boolean;
    point?: string;
    hits?: number;
    state?: { state?: string; generation?: number };
    preparedBaseline?: PersistedSnapshot;
    priorCommitted?: PersistedSnapshot;
    transactionView?: PersistedSnapshot;
    target?: Row;
    before?: PersistedSnapshot;
    after?: PersistedSnapshot;
    grant?: Grant;
    persistenceUrl?: string;
    request?: string;
    response?: string;
    status?: number;
    events?: unknown[];
    result?: string;
    pending?: number;
};
type Exit = { code: number | null; signal: NodeJS.Signals | null };

function bounded<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(label + ' timeout')),
            ms,
        );
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}
class Peer {
    readonly child: ChildProcess;
    readonly frames: Frame[] = [];
    readonly exit: Promise<Exit>;
    readonly closed: Promise<void>;
    outcome: Exit | undefined;
    didClose = false;
    spawnError: Error | undefined;
    private stderr = '';
    private fatal: unknown;
    private waiters = new Map<
        string,
        { resolve: (frame: Frame) => void; reject: (error: unknown) => void }
    >();
    private reader;
    readonly role: 'host' | 'worker';
    constructor(role: 'host' | 'worker') {
        this.role = role;
        this.child = spawn(
            process.execPath,
            [
                '--import',
                resolve(repositoryRoot, 'register-paths.mjs'),
                resolve(
                    repositoryRoot,
                    'apps/orchestrator/orchestrator-execution-host/tests/openshell/provider-lifecycle/crash-child.ts',
                ),
                role,
            ],
            { cwd: repositoryRoot, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
        );
        this.exit = new Promise((resolve, reject) => {
            this.child.once('error', (error) => {
                this.spawnError = error;
                reject(error);
                this.fail(error);
            });
            this.child.once('exit', (code, signal) => {
                this.outcome = { code, signal };
                resolve(this.outcome);
                this.fail(new Error(role + ' exited'));
            });
        });
        void this.exit.catch(() => {});
        this.closed = new Promise((resolve) =>
            this.child.once('close', () => {
                this.didClose = true;
                resolve();
            }),
        );
        assert(this.child.stdout && this.child.stderr);
        this.child.stderr.on('data', (chunk: Buffer) => {
            this.stderr = (this.stderr + chunk.toString()).slice(-65536);
        });
        this.reader = createInterface({ input: this.child.stdout });
        this.reader.on('line', (line) => {
            try {
                const frame = JSON.parse(line) as Frame;
                this.frames.push(frame);
                if (frame.command === 'rpc') return;
                const waiter = this.waiters.get(frame.command);
                if (frame.ok === false) {
                    this.fail(
                        new Error(role + ' ' + frame.command + ' failed'),
                    );
                    return;
                }
                assert(
                    waiter,
                    'Unexpected or duplicate ' + role + ' ' + frame.command,
                );
                this.waiters.delete(frame.command);
                waiter.resolve(frame);
            } catch (error) {
                this.fail(error);
            }
        });
    }
    fail(error: unknown) {
        this.fatal ??= error;
        for (const waiter of this.waiters.values()) waiter.reject(error);
        this.waiters.clear();
    }
    wait(command: string, ms = 10_000) {
        if (this.fatal) return Promise.reject<Frame>(this.fatal);
        assert(!this.waiters.has(command));
        const promise = new Promise<Frame>((resolve, reject) =>
            this.waiters.set(command, { resolve, reject }),
        );
        return bounded(promise, ms, this.role + ' ' + command).finally(() =>
            this.waiters.delete(command),
        );
    }
    send(input: object) {
        assert(this.child.stdin);
        assert(!this.outcome && !this.spawnError);
        this.child.stdin.write(JSON.stringify(input) + '\n');
    }
    async command(
        input: { command: string } & Record<string, unknown>,
        reply = input.command,
    ) {
        const result = this.wait(reply);
        this.send(input);
        return result;
    }
    async normalClose(reply = 'close') {
        const operation = (async () => {
            const result = await this.command({ command: 'close' }, reply);
            assert.equal(result.ok, true);
            if (this.role === 'host') assert.equal(result.pending, 0);
            assert.deepEqual(await this.exit, { code: 0, signal: null });
            await this.closed;
        })();
        await bounded(operation, 3000, this.role + ' graceful close');
    }
    async killAndWait(requireSigkill: boolean, deadline = Date.now() + 15000) {
        const errors: unknown[] = [];
        if (!this.outcome && !this.spawnError) {
            try {
                const sent = this.child.kill('SIGKILL');
                if (!sent && !this.outcome)
                    errors.push(
                        new Error(this.role + ' SIGKILL not delivered'),
                    );
            } catch (error) {
                errors.push(error);
            }
        }
        try {
            if (!this.spawnError)
                await bounded(
                    this.exit,
                    Math.max(1, Math.min(5000, deadline - Date.now())),
                    this.role + ' exit',
                );
            if (requireSigkill)
                assert.deepEqual(this.outcome, {
                    code: null,
                    signal: 'SIGKILL',
                });
        } catch (error) {
            errors.push(error);
        }
        this.child.stdin?.destroy();
        try {
            if (this.child.connected) this.child.disconnect();
        } catch (error) {
            errors.push(error);
        }
        try {
            await bounded(
                this.closed,
                Math.max(1, Math.min(2000, deadline - Date.now())),
                this.role + ' close',
            );
        } catch (error) {
            errors.push(error);
        }
        this.child.stdout?.destroy();
        this.child.stderr?.destroy();
        this.reader.close();
        if (this.didClose) {
            this.child.removeAllListeners();
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length)
            throw new AggregateError(errors, 'A2 child cleanup failed');
    }
}
export async function createCrashFixture() {
    const folder = await mkdtemp(join(tmpdir(), 'bento-a2-crash-'));
    const historyPath = join(folder, 'history.sqlite');
    const authorityPath = join(folder, 'authority.sqlite');
    const session = SessionId(randomUUID());
    const binding = {
        tenant: 'a2-tenant',
        project: 'a2-project',
        session,
        sandbox: 'a2-sandbox',
        volume: 'a2-volume',
    };
    const peers: Peer[] = [];
    let disposing: Promise<void> | undefined;
    let closing = false;
    function snapshot(): PersistedSnapshot {
        const db = new DatabaseSync(historyPath, { readOnly: true });
        try {
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
        } finally {
            db.close();
        }
    }
    function start(role: 'host' | 'worker') {
        assert(!closing);
        const peer = new Peer(role);
        peers.push(peer);
        return peer;
    }
    return {
        folder,
        historyPath,
        authorityPath,
        session,
        snapshot,
        async host(fresh: boolean) {
            const peer = start('host');
            const ready = await peer.command(
                { command: 'init', historyPath, authorityPath, binding, fresh },
                'ready',
            );
            assert(ready.persistenceUrl);
            return { peer, url: ready.persistenceUrl };
        },
        async worker(
            action: 'seed' | 'produce' | 'recover' | 'continue',
            url: string,
            grant: Grant,
        ) {
            const peer = start('worker');
            const request: WorkerRequest = {
                mode: 'recover',
                binding,
                grant,
                persistenceUrl: url,
                operationUrl: url,
            };
            assert.deepEqual(Object.keys(request).sort(), [
                'binding',
                'grant',
                'mode',
                'operationUrl',
                'persistenceUrl',
            ]);
            const response = await peer.command(
                { command: 'init', request, workspaceRoot: folder, action },
                action === 'recover' ? 'recover' : 'ready',
            );
            if (action === 'recover') {
                assert.equal(response.result, 'recovered');
                assert.deepEqual(
                    await bounded(peer.exit, 3000, 'recover exit'),
                    { code: 0, signal: null },
                );
                await bounded(peer.closed, 2000, 'recover close');
            }
            return { peer, response };
        },
        dispose() {
            disposing ??= (async () => {
                closing = true;
                const errors: unknown[] = [];
                const deadline = Date.now() + 15000;
                for (const peer of peers)
                    peer.fail(new Error('A2 fixture closing'));
                for (const role of ['worker', 'host'] as const) {
                    const results = await Promise.allSettled(
                        peers
                            .filter((peer) => peer.role === role)
                            .map((peer) => peer.killAndWait(false, deadline)),
                    );
                    errors.push(
                        ...results.flatMap((result) =>
                            result.status === 'rejected' ? [result.reason] : [],
                        ),
                    );
                }
                if (
                    peers.every(
                        (peer) =>
                            (peer.outcome || peer.spawnError) && peer.didClose,
                    )
                ) {
                    try {
                        await rm(folder, { recursive: true, force: true });
                        assert.equal(existsSync(folder), false);
                    } catch (error) {
                        errors.push(error);
                    }
                } else
                    errors.push(
                        new Error('A2 child remains; fixture retained'),
                    );
                if (errors.length === 1) throw errors[0];
                if (errors.length)
                    throw new AggregateError(
                        errors,
                        'A2 crash case and cleanup failed',
                    );
            })();
            return disposing;
        },
    };
}
function receiptValue(row: Row) {
    return Object.fromEntries(
        Object.entries(row).filter(([key]) => key !== 'id'),
    );
}
function receiptOrder(a: Row, b: Row) {
    return (
        Number(a.epoch) - Number(b.epoch) ||
        String(a.batch).localeCompare(String(b.batch))
    );
}
function verifyStored(state: PersistedSnapshot) {
    assert.equal(state.intents.length, 0);
    verifyCommittedRows(state);
}
function verifyCommittedRows(state: PersistedSnapshot) {
    assert.equal(state.sessions.length, 1);
    assert.deepEqual(
        Object.keys(state.sessions[0]!).sort(),
        [
            'id',
            'header',
            'inherited',
            'epoch',
            'owner',
            'handle',
            'next',
            'revision',
            'materialized',
            'created_by',
        ].sort(),
    );
    assert.equal(state.sessions[0]!.next, state.events.length);
    assert.deepEqual(
        state.events.map((row) => row.seq),
        state.events.map((_, index) => index),
    );
    for (const receipt of state.receipts) {
        const events = state.events.slice(
            Number(receipt.first),
            Number(receipt.first) + Number(receipt.count),
        );
        assert.equal(events.length, receipt.count);
        assert(Number(receipt.count) > 0);
        assert.equal(
            receipt.digest,
            createHash('sha256')
                .update(
                    JSON.stringify(
                        events.map((row) => JSON.parse(String(row.event))),
                    ),
                )
                .digest('hex'),
        );
    }
    for (const event of state.events)
        assert.equal(
            state.receipts.filter(
                (receipt) =>
                    Number(receipt.first) <= Number(event.seq) &&
                    Number(receipt.first) + Number(receipt.count) >
                        Number(event.seq),
            ).length,
            1,
        );
}
export async function runCrashCase(point: CrashPoint, t: TestContext) {
    const fixture = await createCrashFixture();
    t.after(() => fixture.dispose());
    const failures: unknown[] = [];
    try {
        await bounded(
            (async () => {
                let host = await fixture.host(true);
                const admitted = await host.peer.command({
                    command: 'admit',
                    generation: 1,
                    run: randomUUID(),
                });
                assert(admitted.grant);
                const seed = await fixture.worker(
                    'seed',
                    host.url,
                    admitted.grant,
                );
                await seed.peer.command({ command: 'prepare' }, 'prepared');
                const first = await seed.peer.command(
                    { command: 'turn' },
                    'completed',
                );
                await seed.peer.normalClose();
                verifyStored(fixture.snapshot());
                assert.deepEqual(
                    fixture
                        .snapshot()
                        .events.map((row) => JSON.parse(String(row.event))),
                    first.events,
                );
                const producer = await fixture.worker(
                    'produce',
                    host.url,
                    admitted.grant,
                );
                await producer.peer.command({ command: 'prepare' }, 'prepared');
                const baseline = fixture.snapshot();
                verifyStored(baseline);
                await host.peer.command({ command: 'arm', point });
                const barrierWait = host.peer.wait('barrier');
                producer.peer.send({ command: 'turn' });
                const barrier = await barrierWait.catch((error: unknown) => {
                    const trace = host.peer.frames
                        .filter((frame) => frame.command === 'rpc')
                        .map((frame) => {
                            const query = JSON.parse(frame.request!) as {
                                method: string;
                                events?: Array<{ type: string }>;
                            };
                            return {
                                method: query.method,
                                status: frame.status,
                                types: query.events?.map((event) => event.type),
                            };
                        });
                    throw new Error(
                        'A2 barrier trace ' + JSON.stringify(trace),
                        { cause: error },
                    );
                });
                assert.equal(barrier.point, point);
                assert.equal(barrier.hits, 1);
                assert(
                    barrier.preparedBaseline &&
                        barrier.priorCommitted &&
                        barrier.transactionView &&
                        barrier.target,
                );
                const prior = barrier.priorCommitted;
                const view = barrier.transactionView;
                const target = barrier.target;
                assert.deepEqual(barrier.preparedBaseline, baseline);
                verifyCommittedRows(prior);
                assert.deepEqual(
                    prior.events.slice(0, baseline.events.length),
                    baseline.events,
                );
                const previousKeys = new Set(
                    baseline.receipts.map(
                        (row) => String(row.epoch) + ':' + String(row.batch),
                    ),
                );
                for (const row of baseline.receipts)
                    assert.deepEqual(
                        prior.receipts.find(
                            (candidate) =>
                                candidate.batch === row.batch &&
                                candidate.epoch === row.epoch,
                        ),
                        row,
                    );
                const earlier = prior.receipts.filter(
                    (row) =>
                        !previousKeys.has(
                            String(row.epoch) + ':' + String(row.batch),
                        ),
                );
                const expectedPriorSession: Row = {
                    ...baseline.sessions[0]!,
                    next: prior.events.length,
                    revision:
                        Number(baseline.sessions[0]!.revision) + earlier.length,
                };
                assert.deepEqual(prior.sessions, [expectedPriorSession]);
                for (const receipt of earlier) {
                    const requests = host.peer.frames.filter(
                        (frame) =>
                            frame.command === 'rpc' &&
                            frame.status === 200 &&
                            JSON.parse(frame.request!).method === 'append' &&
                            JSON.parse(frame.request!).batch === receipt.batch,
                    );
                    assert.equal(requests.length, 1);
                    const request = JSON.parse(requests[0]!.request!);
                    assert.deepEqual(
                        request.events,
                        prior.events
                            .slice(
                                Number(receipt.first),
                                Number(receipt.first) + Number(receipt.count),
                            )
                            .map((row) => JSON.parse(String(row.event))),
                    );
                    assert.deepEqual(
                        JSON.parse(requests[0]!.response!).value,
                        receiptValue(receipt),
                    );
                }
                const stageOnly = point === 'after-stage';
                const alreadyCommitted =
                    point === 'after-commit' || point === 'after-append';
                assert.equal(prior.intents.length, stageOnly ? 0 : 1);
                const intent = view.intents[0]!;
                if (!stageOnly) assert.deepEqual(prior.intents, [intent]);
                assert.deepEqual(Object.keys(intent).sort(), [
                    'batch',
                    'epoch',
                    'id',
                    'payload',
                ]);
                assert.equal(intent.id, fixture.session);
                assert.equal(intent.epoch, 1);
                const payload = JSON.parse(String(intent.payload)) as Array<{
                    seq: number;
                    type: string;
                }>;
                assert(
                    payload.some((event) => event.type === 'request/header'),
                );
                assert(payload.some((event) => event.type === 'user/message'));
                assert.equal(target.batch, intent.batch);
                assert.equal(target.epoch, intent.epoch);
                assert.equal(
                    target.digest,
                    createHash('sha256')
                        .update(String(intent.payload))
                        .digest('hex'),
                );
                assert.equal(target.first, prior.events.length);
                assert.equal(target.count, payload.length);
                assert.equal(payload[0]!.seq, target.first);
                assert(
                    !prior.receipts.some((row) => row.batch === target.batch),
                );
                assert.equal(prior.sessions[0]!.materialized, 1);
                if (stageOnly)
                    assert.deepEqual(view, { ...prior, intents: [intent] });
                else {
                    assert.deepEqual(view, {
                        sessions: [
                            {
                                ...prior.sessions[0]!,
                                next: prior.events.length + payload.length,
                                revision:
                                    Number(prior.sessions[0]!.revision) + 1,
                                materialized: 1,
                            },
                        ],
                        events: [
                            ...prior.events,
                            ...payload.map((event) => ({
                                id: fixture.session,
                                seq: event.seq,
                                event: JSON.stringify(event),
                            })),
                        ],
                        receipts: [
                            ...prior.receipts,
                            { id: fixture.session, ...target },
                        ].sort(receiptOrder),
                        intents: prior.intents,
                    });
                }
                verifyCommittedRows(view);
                if (point === 'before-commit' || point === 'after-commit')
                    await host.peer.killAndWait(true);
                await producer.peer.killAndWait(true);
                const crashed = fixture.snapshot();
                assert.deepEqual(
                    crashed,
                    point === 'before-commit' ? prior : view,
                );
                const receipt: Row = { id: fixture.session, ...target };
                if (alreadyCommitted)
                    assert.deepEqual(
                        view.receipts.find((row) => row.batch === target.batch),
                        receipt,
                    );
                if (point === 'after-stage' || point === 'after-append') {
                    const dropped = await host.peer.command({
                        command: 'drop-ack',
                    });
                    assert.equal(dropped.pending, 0);
                    assert.deepEqual(fixture.snapshot(), crashed);
                    await host.peer.normalClose();
                }
                host = await fixture.host(false);
                const takeover = await host.peer.command({
                    command: 'takeover',
                    generation: 1,
                });
                assert.equal(takeover.state?.state, 'READY');
                assert.equal(takeover.state?.generation, 2);
                const next = await host.peer.command({
                    command: 'admit',
                    generation: 2,
                    run: randomUUID(),
                });
                assert(next.grant);
                const recovery = await fixture.worker(
                    'recover',
                    host.url,
                    next.grant,
                );
                const rpc = host.peer.frames.filter(
                    (frame) => frame.command === 'rpc',
                );
                assert.deepEqual(
                    rpc
                        .slice(0, 4)
                        .map((frame) => JSON.parse(frame.request!).method),
                    ['stat', 'open', 'reconcile', 'close'],
                );
                const reconcile = rpc[2]!;
                const query = JSON.parse(reconcile.request!);
                assert(!('batch' in query));
                assert(!('events' in query));
                assert.equal(reconcile.status, 200);
                const result = JSON.parse(reconcile.response!).value as {
                    outcome: string;
                    receipt: Row;
                };
                assert.equal(
                    result.outcome,
                    alreadyCommitted ? 'already-committed' : 'committed',
                );
                assert.equal(result.receipt.batch, intent.batch);
                assert.equal(result.receipt.digest, receipt.digest);
                assert.equal(result.receipt.epoch, alreadyCommitted ? 1 : 2);
                if (alreadyCommitted)
                    assert.deepEqual(
                        result.receipt,
                        Object.fromEntries(
                            Object.entries(receipt).filter(
                                ([key]) => key !== 'id',
                            ),
                        ),
                    );
                assert(reconcile.before && reconcile.after);
                const before = reconcile.before;
                const after = reconcile.after;
                assert.deepEqual(before.events, crashed.events);
                assert.deepEqual(before.receipts, crashed.receipts);
                assert.deepEqual(before.intents, crashed.intents);
                assert.equal(typeof before.sessions[0]!.handle, 'string');
                assert.deepEqual(before.sessions, [
                    {
                        ...crashed.sessions[0]!,
                        epoch: 2,
                        owner: next.grant.run,
                        handle: before.sessions[0]!.handle,
                    },
                ]);
                if (!alreadyCommitted) {
                    assert.deepEqual(after, {
                        sessions: [
                            {
                                ...before.sessions[0]!,
                                next:
                                    Number(before.sessions[0]!.next) +
                                    payload.length,
                                revision:
                                    Number(before.sessions[0]!.revision) + 1,
                                materialized: 1,
                            },
                        ],
                        events: [
                            ...before.events,
                            ...payload.map((event) => ({
                                id: fixture.session,
                                seq: event.seq,
                                event: JSON.stringify(event),
                            })),
                        ],
                        receipts: [
                            ...before.receipts,
                            { id: fixture.session, ...result.receipt },
                        ].sort(receiptOrder),
                        intents: [],
                    });
                } else assert.deepEqual(after, { ...before, intents: [] });
                const recovered = fixture.snapshot();
                verifyStored(recovered);
                assert.deepEqual(
                    recovered.events.map((row) =>
                        JSON.parse(String(row.event)),
                    ),
                    recovery.response.events,
                );
                assert.deepEqual(
                    recovered.events.slice(0, baseline.events.length),
                    baseline.events,
                );
                assert.equal(recovered.sessions[0]!.epoch, 2);
                assert.equal(recovered.sessions[0]!.owner, next.grant.run);
                for (const old of crashed.receipts)
                    assert.deepEqual(
                        recovered.receipts.find(
                            (row) =>
                                row.epoch === old.epoch &&
                                row.batch === old.batch,
                        ),
                        old,
                    );
                const saved = recovered.receipts.filter(
                    (row) => row.batch === intent.batch,
                );
                assert.equal(saved.length, 1);
                const follow = await fixture.worker(
                    'continue',
                    host.url,
                    next.grant,
                );
                await follow.peer.command({ command: 'prepare' }, 'prepared');
                const continued = await follow.peer.command(
                    { command: 'turn' },
                    'completed',
                );
                await follow.peer.normalClose();
                const final = fixture.snapshot();
                verifyStored(final);
                assert.deepEqual(
                    final.events.map((row) => JSON.parse(String(row.event))),
                    continued.events,
                );
                assert.deepEqual(
                    final.events.slice(0, recovered.events.length),
                    recovered.events,
                );
                assert.deepEqual(
                    final.receipts.filter((row) => row.batch === intent.batch),
                    saved,
                );
                assert.equal(final.sessions[0]!.handle, null);
                assert.equal(final.sessions[0]!.epoch, 2);
                assert.equal(final.sessions[0]!.owner, next.grant.run);
                for (const old of recovered.receipts)
                    assert.deepEqual(
                        final.receipts.find(
                            (row) =>
                                row.epoch === old.epoch &&
                                row.batch === old.batch,
                        ),
                        old,
                    );
                await host.peer.normalClose();
            })(),
            40_000,
            'A2 case body',
        );
    } catch (error) {
        failures.push(error);
    }
    try {
        await fixture.dispose();
    } catch (error) {
        failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length)
        throw new AggregateError(failures, 'A2 crash case and cleanup failed');
}
