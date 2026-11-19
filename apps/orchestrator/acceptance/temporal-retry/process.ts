import type { HostConfig } from './host.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { TemporalTool } from './tool.ts';

export const root = fileURLToPath(new URL('../../../../', import.meta.url));
type Exit = { code: number | null; signal: NodeJS.Signals | null };
export type OwnedProcess = { child: ChildProcess; closed: Promise<Exit> };
const closed = new WeakSet<ChildProcess>();

export function own(
    command: string,
    args: readonly string[],
    options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        log: string;
        ipc: boolean;
    },
): OwnedProcess {
    const fd = openSync(options.log, 'w', 0o600);
    const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: options.ipc
            ? ['pipe', 'pipe', 'pipe', 'ipc']
            : ['pipe', 'pipe', 'pipe'],
    });
    child.on('error', () => {});
    child.stdin?.on('error', () => {});
    child.stdout?.on('data', (chunk: Buffer) => writeSync(fd, chunk));
    child.stderr?.on('data', (chunk: Buffer) => writeSync(fd, chunk));
    return {
        child,
        closed: new Promise((resolve) => {
            child.once('close', (code, signal) => {
                closed.add(child);
                closeSync(fd);
                resolve({ code, signal });
            });
        }),
    };
}

async function within<T>(
    promise: Promise<T>,
    ms: number,
): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<undefined>((resolve) => {
                timer = setTimeout(() => resolve(undefined), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

export async function stopOwned(owned: OwnedProcess, graceMs: number) {
    if (closed.has(owned.child))
        return { forced: false, ...(await owned.closed) };
    if (!owned.child.kill('SIGINT') && !closed.has(owned.child)) {
        const exited = await within(owned.closed, 5000);
        if (exited) return { forced: false, ...exited };
        throw new Error('Could not signal owned process');
    }
    const normal = await within(owned.closed, graceMs);
    if (normal) return { forced: false, ...normal };
    if (!owned.child.kill('SIGKILL') && !closed.has(owned.child))
        throw new Error('Could not kill owned process');
    const forced = await within(owned.closed, 5000);
    if (!forced) throw new Error('Owned process did not close after SIGKILL');
    return { forced: true, ...forced };
}

export async function runCommand(
    command: string,
    args: readonly string[],
    options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        timeoutMs: number;
        signal: AbortSignal;
        input: string | null;
    },
): Promise<{ stdout: string; stderr: string }> {
    options.signal.throwIfAborted();
    const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
        stderr = '',
        failure: Error | undefined;
    const owned: OwnedProcess = {
        child,
        closed: new Promise((resolve) => {
            child.once('close', (code, signal) => {
                closed.add(child);
                resolve({ code, signal });
            });
        }),
    };
    let stopping: Promise<unknown> | undefined;
    let rejectStop!: (error: unknown) => void;
    const stopFailure = new Promise<never>((_, reject) => {
        rejectStop = reject;
    });
    const fail = (error: Error) => {
        failure ??= error;
        stopping ??= stopOwned(owned, 2000);
        void stopping.catch(rejectStop);
    };
    child.once('error', () =>
        fail(new Error('Acceptance command could not start')),
    );
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (Buffer.byteLength(stdout) > 8 * 1024 * 1024)
            fail(new Error('Acceptance command output limit'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (Buffer.byteLength(stderr) > 8 * 1024 * 1024)
            fail(new Error('Acceptance command output limit'));
    });
    const abort = () => fail(new Error('Acceptance command aborted'));
    options.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
        () => fail(new Error('Acceptance command timed out')),
        options.timeoutMs,
    );
    child.stdin.end(options.input ?? undefined);
    try {
        const result = await Promise.race([owned.closed, stopFailure]);
        if (stopping) await stopping;
        if (failure) throw failure;
        if (result.code !== 0)
            throw new Error(
                `Acceptance command failed (${result.code ?? result.signal})`,
            );
        return { stdout, stderr };
    } finally {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', abort);
    }
}

export async function freePort() {
    const server = createServer();
    await new Promise<void>((resolve, reject) =>
        server.once('error', reject).listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('Port allocation failed');
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
    return address.port;
}

export async function assertPortClosed(port: number) {
    await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port });
        socket.once('connect', () => {
            socket.destroy();
            reject(new Error('Acceptance listener remains'));
        });
        socket.once('error', (error: NodeJS.ErrnoException) => {
            socket.destroy();
            if (error.code === 'ECONNREFUSED') resolve();
            else reject(error);
        });
        socket.setTimeout(1000, () => {
            socket.destroy();
            reject(new Error('Port close probe timed out'));
        });
    });
}

