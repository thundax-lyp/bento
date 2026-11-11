import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import type { Http2Server } from 'node:http2';
import type { Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SingleHostExecution } from '../openshell/single-host.ts';
import { unifiedDiff } from './diff.ts';
import { executionHttp } from './http.ts';
import { conflict, textSnapshot } from './input.ts';
import { projectBinding, Store } from './store.ts';
import type { TemporalRunOptions, temporalRuns } from './temporal.ts';
import type {
    Binding,
    ExecutionHost,
    FileText,
    WorkerRequest,
    WorkerResult,
} from './types.ts';
import { operationId } from './worker.ts';

type Run = ReturnType<Store['findRun']>;
type Server = HttpServer | Http2Server;
type Review = {
    runId: string;
    failedGeneration: number;
    readyGeneration: number;
    stableOperationId: string;
    expectedSnapshotSha256: string;
};

export function snapshotSha256(files: readonly FileText[]) {
    return createHash('sha256')
        .update(JSON.stringify(textSnapshot(files)))
        .digest('hex');
}
type Options = {
    state: string;
    token: string;
    port?: number;
    workerPort?: { persistence?: number; operation?: number; sdk?: number };
    workerTimeoutMs?: number;
    retryMs?: number;
    tenantQueueLimit?: number;
    host: ExecutionHost;
    temporal?: TemporalRunOptions;
};

