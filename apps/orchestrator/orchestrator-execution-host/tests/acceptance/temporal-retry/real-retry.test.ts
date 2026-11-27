import { Store } from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/store/index.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { snapshotSha256 } from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/service.ts';
import {
    captureBusiness,
    assertOriginal,
    assertTemporal,
    sha256,
    type TemporalEvidence,
} from './evidence.ts';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
    mkdir,
    mkdtemp,
    rm,
    stat,
    chmod,
    copyFile,
    readFile,
    realpath,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { acquireTemporal, type TemporalTool } from './tool.ts';
import {
    own,
    stopOwned,
    freePort,
    startServer,
    root,
    buildControl,
    buildBinaries,
    runCommand,
    startHost,
    startControlTransport,
    atomicJson,
    readMarker,
} from './process.ts';

let suite: string;
let tool: TemporalTool;
before(
    async () => {
        suite = await mkdtemp('/tmp/bento-a6-tools-');
        tool = await acquireTemporal(suite, AbortSignal.timeout(540000));
    },
    { timeout: 540000 },
);
after(async () => {
    if (suite) await rm(suite, { recursive: true, force: true });
});

test(
    'A6 tool: verified CLI and persistent server lifecycle',
    { timeout: 180000 },
    async (t) => {
        const directory = await mkdtemp('/tmp/bento-a6-');
        const port = await freePort(),
            namespace = 'bento-a6-' + randomUUID();
        let server: Awaited<ReturnType<typeof startServer>> | undefined;
        let removable = true;
        try {
            server = await startServer(
                tool,
                directory,
                { port, namespace, createNamespace: true },
                t.signal,
            );
            assert((await stat(join(directory, 'temporal.sqlite'))).size > 0);
            await server.close();
            server = undefined;
            server = await startServer(
                tool,
                directory,
                { port, namespace, createNamespace: false },
                t.signal,
            );
            await server.close();
            server = undefined;
        } catch (error) {
            removable = !(error instanceof AggregateError);
            throw error;
        } finally {
            if (server) await server.close();
            if (removable)
                await rm(directory, { recursive: true, force: true });
        }
        await assert.rejects(stat(directory), { code: 'ENOENT' });
    },
);

test(
    'A6 dispatch: committed reservation and lost publication reply recover one Workflow',
    { timeout: 120000 },
    async (t) => {
        const directory = await mkdtemp('/tmp/bento-a6-dispatch-');
        let server: Awaited<ReturnType<typeof startServer>> | undefined;
        try {
            const namespace = 'bento-a6-' + randomUUID();
            server = await startServer(
                tool,
                directory,
                { port: await freePort(), namespace, createNamespace: true },
                t.signal,
            );
            const result = await runCommand(
                'go',
                [
                    'test',
                    '-mod=readonly',
                    '-count=1',
                    '-v',
                    '-run',
                    '^TestDispatchPublishAgainstTemporal$',
                    './src/control',
                ],
                {
                    cwd: join(root, 'apps/orchestrator/orchestrator-control'),
                    env: {
                        ...process.env,
                        BENTO_TEST_DISPATCH_TEMPORAL_ADDRESS: server.address,
                        BENTO_TEST_DISPATCH_TEMPORAL_NAMESPACE: namespace,
                    },
                    timeoutMs: 90000,
                    signal: t.signal,
                    input: null,
                },
            );
            assert.match(
                result.stdout,
                /^--- PASS: TestDispatchPublishAgainstTemporal /m,
            );
        } finally {
            await server?.close();
            await rm(directory, { recursive: true, force: true });
        }
    },
);

