import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { BaseBootstrapConfig } from '@worker/runtime/base-bootstrap.ts';
import type { WorkerRequest } from '@worker/protocol.ts';
import { createRunSdkTransport } from '@worker/openshell/sdk-transport.ts';
import { prewarmedWorker } from '@orchestrator/execution-service/warm-worker.ts';
import type { PreparedSdk } from '@/apps/orchestrator/orchestrator-execution-host/tests/openshell/binding-grants/sdk.ts';
import { prepareReuseSdk } from './sdk.ts';
import { createReuseFixture } from './fixture.ts';
import { readWorkerProcesses, sha256 } from './observer.ts';
import { createTraceReader, traceFailureCode } from './trace.ts';

const root = resolve(
    fileURLToPath(new URL('../../../../../../', import.meta.url)),
);
const here = dirname(fileURLToPath(import.meta.url));
let sdk: PreparedSdk;
let get: (request: WorkerRequest, sandbox: string) => Promise<{ name: string }>;
before(
    async () => {
        sdk = await prepareReuseSdk();
        const api = await import(
            pathToFileURL(join(dirname(sdk.raw), 'index.js')).href
        );
        get = async (request, sandbox) => {
            assert(request.gateway);
            const transport = createRunSdkTransport(
                request.gateway,
                request.grant.token,
            );
            try {
                return await new api.SandboxClient(transport.transport).get(
                    sandbox,
                );
            } finally {
                await transport.close();
            }
        };
    },
    { timeout: 600_000 },
);
after(async () => sdk?.dispose());
const timeout = { timeout: 120_000, concurrency: false };
const reuseMode = process.env.BENTO_A6_WORKER_REUSE_MODE ?? 'soak';
assert(
    reuseMode === 'soak' || reuseMode === 'burst',
    'BENTO_A6_WORKER_REUSE_MODE must be soak or burst',
);
const roundIntervalMs = reuseMode === 'soak' ? 5000 : 0;

