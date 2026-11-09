import { mkdir, realpath } from 'node:fs/promises';
import type { Http2Server } from 'node:http2';
import type { Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SingleHostExecution } from '../openshell/single-host.ts';
import { unifiedDiff } from './diff.ts';
import { executionHttp } from './http.ts';
import { textSnapshot } from './input.ts';
import { projectBinding, Store } from './store.ts';
import type {
    Binding,
    ExecutionHost,
    FileText,
    WorkerRequest,
    WorkerResult,
} from './types.ts';

type Run = ReturnType<Store['findRun']>;
type Server = HttpServer | Http2Server;
type Options = {
    state: string;
    token: string;
    port?: number;
    workerPort?: { persistence?: number; operation?: number; sdk?: number };
    workerTimeoutMs?: number;
    retryMs?: number;
    host: ExecutionHost;
};

export async function serveExecution(options: Options) {
    const { host, token } = options;
    const workerTimeoutMs = options.workerTimeoutMs ?? 120_000;
    const retryMs = options.retryMs ?? 500;
    if (!/^[!-~]{16,1024}$/.test(token))
        throw new Error('Service bearer is invalid');
    if (
        !Number.isSafeInteger(workerTimeoutMs) ||
        workerTimeoutMs < 1 ||
        workerTimeoutMs > 3_600_000
    )
        throw new Error('Worker timeout is invalid');
    await mkdir(options.state, { recursive: true, mode: 0o700 });
    const dir = await realpath(options.state);
    // The kernel releases this SQLite write lock when a controller dies.
    const lock = new DatabaseSync(join(dir, 'controller-lock.sqlite'));
    const sockets = new Set<Socket>();
    const servers: Server[] = [];
    const stop = new AbortController();
    let store: Store | undefined;
    let control: SingleHostExecution | undefined;
    let scheduled: NodeJS.Timeout | undefined;
    let active: Promise<void> | undefined;

    async function close() {
        if (stop.signal.aborted) return;
        stop.abort();
        clearTimeout(scheduled);
        const closed = servers.map(
            (server) =>
                new Promise<void>((resolve) => server.close(() => resolve())),
        );
        for (const socket of sockets) socket.destroy();
        await active;
        await Promise.all(closed);
        control?.close();
        store?.close();
        lock.close();
    }

    async function listen(server: Server, port = 0) {
        servers.push(server);
        server.on('connection', (socket: Socket) => {
            sockets.add(socket);
            socket.once('close', () => sockets.delete(socket));
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, '127.0.0.1', resolve);
        });
        const address = server.address();
        if (!address || typeof address === 'string')
            throw new Error('Listener unavailable');
        return 'http://127.0.0.1:' + address.port;
    }

    try {
        lock.exec('BEGIN IMMEDIATE');
        store = new Store(join(dir, 'business.sqlite'));
        control = new SingleHostExecution(
            {
                authority: join(dir, 'authority.sqlite'),
                history: join(dir, 'history.sqlite'),
            },
            host,
        );
        const db = store;
        const execution = control;
        let live:
            | { grant: WorkerRequest['grant']; mode: WorkerRequest['mode'] }
            | undefined;
        // Only a worker dispatched by this process is active. On restart an
        // old token is unusable even before takeover reaches the authority DB.
        const canPersist = (grant: WorkerRequest['grant']) =>
            live?.grant.token === grant.token;
        const canExecute = (grant: WorkerRequest['grant']) =>
            live?.mode === 'execute' && canPersist(grant);
        const persistenceUrl = await listen(
            execution.persistenceIngress(canPersist),
            options.workerPort?.persistence,
        );
        const operationUrl = await listen(
            execution.operationIngress(canExecute),
            options.workerPort?.operation,
        );
        const gateway = host.sdk
            ? await listen(
                  execution.sdkIngress(host.sdk, canExecute),
                  options.workerPort?.sdk,
              )
            : undefined;
        const ingress = {
            persistenceUrl,
            operationUrl,
            ...(gateway === undefined ? {} : { gateway }),
        };

        async function worker(
            run: Run,
            binding: Binding,
            mode: WorkerRequest['mode'],
        ) {
            const current = execution.inspect(binding.session);
            const grant = execution.admit(
                binding.session,
                current.generation,
                run.id,
                workerTimeoutMs,
            );
            live = { grant, mode };
            const signal = AbortSignal.any([
                stop.signal,
                AbortSignal.timeout(workerTimeoutMs),
            ]);
            let onAbort: () => void = () => {};
            const aborted = new Promise<never>((_resolve, reject) => {
                onAbort = () => reject(new Error('Worker lease ended'));
                signal.addEventListener('abort', onAbort, { once: true });
            });
            try {
                signal.throwIfAborted();
                return await Promise.race([
                    host.worker(
                        {
                            mode,
                            binding,
                            grant,
                            ...ingress,
                            ...(mode === 'execute'
                                ? { prompt: run.prompt }
                                : {}),
                        },
                        signal,
                    ),
                    aborted,
                ]);
            } finally {
                live = undefined;
                signal.removeEventListener('abort', onAbort);
            }
        }

        async function fence(run: Run) {
            const current = execution.inspect(run.sessionId);
            if (current.state === 'READY') return;
            if (current.run !== run.id)
                throw new Error('Run does not own the execution slot');
            await execution.takeover(run.sessionId, current.generation);
        }

        async function finish(run: Run) {
            try {
                const after = textSnapshot(
                    await host.snapshot(db.binding(run)),
                );
                const diff = await unifiedDiff(
                    textSnapshot(JSON.parse(run.baseline ?? 'null')),
                    after,
                );
                db.status(run.id, 'succeeded', 'Run completed.', diff);
            } catch {
                db.status(
                    run.id,
                    'needs_review',
                    'Result could not be captured. Waiting for review.',
                );
            }
        }

        async function settle(run: Run) {
            if (!run.receipt && run.status !== 'recovering')
                db.status(
                    run.id,
                    'recovering',
                    'Recovering the execution session.',
                );
            await fence(run);
            if (stop.signal.aborted) return;
            if (run.receipt) {
                await finish(run);
                return;
            }
            if (!run.reconciled) {
                // The attempt is durable before admission. A recovery worker is never given the original prompt.
                db.reconciled(run.id);
                let result: WorkerResult | undefined;
                try {
                    result = await worker(run, db.binding(run), 'recover');
                } catch {
                    // The prior operation and any interrupted reconciliation stay subject to trusted review.
                }
                if (stop.signal.aborted) return;
                await fence(run);
                db.status(
                    run.id,
                    'needs_review',
                    result === 'recovered'
                        ? 'Previous execution outcome is unknown. Waiting for review.'
                        : 'Recovery could not be confirmed. Waiting for review.',
                );
            } else {
                db.status(
                    run.id,
                    'needs_review',
                    'Recovery was interrupted. Waiting for review.',
                );
            }
        }

        async function work() {
            const unfinished = db.next('active');
            if (unfinished) {
                await settle(unfinished);
                return;
            }
            const project = db.importing();
            if (project) {
                const binding = projectBinding(project);
                try {
                    const files = textSnapshot(
                        JSON.parse(project.source ?? 'null'),
                    );
                    const observation = await host.provision(binding, files);
                    const imported = textSnapshot(await host.snapshot(binding));
                    if (JSON.stringify(imported) !== JSON.stringify(files))
                        throw new Error('Imported snapshot differs');
                    try {
                        execution.bind(binding, observation);
                    } catch (error) {
                        // An earlier process may have bound the project before committing its business state.
                        const existing = execution.inspect(binding.session);
                        if (
                            existing.state !== 'READY' ||
                            existing.generation !== 1 ||
                            !observation.installed ||
                            !observation.running ||
                            observation.sandbox !== binding.sandbox ||
                            observation.volume !== binding.volume ||
                            Object.entries(binding).some(
                                ([key, value]) =>
                                    existing[key as keyof Binding] !== value,
                            )
                        )
                            throw error;
                    }
                    db.importResult(project.id, 'ready');
                } catch {
                    db.importResult(project.id, 'failed');
                }
                return;
            }
            const queued = db.next('queued');
            if (!queued) return;
            const binding = db.binding(queued);
            let before: FileText[];
            try {
                before = textSnapshot(await host.snapshot(binding));
            } catch {
                db.status(
                    queued.id,
                    'failed',
                    'Workspace baseline could not be captured.',
                );
                return;
            }
            if (stop.signal.aborted) return;
            db.start(queued.id, before);
            try {
                if ((await worker(queued, binding, 'execute')) === 'completed')
                    db.received(queued.id);
            } catch {
                // Worker failure is ambiguous once admission may have occurred.
            }
            if (!stop.signal.aborted) await settle(db.findRun(queued.id));
        }

        function wake(delay = 0) {
            if (active || stop.signal.aborted) return;
            clearTimeout(scheduled);
            scheduled = setTimeout(() => {
                active = work()
                    .catch(() => {
                        // Leave the active row blocking the host until stop/start can be observed.
                    })
                    .finally(() => {
                        active = undefined;
                        wake(retryMs);
                    });
            }, delay);
        }

        const url = await listen(executionHttp(db, token, wake), options.port);
        wake();
        return { url, close };
    } catch (error) {
        await close();
        throw error;
    }
}