export type TemporalServer = {
    address: string;
    namespace: string;
    port: number;
    directory: string;
    process: OwnedProcess;
    close: () => Promise<void>;
};
export async function startServer(
    tool: TemporalTool,
    directory: string,
    identity: {
        port: number;
        namespace: string;
        createNamespace: boolean;
    },
    signal: AbortSignal,
): Promise<TemporalServer> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const envFile = join(directory, 'env.yaml');
    await writeFile(envFile, '{}\n', { mode: 0o600 });
    const env = { ...process.env };
    for (const key of Object.keys(env))
        if (/^(TEMPORAL_|BENTO_TEMPORAL_)/.test(key)) delete env[key];
    const base = [
        '--disable-config-env',
        '--disable-config-file',
        '--env-file',
        envFile,
    ];
    const address = '127.0.0.1:' + identity.port;
    const owned = own(
        tool.binary,
        [
            ...base,
            'server',
            'start-dev',
            '--ip',
            '127.0.0.1',
            '--port',
            String(identity.port),
            '--headless',
            '--db-filename',
            join(directory, 'temporal.sqlite'),
            ...(identity.createNamespace
                ? ['--namespace', identity.namespace]
                : []),
        ],
        {
            cwd: root,
            env,
            log: join(
                directory,
                identity.createNamespace ? 'first.log' : 'reopen.log',
            ),
            ipc: false,
        },
    );
    let closing: Promise<void> | undefined;
    const close = () =>
        (closing ??= (async () => {
            const result = await stopOwned(owned, 15000);
            await assertPortClosed(identity.port);
            if (result.forced || result.code !== 0)
                throw new Error('Temporal server did not close normally');
        })());
    try {
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
            signal.throwIfAborted();
            if (closed.has(owned.child))
                throw new Error('Temporal server exited before readiness');
            try {
                const args = [
                    ...base,
                    '--address',
                    address,
                    '--identity',
                    'bento-a6-probe',
                    '--command-timeout',
                    '5s',
                    '--client-connect-timeout',
                    '3s',
                ];
                await runCommand(
                    tool.binary,
                    [...args, 'operator', 'cluster', 'health'],
                    { cwd: root, env, timeoutMs: 8000, signal, input: null },
                );
                const result = await runCommand(
                    tool.binary,
                    [
                        ...args,
                        'operator',
                        'namespace',
                        'describe',
                        '--namespace',
                        identity.namespace,
                        '--output',
                        'json',
                    ],
                    { cwd: root, env, timeoutMs: 8000, signal, input: null },
                );
                if (
                    !JSON.stringify(JSON.parse(result.stdout)).includes(
                        identity.namespace,
                    )
                )
                    throw new Error('Namespace absent');
                return {
                    address,
                    namespace: identity.namespace,
                    port: identity.port,
                    directory,
                    process: owned,
                    close,
                };
            } catch {
                signal.throwIfAborted();
            }
            await delay(500, undefined, { signal });
        }
        throw new Error('Temporal server readiness exceeded 60 seconds');
    } catch (error) {
        try {
            await close();
        } catch (cleanup) {
            throw new AggregateError(
                [error, cleanup],
                'Temporal startup and cleanup failed',
                { cause: cleanup },
            );
        }
        throw error;
    }
}

export async function atomicJson(path: string, value: unknown) {
    const temporary = path + '.tmp';
    await writeFile(temporary, JSON.stringify(value), {
        mode: 0o600,
        flush: true,
    });
    await rename(temporary, path);
}

export async function readMarker(
    directory: string,
    name: string,
    signal: AbortSignal,
    timeoutMs = 5000,
): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        signal.throwIfAborted();
        try {
            return JSON.parse(
                await readFile(join(directory, name), 'utf8'),
            ) as Record<string, unknown>;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await delay(20, undefined, { signal });
    }
    throw new Error('Acceptance marker timed out: ' + name);
}