type Trace = {
    kind: string;
    pid: number;
    session?: string;
    phase?: string;
    listener?: boolean;
    cache?: boolean;
    predecessor?: boolean;
    empty?: boolean;
    active?: number;
    rejected?: boolean;
};
type Counters = {
    persistence: number;
    operation: number;
    sdk: number;
    sdkConnections: number;
    upstream: number;
    model: number;
    modelConnections: number;
};
type NetworkProof = { before: Counters; after: Counters };
type ModelCall = { session: string; text: string; markers: string[] };
async function until(done: () => boolean | Promise<boolean>, label: string) {
    const end = performance.now() + 10000;
    while (!(await done())) {
        if (performance.now() >= end) throw new Error('Timed out: ' + label);
        await delay(10);
    }
}
async function harness(
    observed: boolean,
    count: 2 | 65 = 2,
    mode?: 'hold' | 'failure',
) {
    const fixture = await createReuseFixture(sdk, count);
    const trace = join(fixture.directory, 'trace.ndjson');
    const hold = join(fixture.directory, 'hold');
    const failure = join(fixture.directory, 'dispose-failure');
    await fs.writeFile(trace, '', { mode: 0o600 });
    if (mode === 'hold') await fs.writeFile(hold, '', { mode: 0o600 });
    if (mode === 'failure') await fs.writeFile(failure, '', { mode: 0o600 });
    const calls: ModelCall[] = [];
    const sockets = new Set<Socket>();
    let modelConnections = 0;
    const problems: string[] = [];
    const model = createServer(async (request, response) => {
        try {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of request) {
                size += chunk.length;
                assert(size <= 1024 * 1024);
                chunks.push(Buffer.from(chunk));
            }
            const body = JSON.parse(Buffer.concat(chunks).toString()) as {
                session: string;
                messages: unknown;
                provider: string;
                model: string;
            };
            assert.equal(body.provider, 'reuse-fixture');
            assert.equal(body.model, 'deterministic');
            assert.equal(typeof body.session, 'string');
            const text = JSON.stringify(body.messages);
            const markers = [
                ...new Set(text.match(/reuse-marker-[a-f0-9-]+/g) ?? []),
            ];
            assert.equal(markers.length, 1);
            calls.push({ session: body.session, text, markers });
            response.writeHead(200, {
                'content-type': 'application/json',
                connection: 'close',
            });
            response.end(JSON.stringify({ text: 'completed ' + markers[0] }));
        } catch {
            problems.push('model request validation failed');
            response.writeHead(500);
            response.end();
        }
    });
    model.on('connection', (socket) => {
        modelConnections++;
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    const address = model.address();
    assert(address && typeof address === 'object');
    const config: BaseBootstrapConfig = {
        schema: 1,
        sdkModule: join(dirname(sdk.raw), 'index.js'),
        modelAdapterModule: join(here, 'model-adapter.ts'),
        provider: 'reuse-fixture',
        model: 'deterministic',
        workspaceRoot: '/sandbox/project',
        helper: '/runtime/ptc.mjs',
        fileSystemHelper: '/runtime/fs.mjs',
        node: '/usr/local/bin/node',
    };
    const configPath = join(fixture.directory, 'runtime.json');
    await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const lifetime = new AbortController();
    const pool = prewarmedWorker({
        command: process.execPath,
        args: [
            '--import',
            join(root, 'register-paths.mjs'),
            join(root, 'apps/worker/src/run-worker.ts'),
            '--warm',
        ],
        cwd: root,
        env: {
            PATH: process.env.PATH ?? '',
            BENTO_DSH_BOOTSTRAP: observed
                ? join(here, 'observed-bootstrap.ts')
                : join(root, 'apps/worker/src/runtime/base-bootstrap.ts'),
            BENTO_DSH_RUNTIME_CONFIG: configPath,
            BENTO_REUSE_MODEL_URL: 'http://127.0.0.1:' + address.port,
            BENTO_REUSE_TRACE: trace,
            ...(mode === 'hold' ? { BENTO_REUSE_HOLD_FILE: hold } : {}),
            ...(mode === 'failure'
                ? { BENTO_REUSE_DISPOSE_FAILURE: failure }
                : {}),
        },
    });
    const stop = pool.warmWorker(lifetime.signal);
    const networkProofs = new Map<string, NetworkProof>();
    const monitorAbort = new AbortController();
    const traces = createTraceReader<Trace>(trace);
    const counters = (): Counters => ({
        persistence: fixture.controlRequests.filter(
            (row) => row.interface === 'persistence',
        ).length,
        operation: fixture.controlRequests.filter(
            (row) => row.interface === 'operation',
        ).length,
        sdk: fixture.wire.length,
        sdkConnections: fixture.connections.length,
        upstream: fixture.upstreamCalls,
        model: calls.length,
        modelConnections,
    });
    const grantHashes = new Map<string, string>();
    const baselineCursors = new Map<
        string,
        { control: number; wire: number; at: number }
    >();
    let monitorDebug: object = {};
    const baselines = new Map<string, Counters>();
    let monitorPhase = 'idle';
    const seen = new Set<string>();
    const monitor = (async () => {
        while (!monitorAbort.signal.aborted) {
            monitorPhase = 'poll';
            for (const row of await traces()) {
                if (
                    !row.session ||
                    !['old-event-ready', 'old-event-ended'].includes(
                        row.phase ?? '',
                    )
                )
                    continue;
                const key = row.session + ':' + row.phase;
                if (seen.has(key)) continue;
                seen.add(key);
                monitorPhase = row.phase!;
                if (row.phase === 'old-event-ready') {
                    const deadline = Date.now() + 4000;
                    let baseline = counters();
                    while (true) {
                        await delay(100, undefined, {
                            signal: monitorAbort.signal,
                        });
                        const now = counters();
                        if (isDeepStrictEqual(now, baseline)) break;
                        if (Date.now() >= deadline)
                            throw new Error('Listener baseline did not settle');
                        baseline = now;
                    }
                    baselines.set(row.session, baseline);
                    baselineCursors.set(row.session, {
                        control: fixture.controlRequests.length,
                        wire: fixture.wire.length,
                        at: performance.now(),
                    });
                    await fs.writeFile(
                        trace + '.ack',
                        JSON.stringify({
                            session: row.session,
                            phase: 'ready',
                        }),
                        { mode: 0o600 },
                    );
                } else {
                    const baseline = baselines.get(row.session);
                    assert(baseline);
                    const cursor = baselineCursors.get(row.session)!;
                    monitorDebug = {
                        before: baseline,
                        after: counters(),
                        control: fixture.controlRequests
                            .slice(cursor.control)
                            .map((item) => ({
                                interface: item.interface,
                                status: item.status,
                                startedMs: item.at - cursor.at,
                                endedMs:
                                    item.finishedAt === null
                                        ? null
                                        : item.finishedAt - cursor.at,
                                current:
                                    item.tokenSha256 ===
                                    grantHashes.get(row.session!),
                            })),
                        sdk: fixture.wire.slice(cursor.wire).map((item) => ({
                            method: item.method,
                            current:
                                item.tokenSha256 ===
                                grantHashes.get(row.session!),
                        })),
                    };
                    assert(
                        isDeepStrictEqual(counters(), baseline),
                        'Old event caused a fixture network request',
                    );
                    await delay(100, undefined, {
                        signal: monitorAbort.signal,
                    });
                    const after = counters();
                    assert(
                        isDeepStrictEqual(after, baseline),
                        'Old event caused a delayed fixture network request',
                    );
                    networkProofs.set(row.session, { before: baseline, after });
                    await fs.writeFile(
                        trace + '.ack',
                        JSON.stringify({ session: row.session, phase: 'done' }),
                        { mode: 0o600 },
                    );
                }
            }
            await delay(5, undefined, { signal: monitorAbort.signal });
        }
    })().catch((error: unknown) => {
        if (!monitorAbort.signal.aborted)
            problems.push(
                'listener network observation failed at ' +
                    monitorPhase +
                    ': ' +
                    traceFailureCode(error),
            );
    });

    let stopped = false;
    let closed = false;
    return {
        fixture,
        networkProofs,
        counters,
        debug: () => monitorDebug,
        pool,
        calls,
        problems,
        sockets,
        modelUrl: 'http://127.0.0.1:' + address.port,
        traces,
        async pid() {
            await until(
                () => readWorkerProcesses(process.pid).length === 1,
                'actual warm Worker PID',
            );
            return readWorkerProcesses(process.pid)[0]!.pid;
        },
        async run(index: number) {
            const request = fixture.request(index);
            grantHashes.set(
                request.binding.session,
                sha256(request.grant.token),
            );
            return pool.worker(request, new AbortController().signal);
        },
        async unhold() {
            await fs.unlink(hold);
        },
        async stop() {
            if (stopped) return;
            lifetime.abort();
            await stop();
            stopped = true;
            assert.deepEqual(readWorkerProcesses(process.pid), []);
            await fixture.quiescent();
            await until(() => sockets.size === 0, 'model sockets closed');
        },
        async close() {
            if (closed) return;
            closed = true;
            const errors: unknown[] = [];
            const attempt = async (
                action: () => unknown | Promise<unknown>,
            ) => {
                try {
                    await action();
                } catch (error) {
                    errors.push(error);
                }
            };
            await attempt(() => this.stop());
            monitorAbort.abort();
            await attempt(() => monitor);
            await attempt(() => traces(true));
            await attempt(async () => {
                model.closeAllConnections();
                await new Promise<void>((resolve, reject) =>
                    model.close((error) => (error ? reject(error) : resolve())),
                );
                assert.equal(model.listening, false);
            });
            await attempt(() => fixture.close());
            if (errors.length === 1) throw errors[0];
            if (errors.length)
                throw new AggregateError(
                    errors,
                    'Reuse harness cleanup failed',
                );
        },
    };
}
type Harness = Awaited<ReturnType<typeof harness>>;
function rows(h: Harness) {
    const db = new DatabaseSync(h.fixture.paths.history, { readOnly: true });
    try {
        return Object.fromEntries(
            ['sessions', 'events', 'batch_receipts', 'batch_intents'].map(
                (table) => [
                    table,
                    db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all(),
                ],
            ),
        );
    } finally {
        db.close();
    }
}
function history(h: Harness, request: WorkerRequest) {
    const db = new DatabaseSync(h.fixture.paths.history, { readOnly: true });
    try {
        const events = db
            .prepare('SELECT event FROM events WHERE id=? ORDER BY seq')
            .all(request.binding.session);
        const text = JSON.stringify(events);
        assert.deepEqual(
            [...new Set(text.match(/reuse-marker-[a-f0-9-]+/g) ?? [])],
            [request.prompt],
        );
        assert(text.includes('completed'));
        const row = h.fixture
            .snapshot()
            .sessions.find((row) => row.session === request.binding.session);
        assert(row);
        assert.equal(row.handle, null);
        assert.equal(row.intents, 0);
        const model = h.calls.filter(
            (call) => call.session === request.binding.session,
        );
        assert.equal(model.length, 1);
        assert.deepEqual(model[0]!.markers, [request.prompt]);
        assert(!model[0]!.text.includes(request.grant.token));
    } finally {
        db.close();
    }
}
async function completed(h: Harness, index: number, pid: number) {
    assert.equal(await h.run(index), 'completed');
    assert.equal(await h.pid(), pid);
    await h.fixture.quiescent();
    await until(() => h.sockets.size === 0, 'model request connection closed');
    history(h, h.fixture.request(index));
    assert.deepEqual(h.problems, []);
    const trace = await h.traces();
    assert(
        trace
            .filter((row) => row.kind === 'model-disposed')
            .every((row) => row.active === 0),
    );
    return trace;
}

test(
    'P0 production base runs two Sessions in the actual warm Worker',
    timeout,
    async () => {
        const h = await harness(false);
        try {
            const pid = await h.pid();
            await completed(h, 0, pid);
            await completed(h, 1, pid);
            assert.equal(h.calls.length, 2);
            assert(h.fixture.wire.length > 0);
            await h.stop();
        } finally {
            await h.close();
        }
    },
);

test(
    'P1/P2 same PID across 64 Sessions independently rejects four predecessor resources',
    { timeout: 600_000, concurrency: false },
    async (t) => {
        const h = await harness(true, 65);
        const results: {
            round: number;
            startedMs: number;
            network: NetworkProof;
            credential: boolean;
            listener: boolean;
            connection: boolean;
            cache: boolean;
        }[] = [];
        try {
            const pid = await h.pid();
            await completed(h, 64, pid);
            let previous = h.fixture.request(64);
            let priorConnection = h.fixture.connections.at(-1)!;
            let controlCursor = h.fixture.controlRequests.length;
            let first = 0;
            let last = 0;
            for (let round = 0; round < 64; round++) {
                if (round > 0) {
                    const target = first + round * roundIntervalMs;
                    while (performance.now() < target)
                        await delay(
                            Math.max(1, Math.ceil(target - performance.now())),
                        );
                }
                const started = performance.now();
                if (!round) first = started;
                assert(
                    started >= first + round * roundIntervalMs,
                    'Measured round started early',
                );
                last = started;
                assert.equal(
                    h.fixture.controlRequests.length,
                    controlCursor,
                    'Late HTTP request between measured rounds',
                );
                const current = h.fixture.request(round);
                const controlStart = h.fixture.controlRequests.length;
                const start = h.fixture.wire.length;
                const trace = await completed(h, round, pid);
                const currentWire = h.fixture.wire.slice(start);
                assert(
                    h.fixture.controlRequests
                        .slice(controlStart)
                        .every(
                            (row) =>
                                row.tokenSha256 === sha256(current.grant.token),
                        ),
                    'Prior identity sent a late control request',
                );
                const network = h.networkProofs.get(current.binding.session);
                assert(network);
                assert(isDeepStrictEqual(network.before, network.after));
                assert(
                    currentWire.length > 0,
                    'Current SDK positive control missing',
                );
                assert(
                    currentWire.every(
                        (row) =>
                            row.tokenSha256 === sha256(current.grant.token) &&
                            row.targets.every(
                                (target) => target === current.binding.sandbox,
                            ),
                    ),
                );
                assert(priorConnection.closedAt !== null);
                assert(priorConnection.closedAt <= currentWire[0]!.openedAt);
                const probe = trace.find(
                    (row) =>
                        row.kind === 'runtime' &&
                        row.session === current.binding.session &&
                        row.phase === 'probe',
                );
                assert(probe?.predecessor && probe.listener && probe.cache);
                assert.equal(probe.pid, pid);
                const before = rows(h);
                const calls = h.fixture.upstreamCalls;
                const beforeDenied = h.fixture.controlRequests.length;
                const denied = await fetch(
                    new URL('/rpc', previous.persistenceUrl),
                    {
                        method: 'POST',
                        headers: {
                            authorization: 'Bearer ' + previous.grant.token,
                        },
                        body: JSON.stringify({
                            method: 'stat',
                            id: current.binding.session,
                        }),
                        signal: AbortSignal.timeout(5000),
                    },
                );
                assert.equal(denied.status, 403);
                await denied.arrayBuffer();
                const deniedRequests =
                    h.fixture.controlRequests.slice(beforeDenied);
                assert.equal(deniedRequests.length, 1);
                assert.equal(deniedRequests[0]!.interface, 'persistence');
                assert.equal(
                    deniedRequests[0]!.tokenSha256,
                    sha256(previous.grant.token),
                );
                await assert.rejects(get(previous, current.binding.sandbox));
                await h.fixture.quiescent();
                assert.equal(h.fixture.wire.at(-1)!.status, '7');
                assert.equal(h.fixture.upstreamCalls, calls);
                assert(
                    isDeepStrictEqual(rows(h), before),
                    'Cross-session probes mutated private SQL rows',
                );
                assert.equal(
                    (await get(current, current.binding.sandbox)).name,
                    current.binding.sandbox,
                );
                await h.fixture.quiescent();
                assert.equal(
                    h.fixture.wire.at(-1)!.tokenSha256,
                    sha256(current.grant.token),
                );
                priorConnection = h.fixture.connections.find(
                    (row) => row.id === currentWire[0]!.connection,
                )!;
                results.push({
                    round,
                    startedMs: started - first,
                    network,
                    credential: true,
                    listener: probe.listener,
                    connection: priorConnection.closedAt !== null,
                    cache: probe.cache,
                });
                assert.equal(
                    h.fixture.controlRequests.length,
                    beforeDenied + 1,
                    'Late control request after cross-session probe',
                );
                controlCursor = h.fixture.controlRequests.length;
                previous = current;
                if ((round + 1) % 8 === 0)
                    t.diagnostic('measured rounds=' + (round + 1) + '/64');
            }
            assert.equal(results.length, 64);
            assert(
                results.every(
                    (row) =>
                        row.credential &&
                        row.listener &&
                        row.connection &&
                        row.cache,
                ),
            );
            assert(last - first >= 63 * roundIntervalMs);
            assert.equal(
                new Set(
                    h.fixture
                        .snapshot()
                        .sessions.filter(
                            (row) =>
                                row.session !==
                                h.fixture.request(64).binding.session,
                        )
                        .map((row) => row.tenant),
                ).size,
                8,
            );
            for (let index = 0; index < 65; index++)
                history(h, h.fixture.request(index));
            t.diagnostic(
                JSON.stringify({
                    schema: 1,
                    mode: reuseMode,
                    roundIntervalMs,
                    pid,
                    spanMs: last - first,
                    results,
                }),
            );
            await h.stop();
            await delay(100);
            assert.equal(
                h.fixture.controlRequests.length,
                controlCursor,
                'Late control request after pool shutdown',
            );
            assert.deepEqual(h.problems, []);
        } catch (error) {
            t.diagnostic(
                JSON.stringify({
                    problems: h.problems,
                    counters: h.counters(),
                    debug: h.debug(),
                    trace: (await h.traces())
                        .slice(-12)
                        .map((row) => ({ kind: row.kind, phase: row.phase })),
                }),
            );
            throw error;
        } finally {
            await h.close();
        }
    },
);

test(
    'R revoked open-input SDK stream exits its Worker before replacement succeeds',
    timeout,
    async () => {
        const h = await harness(true, 2, 'hold');
        try {
            const pid = await h.pid();
            const neighbor = h.fixture.request(1);
            const before = h.fixture
                .snapshot()
                .sessions.find(
                    (row) => row.session === neighbor.binding.session,
                );
            const pending = h.run(0).then(
                (result) => ({ result }),
                () => ({ result: 'error' }),
            );
            await until(
                async () =>
                    (await h.traces()).some(
                        (row) => row.phase === 'probe' && row.pid === pid,
                    ),
                'revocation probe entered',
            );
            await h.fixture.waitHeld(0);
            await h.fixture.takeover(0);
            await h.unhold();
            const { result } = await pending;
            assert(['review', 'error'].includes(result));
            await until(
                () =>
                    !readWorkerProcesses(process.pid).some(
                        (row) => row.pid === pid,
                    ),
                'revoked Worker exit',
            );
            await until(
                () => h.fixture.activeHeld === 0,
                'held upstream closed',
            );
            assert(
                (await h.traces()).some(
                    (row) =>
                        row.phase === 'revoked-input' &&
                        row.rejected &&
                        row.pid === pid,
                ),
            );
            const upstreamCalls = h.fixture.upstreamCalls;
            await assert.rejects(
                get(h.fixture.request(0), h.fixture.request(0).binding.sandbox),
            );
            assert.equal(h.fixture.upstreamCalls, upstreamCalls);
            assert.equal(h.fixture.wire.at(-1)!.status, '16');
            assert.deepEqual(
                h.fixture
                    .snapshot()
                    .sessions.find(
                        (row) => row.session === neighbor.binding.session,
                    ),
                before,
            );
            const replacement = await h.pid();
            assert.notEqual(replacement, pid);
            await completed(h, 1, replacement);
            await h.stop();
        } finally {
            await h.close();
        }
    },
);

test(
    'E adapter cleanup error closes resources and fails before replacement succeeds',
    timeout,
    async () => {
        const h = await harness(true, 2, 'failure');
        try {
            const pid = await h.pid();
            await assert.rejects(h.run(0));
            await until(
                () =>
                    !readWorkerProcesses(process.pid).some(
                        (row) => row.pid === pid,
                    ),
                'failed cleanup Worker exit',
            );
            await h.fixture.quiescent();
            const trace = await h.traces();
            assert(
                trace.some(
                    (row) =>
                        row.phase === 'disposed' &&
                        row.empty &&
                        row.pid === pid,
                ),
            );
            assert(
                trace.some(
                    (row) =>
                        row.kind === 'model-disposed' &&
                        row.active === 0 &&
                        row.pid === pid,
                ),
            );
            const replacement = await h.pid();
            assert.notEqual(replacement, pid);
            await completed(h, 1, replacement);
            await h.stop();
        } finally {
            await h.close();
        }
    },
);

test(
    'L pool shutdown has no resources and same SQLite reopens without history drift',
    timeout,
    async () => {
        const h = await harness(true);
        try {
            const pid = await h.pid();
            await completed(h, 0, pid);
            const before = rows(h);
            await h.stop();
            await h.fixture.reopen();
            assert(
                isDeepStrictEqual(rows(h), before),
                'Same-database reopen changed history or receipts',
            );
            // A new lifetime owns a new genuine production pool after the old one exits.
            const config = join(h.fixture.directory, 'runtime.json');
            const life = new AbortController();
            const pool = prewarmedWorker({
                command: process.execPath,
                args: [
                    '--import',
                    join(root, 'register-paths.mjs'),
                    join(root, 'apps/worker/src/run-worker.ts'),
                    '--warm',
                ],
                cwd: root,
                env: {
                    PATH: process.env.PATH ?? '',
                    BENTO_DSH_BOOTSTRAP: join(
                        root,
                        'apps/worker/src/runtime/base-bootstrap.ts',
                    ),
                    BENTO_DSH_RUNTIME_CONFIG: config,
                    BENTO_REUSE_MODEL_URL: h.modelUrl,
                    BENTO_REUSE_TRACE: join(
                        h.fixture.directory,
                        'trace.ndjson',
                    ),
                },
            });
            const stop = pool.warmWorker(life.signal);
            try {
                assert.equal(
                    await pool.worker(
                        h.fixture.request(1),
                        new AbortController().signal,
                    ),
                    'completed',
                );
                history(h, h.fixture.request(0));
                history(h, h.fixture.request(1));
                const oldSession = h.fixture.request(0).binding.session;
                const after = Object.fromEntries(
                    Object.entries(rows(h)).map(([table, values]) => [
                        table,
                        values.filter((row) => row.id === oldSession),
                    ]),
                );
                assert(
                    isDeepStrictEqual(after, before),
                    'New Session changed completed Session rows',
                );
            } finally {
                life.abort();
                await stop();
            }
            await h.fixture.quiescent();
            assert.deepEqual(readWorkerProcesses(process.pid), []);
        } finally {
            await h.close();
        }
    },
);