test(
    'A6 cleanup: managed process timeout and spawn failure',
    { timeout: 15000 },
    async () => {
        const directory = await mkdtemp('/tmp/bento-a6-');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const child = own(
            process.execPath,
            [
                '-e',
                "process.on('SIGINT',()=>{});console.log('ready');setInterval(()=>{},1000)",
            ],
            {
                cwd: root,
                env: process.env,
                log: join(directory, 'ignore.log'),
                ipc: false,
            },
        );
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(new Error('Inline child readiness timeout')),
                    3000,
                );
                child.child.stdout!.once('data', () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
            const result = await stopOwned(child, 100);
            assert.equal(result.forced, true);
            assert.equal(result.signal, 'SIGKILL');
            const missing = own(join(directory, 'nonexistent'), [], {
                cwd: root,
                env: process.env,
                log: join(directory, 'missing.log'),
                ipc: false,
            });
            const exit = await missing.closed;
            assert.notEqual(exit.code, 0);
        } finally {
            await stopOwned(child, 100);
            await rm(directory, { recursive: true, force: true });
        }
        await assert.rejects(stat(directory), { code: 'ENOENT' });
    },
);

let controlBuild: Promise<string> | undefined;
function controlBinary(signal: AbortSignal) {
    return (controlBuild ??= buildControl(suite, signal));
}

async function proxyCase(shutdown: boolean, signal: AbortSignal) {
    const directory = await mkdtemp('/tmp/bento-a6-');
    const businessPath = join(directory, 'business.sqlite');
    new Store(businessPath).close();
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let transport:
        Awaited<ReturnType<typeof startControlTransport>> | undefined;
    let proxy: ReturnType<typeof own> | undefined;
    let failure: unknown;
    try {
        const port = await freePort(),
            namespace = 'bento-a6-' + randomUUID();
        server = await startServer(
            tool,
            join(directory, 'server'),
            { port, namespace, createNamespace: true },
            signal,
        );
        const path = join(directory, 'proxy');
        transport = await startControlTransport(
            await controlBinary(signal),
            path,
            signal,
        );
        await atomicJson(join(path, 'config.json'), {
            schema: 1,
            socketPath: transport.socketPath,
            directory: path,
            mode: 'pass',
        });
        proxy = own(
            process.execPath,
            [
                join(
                    root,
                    'apps/orchestrator/orchestrator-execution-host/tests/acceptance/temporal-retry/control-proxy.mjs',
                ),
            ],
            {
                cwd: root,
                env: {
                    ...process.env,
                    BENTO_A6_PROXY_CONFIG: join(path, 'config.json'),
                },
                log: join(path, 'proxy.log'),
                ipc: false,
            },
        );
        const waiting = new Map<
            string,
            {
                resolve: (value: Record<string, unknown>) => void;
                reject: (error: Error) => void;
            }
        >();
        const lines = createInterface({ input: proxy.child.stdout! });
        lines.on('line', (line) => {
            const frame = JSON.parse(line) as Record<string, unknown>;
            waiting.get(String(frame.id))?.resolve(frame);
        });
        let sequence = 0;
        async function request(method: string, value: unknown) {
            const id = 'host-' + ++sequence;
            let timer: NodeJS.Timeout | undefined;
            const response = new Promise<Record<string, unknown>>(
                (resolve, reject) => {
                    waiting.set(id, { resolve, reject });
                    timer = setTimeout(
                        () => reject(new Error('Proxy request timeout')),
                        10000,
                    );
                },
            );
            proxy!.child.stdin!.write(
                JSON.stringify({ id, method, value }) + '\n',
            );
            try {
                const result = await response;
                assert.equal(result.error, undefined);
                return result;
            } finally {
                clearTimeout(timer);
                waiting.delete(id);
            }
        }
        try {
            assert.equal(
                (
                    await request('start', {
                        address: server.address,
                        namespace,
                        taskQueue:
                            'bento_a6_' + randomUUID().replaceAll('-', ''),
                        slots: 1,
                        businessPath,
                    })
                ).value,
                null,
            );
            if (shutdown)
                await atomicJson(join(path, 'command.json'), {
                    schema: 1,
                    command: 'shutdown',
                });
            else {
                assert.equal(
                    (await request('purge', randomUUID())).value,
                    true,
                );
                const response = await request('close', null);
                assert.equal(response.value, null);
                assert.equal(
                    (await readMarker(path, 'control-closed.json', signal))
                        .closed,
                    true,
                );
            }
            const exit = await proxy.closed;
            assert.equal(exit.code, 0);
            assert.equal(
                (await readMarker(path, 'proxy-closed.json', signal))
                    .controlClosed,
                true,
            );
            const controlExit = await transport.process.closed;
            assert.equal(controlExit.code, 0);
        } finally {
            lines.close();
        }
        await transport.close();
        transport = undefined;
        if (shutdown) {
            const missing = join(directory, 'missing');
            await assert.rejects(
                startControlTransport(
                    join(directory, 'no-binary'),
                    missing,
                    signal,
                ),
                /could not spawn/,
            );
            const marker = await readMarker(
                missing,
                'control-closed.json',
                signal,
            );
            assert.equal(marker.reason, 'spawn-error');
            assert.equal(marker.closed, true);
        }
    } catch (error) {
        failure = error;
    }
    const cleanup: unknown[] = [];
    if (transport)
        try {
            await transport.close();
        } catch (error) {
            cleanup.push(error);
        }
    if (proxy)
        try {
            await stopOwned(proxy, 1000);
        } catch (error) {
            cleanup.push(error);
        }
    if (server)
        try {
            await server.close();
        } catch (error) {
            cleanup.push(error);
        }
    if (!cleanup.length) await rm(directory, { recursive: true, force: true });
    if (failure || cleanup.length)
        throw new AggregateError(
            [...(failure ? [failure] : []), ...cleanup],
            'Proxy case failed',
            { cause: failure ?? cleanup[0] },
        );
    await assert.rejects(stat(directory), { code: 'ENOENT' });
}