export async function serveExecution(options: Options) {
    const { host, token } = options;
    const slots = host.workerSlots ?? 1;
    if (slots !== 1 && (slots !== 2 || !host.warmWorker || !options.temporal))
        throw new Error(
            'Two worker slots require Temporal and a warm worker pool',
        );
    const workerTimeoutMs = options.workerTimeoutMs ?? 120_000;
    const retryMs = options.retryMs ?? 500;
    const tenantQueueLimit = options.tenantQueueLimit ?? 16;
    if (!Number.isSafeInteger(tenantQueueLimit) || tenantQueueLimit < 1)
        throw new Error('Tenant queue limit must be a positive integer');
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
    let importing = false;
    let closeWarmWorker: (() => Promise<void>) | undefined;
    let scheduler: Awaited<ReturnType<typeof temporalRuns>> | undefined;
    const purges = new Map<string, Promise<boolean>>();

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
        await Promise.allSettled(purges.values());
        await scheduler?.close();
        await closeWarmWorker?.();
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
        store = new Store(join(dir, 'business.sqlite'), tenantQueueLimit);
        control = new SingleHostExecution(
            {
                authority: join(dir, 'authority.sqlite'),
                history: join(dir, 'history.sqlite'),
            },
            host,
        );
        const db = store;
        const execution = control;
        const live = new Map<string, WorkerRequest['mode']>();
        // Authority resolves the token to its Session, Run and generation.
        // This map admits only grants dispatched by this controller.
        const canPersist = (grant: WorkerRequest['grant']) =>
            live.has(grant.token);
        const canExecute = (grant: WorkerRequest['grant']) =>
            live.get(grant.token) === 'execute';
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

        // Trusted deployment API. No HTTP v1 route exposes this capability.
        async function reviewRun(review: Review) {
            const {
                runId,
                failedGeneration,
                readyGeneration,
                stableOperationId,
                expectedSnapshotSha256,
            } = review;
            if (
                !Number.isSafeInteger(failedGeneration) ||
                failedGeneration < 1 ||
                !Number.isSafeInteger(readyGeneration) ||
                readyGeneration <= failedGeneration ||
                typeof stableOperationId !== 'string' ||
                !stableOperationId ||
                !/^[0-9a-f]{64}$/.test(expectedSnapshotSha256)
            )
                throw new Error('Invalid review proof');
            const op = operationId(runId, stableOperationId);
            const proof = JSON.stringify({
                failedGeneration,
                readyGeneration,
                operationId: op,
                expectedSnapshotSha256,
            });
            if (db.reviewReceipt(runId, proof)) return;
            const run = db.findRun(runId);
            if (
                run.status !== 'needs_review' ||
                run.receipt ||
                db.recoveryGeneration(runId) !== failedGeneration + 1 ||
                readyGeneration !== failedGeneration + 2
            )
                throw conflict(
                    'review_unavailable',
                    'Run is not awaiting recovery review.',
                );
            const binding = db.binding(run);
            const checkBinding = () => {
                const current = execution.inspect(run.sessionId);
                if (
                    current.state !== 'READY' ||
                    current.generation !== readyGeneration ||
                    current.volume !== binding.volume ||
                    current.sandbox !== binding.sandbox ||
                    current.project !== binding.project ||
                    current.tenant !== binding.tenant ||
                    execution.operation(run.sessionId, failedGeneration, op)
                        ?.state !== 'UNKNOWN'
                )
                    throw conflict(
                        'review_unavailable',
                        'Run execution or operation evidence changed.',
                    );
            };
            checkBinding();
            const after = textSnapshot(await host.snapshot(binding));
            if (snapshotSha256(after) !== expectedSnapshotSha256)
                throw conflict(
                    'review_mismatch',
                    'Workspace does not match the reviewed snapshot.',
                );
            const diff = await unifiedDiff(
                textSnapshot(JSON.parse(run.baseline ?? 'null')),
                after,
            );
            stop.signal.throwIfAborted();
            if (db.reviewReceipt(runId, proof)) return;
            checkBinding();
            db.confirmReview(runId, proof, diff);
        }

        async function worker(
            run: Run,
            binding: Binding,
            mode: WorkerRequest['mode'],
            slot: number,
        ) {
            const current = execution.inspect(binding.session);
            const grant = execution.admit(
                binding.session,
                current.generation,
                run.id,
                workerTimeoutMs,
            );
            live.set(grant.token, mode);
            const signal = AbortSignal.any([
                stop.signal,
                AbortSignal.timeout(workerTimeoutMs),
            ]);
            let onAbort: () => void = () => {};
            const aborted = new Promise<never>((_resolve, reject) => {
                onAbort = () => reject(new Error('Worker lease ended'));
                signal.addEventListener('abort', onAbort, { once: true });
            });
            let task: Promise<WorkerResult> | undefined;
            try {
                signal.throwIfAborted();
                task = host.worker(
                    {
                        mode,
                        binding,
                        grant,
                        ...ingress,
                        ...(mode === 'execute' ? { prompt: run.prompt } : {}),
                    },
                    signal,
                    slot,
                );
                return await Promise.race([task, aborted]);
            } finally {
                live.delete(grant.token);
                signal.removeEventListener('abort', onAbort);
                // A replacement must wait for the single slot to close on lease expiry.
                if (closeWarmWorker && signal.aborted)
                    await task?.catch(() => {});
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
                    'Result could not be captured. Capture will be retried.',
                );
            }
        }

        async function settle(run: Run, slot: number) {
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
                    result = await worker(
                        run,
                        db.binding(run),
                        'recover',
                        slot,
                    );
                } catch {
                    // The prior operation and any interrupted reconciliation stay subject to trusted review.
                }
                if (stop.signal.aborted) return;
                if (result === 'recovered')
                    db.recovered(
                        run.id,
                        execution.inspect(run.sessionId).generation,
                    );
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

        async function importProject(
            project: NonNullable<ReturnType<Store['importing']>>,
        ) {
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
        }

        async function driveRun(run: Run, slot: number) {
            if (run.status === 'running' || run.status === 'recovering') {
                await settle(run, slot);
                return;
            }
            if (run.status !== 'queued') return;
            const queued = run;
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
            if (!db.start(queued.id, before, slots))
                throw new Error('Execution host has pending recovery work');
            try {
                if (
                    (await worker(queued, binding, 'execute', slot)) ===
                    'completed'
                )
                    db.received(queued.id);
            } catch {
                // Worker failure is ambiguous once admission may have occurred.
            }
            if (!stop.signal.aborted) await settle(db.findRun(queued.id), slot);
        }

        const assigned = new Map<number, string>();
        closeWarmWorker = host.warmWorker?.(stop.signal);
        if (options.temporal) {
            const { temporalRuns } = await import('./temporal.ts');
            scheduler = await temporalRuns(
                options.temporal,
                slots,
                async (runId) => {
                    stop.signal.throwIfAborted();
                    if (importing || [...assigned.values()].includes(runId))
                        throw new Error('Execution host is occupied');
                    const slot = assigned.has(0) ? 1 : 0;
                    if (slot >= slots || assigned.has(slot))
                        throw new Error('Execution host is occupied');
                    assigned.set(slot, runId);
                    try {
                        // Keep the same slot through execution and recovery.
                        const run = db.findRun(runId);
                        if (
                            run.status === 'queued' &&
                            !db.dispatchReserved(runId)
                        )
                            throw new Error('Run is waiting for dispatch');
                        await driveRun(run, slot);
                        stop.signal.throwIfAborted();
                    } finally {
                        assigned.delete(slot);
                    }
                },
            );
        }
        let enqueued = new Set<string>();

        async function work() {
            // These Runs were fenced before capture failed. Retry the snapshot without another worker or Workflow.
            const capture = db.pendingCapture();
            if (capture) {
                await finish(capture);
                if (stop.signal.aborted) return;
            }
            if (scheduler) {
                // Reserve only available slots before publishing their Workflows.
                // SQLite retains the decisions if publication or the controller fails.
                for (let i = 0; i < slots; i++) {
                    const snapshot = db.dispatchSnapshot(slots);
                    if (!snapshot.queued.length) break;
                    let selected: string;
                    try {
                        selected = await scheduler.choose(snapshot);
                    } catch {
                        break;
                    }
                    if (stop.signal.aborted) return;
                    if (!selected) break;
                    // An Activity or HTTP request may have changed the queue
                    // while Go was choosing a candidate.
                    if (
                        JSON.stringify(db.dispatchSnapshot(slots)) !==
                        JSON.stringify(snapshot)
                    )
                        break;
                    if (!db.reserveDispatch(selected, slots)) break;
                }
                const pending = db.schedulableRuns();
                const previous = enqueued;
                enqueued = new Set(pending.filter((id) => previous.has(id)));
                for (const id of pending) {
                    if (stop.signal.aborted) return;
                    if (!enqueued.has(id)) {
                        try {
                            await scheduler.enqueue(id);
                        } catch {
                            // Keep the reservation and retry in order on the next tick.
                            break;
                        }
                        enqueued.add(id);
                    }
                }
                // The publisher can run while a Temporal Activity occupies the host.
                if (stop.signal.aborted || assigned.size) return;
            } else {
                const unfinished = db.next('active');
                if (unfinished) return driveRun(unfinished, 0);
            }
            const project = db.importing();
            if (project) {
                importing = true;
                try {
                    await importProject(project);
                } finally {
                    importing = false;
                }
                return;
            }
            if (!scheduler) {
                const queued = db.next('queued');
                if (queued) await driveRun(queued, 0);
            }
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

        function purgeOwner(owner: string) {
            const existing = purges.get(owner);
            if (existing) return existing;
            stop.signal.throwIfAborted();
            db.drainOwner(owner);
            const task = (async () => {
                if ((scheduler && active) || !db.ownerDrained(owner))
                    return false;
                const bindings = db.ownerBindings(owner);
                for (const binding of bindings) {
                    const runs = db.projectRunIds(binding.project);
                    if (
                        runs.some((run) => [...assigned.values()].includes(run))
                    )
                        return false;
                    if (scheduler) {
                        let settled = true;
                        for (const run of runs)
                            if (!(await scheduler.purgeClosed(run)))
                                settled = false;
                        if (!settled) return false;
                    }
                    if (!host.purge)
                        throw new Error(
                            'Execution host cleanup is unavailable',
                        );
                    await execution.purge(binding, host.purge.bind(host));
                    db.purgeProject(binding);
                }
                return true;
            })().finally(() => purges.delete(owner));
            purges.set(owner, task);
            return task;
        }

        const url = await listen(
            executionHttp(db, token, wake, purgeOwner),
            options.port,
        );
        wake();
        return { url, close, reviewRun };
    } catch (error) {
        await close();
        throw error;
    }
}
