import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
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
                    'apps/orchestrator/acceptance/temporal-retry/control-proxy.mjs',
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
                    (
                        await request('choose', {
                            slots: 1,
                            occupied: [],
                            queued: [],
                        })
                    ).value,
                    '',
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