test(
    'A6 proxy: production control closes before proxy acknowledgement',
    { timeout: 120000 },
    async (t) => proxyCase(false, t.signal),
);
test(
    'A6 cleanup: proxy shutdown reaps production control',
    { timeout: 120000 },
    async (t) => proxyCase(true, t.signal),
);

let binariesBuild: Promise<{ control: string; probe: string }> | undefined;
function binaries(signal: AbortSignal) {
    return (binariesBuild ??= buildBinaries(suite, signal));
}

test(
    'A6 evidence: missing workflow is a hard failure',
    { timeout: 120000 },
    async (t) => {
        const directory = await mkdtemp('/tmp/bento-a6-');
        let server: Awaited<ReturnType<typeof startServer>> | undefined;
        try {
            const port = await freePort(),
                namespace = 'bento-a6-' + randomUUID();
            server = await startServer(
                tool,
                directory,
                { port, namespace, createNamespace: true },
                t.signal,
            );
            const probe = (await binaries(t.signal)).probe;
            const history = join(directory, 'missing-history.json');
            const owned = own(
                probe,
                [
                    '--address',
                    server.address,
                    '--namespace',
                    namespace,
                    '--workflow',
                    'bento-run-' + randomUUID(),
                    '--execution',
                    '',
                    '--history-out',
                    history,
                ],
                {
                    cwd: root,
                    env: process.env,
                    log: join(directory, 'missing-probe.log'),
                    ipc: false,
                },
            );
            let stdout = '',
                stderr = '';
            owned.child.stdout!.on(
                'data',
                (bytes: Buffer) => (stdout += bytes.toString()),
            );
            owned.child.stderr!.on(
                'data',
                (bytes: Buffer) => (stderr += bytes.toString()),
            );
            const timer = setTimeout(() => {
                void stopOwned(owned, 0).catch(() => {});
            }, 10000);
            try {
                const result = await owned.closed;
                assert.equal(result.code, 1);
                assert.equal(stdout, '');
                assert.match(
                    stderr,
                    /Temporal evidence probe failed: workflow_not_found/,
                );
            } finally {
                clearTimeout(timer);
                await stopOwned(owned, 100);
            }
            await assert.rejects(stat(history), { code: 'ENOENT' });
        } finally {
            if (server) await server.close();
            await rm(directory, { recursive: true, force: true });
        }
    },
);