export async function buildControl(
    directory: string,
    signal: AbortSignal,
): Promise<string> {
    const control = join(directory, 'bento-orchestrator');
    await runCommand('go', ['build', '-mod=readonly', '-o', control, '.'], {
        cwd: join(root, 'apps/orchestrator'),
        env: process.env,
        timeoutMs: 120000,
        signal,
        input: null,
    });
    return control;
}

export type ControlTransport = {
    socketPath: string;
    process: OwnedProcess;
    close: () => Promise<void>;
};
export async function startControlTransport(
    controlBinary: string,
    directory: string,
    signal: AbortSignal,
): Promise<ControlTransport> {
    signal.throwIfAborted();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const socketPath = join(directory, 'c.sock');
    if (Buffer.byteLength(socketPath) >= 100)
        throw new Error('Control socket path exceeds fixed limit');
    let socket: import('node:net').Socket | undefined;
    let backgroundError: unknown;
    const listener = createServer((client) => {
        if (socket) {
            client.destroy();
            backgroundError = new Error('Duplicate control socket client');
            return;
        }
        socket = client;
        for (const chunk of buffered) client.write(chunk);
        buffered.length = 0;
        client.on('data', (chunk) => {
            if (!owned.child.stdin!.destroyed) owned.child.stdin!.write(chunk);
        });
        client.on('end', () => {
            void close().catch((error) => {
                backgroundError = error;
            });
        });
        client.on('error', () => {
            void close().catch((error) => {
                backgroundError = error;
            });
        });
    });
    const buffered: Buffer[] = [];
    await new Promise<void>((resolve, reject) =>
        listener.once('error', reject).listen(socketPath, resolve),
    );
    await chmod(socketPath, 0o600);
    const owned = own(controlBinary, ['temporal'], {
        cwd: join(root, 'apps/orchestrator'),
        env: process.env,
        log: join(directory, 'go.log'),
        ipc: false,
    });
    let reason: 'normal' | 'shutdown' | 'spawn-error' = 'normal';
    owned.child.stdout!.on('data', (chunk: Buffer) => {
        if (socket) socket.write(chunk);
        else {
            buffered.push(chunk);
            if (
                buffered.reduce((sum, b) => sum + b.length, 0) >
                8 * 1024 * 1024
            ) {
                backgroundError = new Error('Control buffer exceeded limit');
                void close().catch(() => {});
            }
        }
    });
    const finished = owned.closed.then(async (exit) => {
        let dropped = false;
        try {
            dropped =
                JSON.parse(
                    await readFile(join(directory, 'drop-ready.json'), 'utf8'),
                ).discarded === true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (owned.child.pid === undefined) reason = 'spawn-error';
        await atomicJson(join(directory, 'control-closed.json'), {
            schema: 1,
            ...exit,
            reason: dropped && exit.signal === 'SIGKILL' ? 'dropped' : reason,
            closed: true,
        });
        socket?.end();
        const stopped = new Promise<void>((resolve, reject) =>
            listener.close((error) => (error ? reject(error) : resolve())),
        );
        if (
            !(await within(
                stopped.then(() => true),
                5000,
            ))
        ) {
            socket?.destroy();
            if (
                !(await within(
                    stopped.then(() => true),
                    5000,
                ))
            )
                throw new Error('Control socket listener did not close');
        }
    });
    void finished.catch(() => {});
    let closing: Promise<void> | undefined;
    const close = () =>
        (closing ??= (async () => {
            if (!closed.has(owned.child)) {
                reason = 'shutdown';
                owned.child.stdin!.end();
                if (!(await within(owned.closed, 5000))) {
                    if (
                        !owned.child.kill('SIGKILL') &&
                        !closed.has(owned.child)
                    )
                        throw new Error('Could not kill owned Go control');
                    if (!(await within(owned.closed, 5000)))
                        throw new Error('Go control failed to close');
                    await finished;
                    throw new Error('Go control required forced shutdown');
                }
            }
            await finished;
            if (backgroundError) throw backgroundError;
        })());
    try {
        await new Promise<void>((resolve, reject) => {
            owned.child.once('spawn', resolve);
            owned.child.once('error', reject);
        });
    } catch (error) {
        await close();
        throw new Error('Go control could not spawn', { cause: error });
    }
    return { socketPath, process: owned, close };
}

export async function buildBinaries(
    directory: string,
    signal: AbortSignal,
): Promise<{ control: string; probe: string }> {
    const control = await buildControl(directory, signal);
    const probe = join(directory, 'temporal-probe');
    await runCommand(
        'go',
        [
            'build',
            '-mod=readonly',
            '-o',
            probe,
            './acceptance/temporal-retry/probe',
        ],
        {
            cwd: join(root, 'apps/orchestrator'),
            env: process.env,
            timeoutMs: 120000,
            signal,
            input: null,
        },
    );
    return { control, probe };
}

export type HostProcess = {
    url: string;
    directory: string;
    process: OwnedProcess;
    control: ControlTransport;
    dropControl: () => Promise<void>;
    close: () => Promise<void>;
};
export async function startHost(
    config: HostConfig,
    signal: AbortSignal,
): Promise<HostProcess> {
    const control = await startControlTransport(
        config.controlBinary,
        config.proxyDirectory,
        signal,
    );
    const configPath = join(config.proxyDirectory, 'host-config.json');
    await atomicJson(configPath, config);
    const owned = own(
        process.execPath,
        [
            '--import',
            join(root, 'register-paths.mjs'),
            '--experimental-strip-types',
            join(root, 'apps/orchestrator/acceptance/temporal-retry/host.ts'),
            configPath,
        ],
        {
            cwd: root,
            env: { ...process.env },
            log: join(config.proxyDirectory, 'host.log'),
            ipc: true,
        },
    );
    let closing: Promise<void> | undefined;
    const close = () =>
        (closing ??= (async () => {
            let failed = false;
            if (!closed.has(owned.child) && owned.child.connected)
                owned.child.send({ type: 'close' });
            let exit = await within(owned.closed, 25000);
            if (!exit) {
                failed = true;
                await control.close();
                await within(owned.closed, 5000);
                const stopped = await stopOwned(owned, 0);
                exit = stopped;
            }
            await control.close();
            if (failed || exit.code !== 0)
                throw new Error('Acceptance host did not close normally');
            await readMarker(
                config.proxyDirectory,
                'proxy-closed.json',
                AbortSignal.timeout(5000),
            );
        })());
    try {
        const url = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error('Acceptance host readiness timeout')),
                25000,
            );
            const message = (value: unknown) => {
                const m = value as { type?: string; url?: string };
                if (m.type === 'ready' && typeof m.url === 'string') {
                    clearTimeout(timer);
                    owned.child.off('message', message);
                    resolve(m.url);
                } else if (m.type === 'error') {
                    clearTimeout(timer);
                    owned.child.off('message', message);
                    reject(new Error('Acceptance host failed to start'));
                }
            };
            owned.child.on('message', message);
            void owned.closed.then(() => {
                clearTimeout(timer);
                owned.child.off('message', message);
                reject(new Error('Acceptance host closed before readiness'));
            });
        });
        return {
            url,
            directory: config.proxyDirectory,
            process: owned,
            control,
            close,
            async dropControl() {
                await atomicJson(join(config.proxyDirectory, 'command.json'), {
                    schema: 1,
                    command: 'drop',
                });
                const ready = await readMarker(
                    config.proxyDirectory,
                    'drop-ready.json',
                    signal,
                );
                if (ready.discarded !== true)
                    throw new Error('Proxy did not discard held response');
                if (!control.process.child.kill('SIGKILL'))
                    throw new Error('Could not inject owned Go control death');
                const exit = await within(control.process.closed, 5000);
                if (!exit || exit.signal !== 'SIGKILL')
                    throw new Error('Dropped control death not observed');
                await readMarker(
                    config.proxyDirectory,
                    'control-closed.json',
                    signal,
                );
                await readMarker(
                    config.proxyDirectory,
                    'proxy-closed.json',
                    signal,
                );
            },
        };
    } catch (error) {
        try {
            await close();
        } catch (cleanup) {
            throw new AggregateError(
                [error, cleanup],
                'Host startup and cleanup failed',
                { cause: cleanup },
            );
        }
        throw error;
    }
}
