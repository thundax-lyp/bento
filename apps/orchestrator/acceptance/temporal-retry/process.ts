import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
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