async function poll<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    timeoutMs: number,
    signal: AbortSignal,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        signal.throwIfAborted();
        const value = await read();
        if (done(value)) return value;
        await delay(50, undefined, { signal });
    }
    throw new Error('Acceptance observation deadline exceeded');
}
async function runScenario(
    kind: 'happy' | 'lost-host' | 'lost-server-host',
    t: TestContext,
): Promise<void> {
    const retried = kind !== 'happy';
    const directory = await mkdtemp('/tmp/bento-a6-');
    const state = join(directory, 'state'),
        volume = join(directory, 'volume');
    const port = await freePort(),
        namespace = 'bento-a6-' + randomUUID(),
        queue = 'bento_a6_' + randomUUID().replaceAll('-', '');
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    let failure: unknown;
    let report: Record<string, unknown> | undefined;
    const cleanups: unknown[] = [];
    let cleaning: Promise<void> | undefined;
    const cleanup = () =>
        (cleaning ??= (async () => {
            if (host)
                try {
                    await host.close();
                } catch (error) {
                    cleanups.push(error);
                }
            if (server)
                try {
                    await server.close();
                } catch (error) {
                    cleanups.push(error);
                }
            if (!cleanups.length)
                await rm(directory, { recursive: true, force: true });
        })());
    t.after(cleanup);
    try {
        const built = await binaries(t.signal);
        server = await startServer(
            tool,
            join(directory, 'server'),
            { port, namespace, createNamespace: true },
            t.signal,
        );
        host = await startHost(
            {
                schema: 1,
                state,
                volume,
                proxyDirectory: join(directory, 'h1'),
                controlBinary: built.control,
                address: server.address,
                namespace,
                taskQueue: queue,
                mode: retried ? 'drop' : 'pass',
            },
            t.signal,
        );
        const api = async (
            path: string,
            method = 'GET',
            body?: unknown,
            key?: string,
        ) => {
            const response = await fetch(host!.url + '/v1' + path, {
                method,
                headers: {
                    authorization:
                        'Bearer fixture-only-bento-a6-service-bearer',
                    'x-bento-owner-id': 'account-a',
                    ...(body === undefined
                        ? {}
                        : { 'content-type': 'application/json' }),
                    ...(key ? { 'idempotency-key': key } : {}),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.any([t.signal, AbortSignal.timeout(5000)]),
            });
            const text = await response.text();
            return {
                status: response.status,
                text,
                body: response.headers
                    .get('content-type')
                    ?.includes('application/json')
                    ? (JSON.parse(text) as Record<string, unknown>)
                    : {},
            };
        };
        const taskId = randomUUID(),
            fileId = randomUUID(),
            createKey = randomUUID(),
            runKey = randomUUID();
        const input = [{ path: 'README.md', text: '# Fixture\n' }];
        const created = await api(
            '/tasks',
            'POST',
            {
                id: taskId,
                name: 'A6 Temporal Task',
                sourceSpaceId: randomUUID(),
                inputFiles: input,
                inputManifest: [
                    {
                        fileId,
                        path: 'README.md',
                        bytes: Buffer.byteLength(input[0]!.text),
                        sha256: sha256(input[0]!.text),
                    },
                ],
                inputDigest: snapshotSha256(input),
            },
            createKey,
        );
        assert.equal(created.status, 202, created.text);
        assert.equal((created.body.task as Record<string, unknown>).id, taskId);
        await poll(
            () => api('/tasks/' + taskId),
            (response) =>
                (response.body.task as Record<string, unknown>).status ===
                'ready',
            15000,
            t.signal,
        );
        const prompt =
            (kind === 'lost-server-host'
                ? 'a6-lost-server-host-'
                : retried
                  ? 'a6-lost-host-'
                  : 'a6-happy-') + randomUUID();
        const accepted = await api(
            '/tasks/' + taskId + '/runs',
            'POST',
            { prompt },
            runKey,
        );
        assert.equal(accepted.status, 202, accepted.text);
        const runId = String((accepted.body.run as Record<string, unknown>).id),
            runPath = '/tasks/' + taskId + '/runs/' + runId;
        await poll(
            () => api(runPath),
            (response) =>
                (response.body.run as Record<string, unknown>).status ===
                'succeeded',
            30000,
            t.signal,
        );
        const observe = async (
            executionId: string,
            name: string,
        ): Promise<TemporalEvidence> => {
            const result = await runCommand(
                built.probe,
                [
                    '--address',
                    server!.address,
                    '--namespace',
                    namespace,
                    '--workflow',
                    'bento-run-' + runId,
                    '--execution',
                    executionId,
                    '--history-out',
                    join(directory, name),
                ],
                {
                    cwd: root,
                    env: process.env,
                    timeoutMs: 10000,
                    signal: t.signal,
                    input: null,
                },
            );
            return JSON.parse(result.stdout) as TemporalEvidence;
        };
        let first: TemporalEvidence;
        let before: Awaited<ReturnType<typeof captureBusiness>> | undefined;
        if (retried) {
            const held = await readMarker(
                join(directory, 'h1'),
                'held.json',
                t.signal,
                30000,
            );
            assert.equal(held.runId, runId);
            before = await captureBusiness(state, volume, taskId, runId);
            first = await observe('', 'first-history.json');
            assert.equal(first.status, 'running');
            assert.equal(first.workflowCompleted, 0);
            assert.equal(first.completed.length, 0);
            assert.equal(first.workflowStarted, 1);
            assert.equal(first.workflowId, 'bento-run-' + runId);
            assert.equal(first.workflowType, 'bentoRun');
            assert.equal(first.taskQueue, queue);
            assert.deepEqual(first.workflowInput, { count: 1, runId });
            assert.equal(first.scheduled.length, 1);
            assert.equal(first.scheduled[0]!.activityType, 'advanceRun');
            assert.equal(first.scheduled[0]!.taskQueue, queue);
            assert.deepEqual(first.scheduled[0]!.input, { count: 1, runId });
            assert.equal(first.pending.length, 1);
            assert.equal(first.pending[0]!.attempt, 1);
            assert.equal(first.pending[0]!.started, true);
            const initialEvents = (
                await readFile(join(directory, 'h1', 'events.ndjson'), 'utf8')
            )
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as Record<string, unknown>);
            assert.equal(
                initialEvents.filter((e) => e.event === 'advance').length,
                1,
            );
            assert.equal(
                initialEvents.filter((e) => e.event === 'reply-held').length,
                1,
            );
            assert.equal(
                initialEvents.filter((e) => e.event === 'reply-forwarded')
                    .length,
                0,
            );
            await host.dropControl();
            const stopped = await readMarker(
                join(directory, 'h1'),
                'control-closed.json',
                t.signal,
            );
            assert.equal(stopped.reason, 'dropped');
            assert.equal(stopped.signal, 'SIGKILL');
            await host.close();
            host = undefined;
            const dropped = await observe(
                first.executionRunId,
                'after-drop-history.json',
            );
            assert.equal(dropped.status, 'running');
            assert.equal(dropped.completed.length, 0);
            if (kind === 'lost-server-host') {
                await server.close();
                server = undefined;
                server = await startServer(
                    tool,
                    join(directory, 'server'),
                    { port, namespace, createNamespace: false },
                    t.signal,
                );
            }
            host = await startHost(
                {
                    schema: 1,
                    state,
                    volume,
                    proxyDirectory: join(directory, 'h2'),
                    controlBinary: built.control,
                    address: server.address,
                    namespace,
                    taskQueue: queue,
                    mode: 'pass',
                },
                t.signal,
            );
        } else first = await observe('', 'first-history.json');
        const final = await poll(
            () => observe(first.executionRunId, 'final-history.json'),
            (e) => e.status === 'completed',
            retried ? 60000 : 30000,
            t.signal,
        );
        assertTemporal(final, {
            runId,
            queue,
            executionId: first.executionRunId,
            retried,
        });
        before ??= await captureBusiness(state, volume, taskId, runId);
        const result = JSON.parse(String(before.results[0]!.body)) as Record<
            string,
            unknown
        >;
        for (const view of ['incremental', 'cumulative']) {
            const diff = await api(runPath + '/results/1/diff?view=' + view);
            assert.equal(diff.status, 200);
            assert.equal(diff.text, result[view]);
        }
        const replay = await api(
            '/tasks/' + taskId + '/runs',
            'POST',
            { prompt },
            runKey,
        );
        assert.equal(replay.status, 200, replay.text);
        assert.equal((replay.body.run as Record<string, unknown>).id, runId);
        const after = await captureBusiness(state, volume, taskId, runId);
        assertOriginal(before, after);
        const replayHistory = await observe(
            first.executionRunId,
            'replay-history.json',
        );
        assertTemporal(replayHistory, {
            runId,
            queue,
            executionId: first.executionRunId,
            retried,
        });
        const eventSets = await Promise.all(
            (retried ? ['h1', 'h2'] : ['h1']).map(async (name) =>
                (await readFile(join(directory, name, 'events.ndjson'), 'utf8'))
                    .trim()
                    .split('\n')
                    .map((line) => JSON.parse(line) as Record<string, unknown>),
            ),
        );
        const events = eventSets.flat();
        assert.equal(
            events.filter((e) => e.event === 'advance').length,
            retried ? 2 : 1,
        );
        assert.equal(
            events.filter((e) => e.event === 'reply-forwarded').length,
            1,
        );
        if (retried) {
            assert.equal(
                eventSets[1]!.filter((e) => e.event === 'advance').length,
                1,
            );
            assert.equal(
                eventSets[1]!.filter((e) => e.event === 'reply-forwarded')
                    .length,
                1,
            );
        }
        const head = (
            await runCommand('git', ['rev-parse', 'HEAD'], {
                cwd: root,
                env: process.env,
                timeoutMs: 5000,
                signal: t.signal,
                input: null,
            })
        ).stdout.trim();
        report = {
            schema: 1,
            case: kind,
            head,
            cliVersion: '1.5.1',
            serverVersion: '1.29.1',
            workflowId: final.workflowId,
            executionRunId: final.executionRunId,
            activityAttempt: final.started.at(-1)!.attempt,
            workerExecutions: 1,
            receiptSha256: sha256(before.receiptBytes),
            workspaceSha256: sha256(before.workspaceText),
            sqlBeforeSha256: sha256(JSON.stringify(before)),
            sqlAfterSha256: sha256(JSON.stringify(after)),
            historySha256: replayHistory.historySha256,
        };
        const evidenceDir = process.env.BENTO_A6_EVIDENCE_DIR;
        if (evidenceDir !== undefined) {
            assert(isAbsolute(evidenceDir));
            assert(
                relative(await realpath(root), resolve(evidenceDir)).startsWith(
                    '../',
                ),
            );
            const out = join(evidenceDir, kind);
            await mkdir(out, { recursive: true, mode: 0o700 });
            for (const [name, value] of [
                ['before.json', JSON.stringify(before)],
                ['after.json', JSON.stringify(after)],
                ['before-temporal.json', JSON.stringify(first)],
                ['after-temporal.json', JSON.stringify(replayHistory)],
                ['write-receipt.json', before.receiptBytes],
                ['exit-receipt.json', before.exitBytes],
                [
                    'proxy-events.ndjson',
                    events.map((e) => JSON.stringify(e)).join('\n'),
                ],
            ])
                await writeFile(join(out, name!), value!, { mode: 0o600 });
            await copyFile(
                join(directory, 'replay-history.json'),
                join(out, 'history.json'),
            );
            await chmod(join(out, 'history.json'), 0o600);
        }
    } catch (error) {
        failure = error;
    }
    await cleanup();
    if (failure && !cleanups.length) throw failure;
    if (failure || cleanups.length)
        throw new AggregateError(
            [...(failure ? [failure] : []), ...cleanups],
            'Real Temporal scenario failed',
            { cause: failure ?? cleanups[0] },
        );
    assert(report);
    await assert.rejects(stat(directory), { code: 'ENOENT' });
    const complete = {
        ...report,
        passed: true,
        cleanup: {
            hostClosed: true,
            controlClosed: true,
            serverClosed: true,
            directoryRemoved: true,
        },
    };
    if (process.env.BENTO_A6_EVIDENCE_DIR)
        await writeFile(
            join(process.env.BENTO_A6_EVIDENCE_DIR, kind, 'report.json'),
            JSON.stringify(complete, null, 2),
            { mode: 0o600 },
        );
    console.log(JSON.stringify(complete));
}

test(
    'A6-02 happy path uses real Temporal and one durable effect',
    { timeout: 180000 },
    async (t) => runScenario('happy', t),
);

test(
    'A6-02 lost reply reuses receipt across host restart',
    { timeout: 180000 },
    async (t) => runScenario('lost-host', t),
);

test(
    'A6-02 lost reply reuses receipt across server and host restart',
    { timeout: 240000 },
    async (t) => runScenario('lost-server-host', t),
);

test(
    'A6 cleanup: failed case closes host control and server',
    { timeout: 120000 },
    async (t) => {
        const directory = await mkdtemp('/tmp/bento-a6-');
        let server: Awaited<ReturnType<typeof startServer>> | undefined;
        let host: Awaited<ReturnType<typeof startHost>> | undefined;
        let cleaning: Promise<void> | undefined;
        const failures: unknown[] = [],
            exits: (number | null)[] = [];
        const cleanup = () =>
            (cleaning ??= (async () => {
                if (host)
                    try {
                        await host.close();
                        exits.push(
                            (await host.process.closed).code,
                            (await host.control.process.closed).code,
                        );
                    } catch (error) {
                        failures.push(error);
                    }
                if (server)
                    try {
                        await server.close();
                        exits.push((await server.process.closed).code);
                    } catch (error) {
                        failures.push(error);
                    }
                if (!failures.length)
                    await rm(directory, { recursive: true, force: true });
            })());
        t.after(cleanup);
        const injected = new Error('Injected acceptance cleanup failure');
        const inner = async () => {
            let original: unknown;
            try {
                const built = await binaries(t.signal),
                    port = await freePort(),
                    namespace = 'bento-a6-' + randomUUID();
                server = await startServer(
                    tool,
                    join(directory, 'server'),
                    { port, namespace, createNamespace: true },
                    t.signal,
                );
                host = await startHost(
                    {
                        schema: 1,
                        state: join(directory, 'state'),
                        volume: join(directory, 'volume'),
                        proxyDirectory: join(directory, 'h1'),
                        controlBinary: built.control,
                        address: server.address,
                        namespace,
                        taskQueue:
                            'bento_a6_' + randomUUID().replaceAll('-', ''),
                        mode: 'pass',
                    },
                    t.signal,
                );
                throw injected;
            } catch (error) {
                original = error;
            } finally {
                await cleanup();
            }
            if (failures.length)
                throw new AggregateError(
                    [original, ...failures],
                    'Injected case cleanup failed',
                    { cause: original },
                );
            throw original;
        };
        await assert.rejects(inner(), (error) => error === injected);
        assert.deepEqual(exits, [0, 0, 0]);
        await assert.rejects(stat(directory), { code: 'ENOENT' });
    },
);
