import { executionWorker, type WorkerAttempt } from './execution-worker.ts';
import { executionCleanup } from './execution-cleanup.ts';
import { importProject } from './project-import.ts';
import { taskEventProjection } from './task-event-projection.ts';
import { trustedRunReview } from './trusted-run-review.ts';
import type { AdminDiagnostics } from './admin-diagnostics.ts';
import { mkdir, realpath } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import type { Http2Server } from 'node:http2';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { SingleHostExecution } from '../openshell/single-host.ts';
import { unifiedDiff } from './diff.ts';
import { executionHttp, RetryUnavailable } from './http.ts';
import { conflict, missing, textSnapshot } from './input.ts';
import { snapshotSha256 } from './snapshot.ts';
import { Store } from './store/index.ts';
import { taskRetryRecovery } from './task-retry-recovery.ts';
import { taskRunViews } from './task-run-view.ts';
import type { TemporalRunOptions, temporalRuns } from './temporal.ts';
import {
    executionBindingDigest,
    type Binding,
    type ExecutionHost,
    type FileText,
    type WorkerRequest,
    type WorkerResult,
} from './types.ts';

type Run = ReturnType<Store['findRun']>;
type Server = HttpServer | Http2Server;

export { snapshotSha256 } from './snapshot.ts';
type Options = {
    state: string;
    token: string;
    adminDiagnostics?: AdminDiagnostics;
    port?: number;
    bindHost?: '127.0.0.1' | '0.0.0.0';
    workerPort?: { persistence?: number; operation?: number; sdk?: number };
    workerTimeoutMs?: number;
    retryMs?: number;
    tenantQueueLimit?: number;
    requireTaskRunApproval?: boolean;
    host: ExecutionHost;
    temporal?: TemporalRunOptions;
    goControl?: string;
};

export async function serveExecution(options: Options) {
    const { host, token } = options;
    if (
        options.requireTaskRunApproval &&
        (!options.goControl || !options.temporal)
    )
        throw new Error('Task Run approval requires Go authority and Temporal');
    const sharedVolume = host.sharedVolume;
    const slots = host.workerSlots ?? 1;
    const supportsPhysicalStop = Boolean(
        host.sdk && host.observeWorkerExit && host.observeTaskVolumeStopped,
    );
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
    let draining = false;
    let closeWarmWorker: (() => Promise<void>) | undefined;
    let cleanup: ReturnType<typeof executionCleanup> | undefined;
    let scheduler: Awaited<ReturnType<typeof temporalRuns>> | undefined;
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
        await Promise.allSettled([...(cleanup?.pending() ?? [])]);
        await scheduler?.close();
        await closeWarmWorker?.();
        await Promise.all(closed);
        control?.close();
        store?.close();
        lock.close();
    }

    async function listen(server: Server, port = 0, bindHost = '127.0.0.1') {
        servers.push(server);
        server.on('connection', (socket: Socket) => {
            sockets.add(socket);
            socket.once('close', () => sockets.delete(socket));
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, bindHost, resolve);
        });
        const address = server.address();
        if (!address || typeof address === 'string')
            throw new Error('Listener unavailable');
        return 'http://127.0.0.1:' + address.port;
    }

    try {
        lock.exec('BEGIN IMMEDIATE');
        store = new Store(
            join(dir, 'business.sqlite'),
            tenantQueueLimit,
            options.goControl,
            options.requireTaskRunApproval,
        );
        control = new SingleHostExecution(
            {
                authority: join(dir, 'authority.sqlite'),
                history: join(dir, 'history.sqlite'),
                ...(options.goControl ? { goControl: options.goControl } : {}),
            },
            host,
        );
        const db = store;
        db.resumeRunAdmission();
        const execution = control;
        function runBinding(run: Run): Binding {
            const primary = db.binding(run);
            if (primary.session === run.sessionId) return primary;
            return checkedProjectSession({
                ...primary,
                session: run.sessionId,
            });
        }

        function checkedProjectSession(binding: Binding) {
            let current;
            try {
                current = execution.inspect(binding.session);
            } catch {
                throw missing();
            }
            if (
                current.tenant !== binding.tenant ||
                current.project !== binding.project ||
                current.volume !== binding.volume
            )
                throw missing();
            return { ...binding, sandbox: current.sandbox };
        }

        function ensureProjectRunIdle(project: string) {
            if (db.hasPendingProjectRun(project))
                throw conflict(
                    'project_busy',
                    'Project already has an unfinished Run.',
                );
        }

        const live = new Map<string, WorkerRequest['mode']>();
        const executing = new Map<string, WorkerAttempt>();
        // Authority resolves the token to its Session, Run and generation.
        // This map admits only grants dispatched by this controller.
        const canPersist = (grant: WorkerRequest['grant']) =>
            live.has(grant.token) &&
            db.findRun(grant.run).status !== 'cancelling';
        const canExecute = (grant: WorkerRequest['grant']) =>
            live.get(grant.token) === 'execute' &&
            db.findRun(grant.run).status !== 'cancelling';
        const persistenceUrl = await listen(
            execution.persistenceIngress(canPersist),
            options.workerPort?.persistence,
        );
        const projection = taskEventProjection(db, canExecute);
        const operationUrl = await listen(
            execution.operationIngress(canExecute, projection.acceptTaskEvents),
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

        function supportsCancellation(run: Run) {
            if (
                run.taskSequence !== null &&
                host.taskCancellationRequiresTrustedObservation === true
            )
                return host.supportsTaskRunningCancellation === true;

            return (
                host.supportsRunningCancellation === true ||
                (run.taskSequence !== null &&
                    host.supportsTaskRunningCancellation === true)
            );
        }

        function sameBinding(observation: Binding, binding: Binding) {
            return (
                executionBindingDigest(observation) ===
                executionBindingDigest(binding)
            );
        }

        function readyBinding(binding: Binding, generation: number) {
            const state = execution.inspect(binding.session);
            return (
                state.state === 'READY' &&
                state.run === null &&
                !state.hasCapability &&
                state.generation === generation &&
                sameBinding(state, binding)
            );
        }

        const {
            readProof,
            verifiedStopProof,
            advanceTaskRetry,
            verifyRestoredTask,
            advancingRetries,
        } = taskRetryRecovery({ db, execution, host, stop, readyBinding });

        const { retryReason, taskRunView } = taskRunViews({
            db,
            execution,
            host,
            readProof,
            supportsCancellation,
        });

        function requestCancellation(
            owner: string,
            project: string,
            id: string,
            task = false,
        ) {
            if (task) db.taskRunRow(owner, project, id);
            else db.run(owner, project, id);
            const run = db.findRun(id);
            if (run.cancelGeneration !== null)
                return db.requestRunningCancellation(
                    owner,
                    project,
                    id,
                    run.cancelGeneration,
                    task,
                );
            if (run.status !== 'running')
                return db.cancelQueuedRun(owner, project, id, task);

            const current = execution.inspect(run.sessionId);
            const worker = executing.get(id);
            const binding = runBinding(run);
            if (
                current.session !== binding.session ||
                current.tenant !== binding.tenant ||
                current.project !== binding.project ||
                current.sandbox !== binding.sandbox ||
                current.volume !== binding.volume
            )
                throw conflict(
                    'run_not_cancellable',
                    'The Run cannot be cancelled in its current state.',
                );
            let generation: number;
            if (
                current.state === 'READY' &&
                current.run === null &&
                !current.hasCapability
            ) {
                generation = 0;
            } else if (
                current.state === 'RUNNING' &&
                current.run === id &&
                supportsCancellation(run) &&
                worker?.generation === current.generation
            ) {
                generation = current.generation;
            } else {
                throw conflict(
                    'run_not_cancellable',
                    'The Run cannot be cancelled in its current state.',
                );
            }
            const intent = db.requestRunningCancellation(
                owner,
                project,
                id,
                generation,
                task,
            );
            if (worker?.generation === generation) {
                worker.abort.abort();
                if (worker.exitConfirmed)
                    db.markCancellationWorkerClosed(id, generation);
            }
            return intent;
        }

        async function fence(run: Run) {
            const current = execution.inspect(run.sessionId);
            if (current.state === 'READY') return;
            if (current.run !== run.id)
                throw new Error('Run does not own the execution slot');
            const generation = current.generation;
            await execution.takeover(run.sessionId, generation, async () => {
                if (
                    !supportsPhysicalStop ||
                    run.admittedGeneration !== generation ||
                    !execution.hasUnknownOperations(run.sessionId, generation)
                )
                    return;
                if (db.readPhysicalStopProof(run.id, generation)) return;
                const binding = runBinding(run);
                const bindingDigest = executionBindingDigest(binding);
                const exit = await taskExit(run, binding, generation);
                const observed = exit
                    ? await host.observeTaskVolumeStopped?.(
                          binding,
                          run.id,
                          generation,
                      )
                    : undefined;
                const observedAt = Date.parse(observed?.observedAt ?? '');
                if (
                    !exit ||
                    !observed ||
                    observed.runId !== run.id ||
                    observed.sessionId !== binding.session ||
                    observed.generation !== generation ||
                    observed.bindingDigest !== bindingDigest ||
                    observed.restoreIdle !== true ||
                    observed.volumeWriters !== 0 ||
                    observed.sandboxStopped !== true ||
                    !Number.isFinite(observedAt) ||
                    observedAt < Date.parse(exit.exitedAt) ||
                    observedAt > Date.now()
                )
                    throw new Error('Physical stop proof is unavailable');
                const proof = JSON.stringify({
                    runId: run.id,
                    sessionId: binding.session,
                    generation,
                    bindingDigest,
                    workerExitedAt: exit.exitedAt,
                    sandboxStopped: true,
                    volumeWriters: 0,
                    restoreIdle: true,
                    grantRevoked: true,
                    observedAt: observed.observedAt,
                });
                if (
                    !execution.persistPhysicalStopProof(
                        binding.session,
                        run.id,
                        generation,
                        proof,
                    )
                )
                    db.recordPhysicalStopProof(run.id, generation, proof);
            });
        }

        async function finish(run: Run) {
            try {
                const after = textSnapshot(
                    await host.snapshot(runBinding(run)),
                );
                const diff = await unifiedDiff(
                    textSnapshot(JSON.parse(run.baseline ?? 'null')),
                    after,
                );
                if (run.taskSequence === null)
                    db.status(run.id, 'succeeded', 'Run completed.', diff);
                else {
                    const initial = db.taskInitialFiles(run.projectId);
                    db.publishTaskResult(run.id, {
                        baselineSha256: snapshotSha256(
                            textSnapshot(JSON.parse(run.baseline ?? 'null')),
                        ),
                        initialSha256: snapshotSha256(initial),
                        afterSha256: snapshotSha256(after),
                        incremental: diff,
                        cumulative: await unifiedDiff(initial, after),
                    });
                }
            } catch {
                db.status(
                    run.id,
                    'needs_review',
                    'Result could not be captured. Capture will be retried.',
                );
            }
        }

        async function settle(
            run: Run,
            slot: number,
            activitySignal?: AbortSignal,
        ) {
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
            if (run.taskSequence !== null) {
                try {
                    if (await stopAndProve(run)) {
                        db.status(
                            run.id,
                            'failed',
                            'Run stopped before completion.',
                        );
                        return;
                    }
                } catch {
                    // Evidence mismatch cannot turn an ambiguous result into a failure.
                }
            }
            if (activitySignal?.aborted) {
                completeReview(
                    run,
                    'Temporal execution lease lost. Waiting for review.',
                );
            } else if (!run.reconciled) {
                // The attempt is durable before admission. A recovery worker is never given the original prompt.
                db.reconciled(run.id);
                let result: WorkerResult | undefined;
                try {
                    result = await worker(
                        run,
                        runBinding(run),
                        'recover',
                        slot,
                        activitySignal,
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
                completeReview(
                    run,
                    result === 'recovered'
                        ? 'Previous execution outcome is unknown. Waiting for review.'
                        : 'Recovery could not be confirmed. Waiting for review.',
                );
            } else {
                completeReview(
                    run,
                    'Recovery was interrupted. Waiting for review.',
                );
            }
        }

        function completeReview(run: Run, summary: string) {
            const generation = run.admittedGeneration;
            if (
                generation !== null &&
                (db.readPhysicalStopProof(run.id, generation) ||
                    (supportsPhysicalStop &&
                        execution.hasUnknownOperations(
                            run.sessionId,
                            generation,
                        )))
            ) {
                db.completeAmbiguousRecovery(run.id, generation, summary);
                return;
            }
            db.status(run.id, 'needs_review', summary);
        }

        async function driveCancellation(run: Run): Promise<void> {
            const generation = run.cancelGeneration;
            if (generation === null)
                throw new Error('Cancellation intent unavailable');
            const binding = runBinding(run);
            const current =
                generation === 0
                    ? execution.inspect(run.sessionId)
                    : await execution.takeover(run.sessionId, generation);
            stop.signal.throwIfAborted();
            if (
                current.state !== 'READY' ||
                current.run !== null ||
                current.hasCapability ||
                (generation !== 0 && current.generation !== generation + 1) ||
                current.session !== binding.session ||
                current.tenant !== binding.tenant ||
                current.project !== binding.project ||
                current.sandbox !== binding.sandbox ||
                current.volume !== binding.volume
            )
                throw new Error('Cancellation stop evidence unavailable');

            if (run.taskSequence !== null && generation !== 0) {
                if (!(await taskExit(run, binding, generation)))
                    throw new Error('Task Worker exit unconfirmed');
                let proven = false;
                try {
                    proven = await stopAndProve(run);
                } catch {
                    // An invalid or missing operation proof remains subject to review.
                }
                db.markCancellationWorkerClosed(run.id, generation);
                if (
                    !db.finishCancellation(
                        run.id,
                        generation,
                        proven ? 'cancelled' : 'needs_review',
                    )
                )
                    throw new Error('Task cancellation result changed');
                executing.delete(run.id);
                return;
            }
            const worker = executing.get(run.id);
            if (worker?.generation === generation && worker.exitConfirmed)
                db.markCancellationWorkerClosed(run.id, generation);
            if (!db.findRun(run.id).cancelWorkerClosed)
                throw new Error('Cancellation Worker exit unconfirmed');
            executing.delete(run.id);

            let unknown: boolean;
            try {
                unknown =
                    generation !== 0 &&
                    (host.sdk !== undefined ||
                        execution.hasUnknownOperations(
                            run.sessionId,
                            generation,
                        ));
                if (!unknown) {
                    const before = textSnapshot(
                        JSON.parse(run.baseline ?? 'null'),
                    );
                    const after = textSnapshot(await host.snapshot(binding));
                    unknown = snapshotSha256(before) !== snapshotSha256(after);
                }
            } catch {
                unknown = true;
            }
            stop.signal.throwIfAborted();
            if (
                !db.finishCancellation(
                    run.id,
                    generation,
                    unknown ? 'needs_review' : 'cancelled',
                )
            )
                throw new Error('Cancellation result changed');
        }

        async function driveRun(
            run: Run,
            slot: number,
            activitySignal?: AbortSignal,
        ) {
            if (run.status === 'cancelling') return driveCancellation(run);
            if (run.status === 'running' || run.status === 'recovering') {
                await settle(run, slot, activitySignal);
                return;
            }
            if (run.status !== 'queued') return;
            const queued = run;
            const binding = runBinding(queued);
            let before: FileText[];
            try {
                before = textSnapshot(await host.snapshot(binding));
                if (queued.taskSequence !== null) {
                    const generation = execution.inspect(
                        binding.session,
                    ).generation;
                    if (
                        queued.expectedGeneration !== null &&
                        generation !== queued.expectedGeneration
                    )
                        throw new Error('Queued Task generation changed');
                    const history = execution.checkpointHistory(
                        binding.session,
                        queued.id,
                        generation,
                    );
                    db.recordTaskCheckpoint(
                        queued.id,
                        before,
                        snapshotSha256(before),
                        history.sha256,
                    );
                }
            } catch {
                db.failQueuedBaseline(queued.id);
                return;
            }
            if (stop.signal.aborted) return;
            activitySignal?.throwIfAborted();
            if (!db.start(queued.id, before, slots)) {
                if (db.findRun(queued.id).status === 'cancelled') return;
                throw new Error('Execution host has pending recovery work');
            }
            try {
                if (
                    (await worker(
                        queued,
                        binding,
                        'execute',
                        slot,
                        activitySignal,
                    )) === 'completed'
                )
                    db.received(queued.id);
            } catch {
                // Worker failure is ambiguous once admission may have occurred.
            }
            if (stop.signal.aborted) return;
            const current = db.findRun(queued.id);
            if (current.status === 'cancelling')
                return driveCancellation(current);
            executing.delete(queued.id);
            await settle(current, slot, activitySignal);
        }

        const assigned = new Map<number, string>();
        cleanup = executionCleanup({
            db,
            execution,
            host,
            signal: stop.signal,
            currentScheduler: () => scheduler,
            isActive: () => active !== undefined,
            isAssigned: (run) => [...assigned.values()].includes(run),
        });
        const { advanceProjectDeletion, purgeOwner, purgeTaskSource } = cleanup;
        const {
            reviewRun,
            taskExit,
            stopAndProve,
            closeTaskRun,
            closeTaskRetry,
            reconcileTaskRetry,
        } = trustedRunReview({
            db,
            execution,
            host,
            signal: stop.signal,
            runBinding,
            readyBinding,
            readProof,
            isExecuting: (id) =>
                executing.has(id) || [...assigned.values()].includes(id),
            advancingRetries,
            verifiedStopProof,
            verifyRestoredTask,
            wake,
        });
        const worker = executionWorker({
            db,
            execution,
            host,
            live,
            executing,
            stopSignal: stop.signal,
            workerTimeoutMs,
            ingress,
            projection,
            supportsCancellation,
            taskExit,
            usesWarmWorker: () => closeWarmWorker !== undefined,
        });
        closeWarmWorker = host.warmWorker?.(stop.signal);
        if (options.temporal) {
            const { temporalRuns } = await import('./temporal.ts');
            scheduler = await temporalRuns(
                options.temporal,
                slots,
                async (runId, activitySignal) => {
                    stop.signal.throwIfAborted();
                    const run = db.findRun(runId);
                    if (draining && run.status === 'queued')
                        throw new Error('Execution host is draining');
                    if (
                        run.status === 'cancelled' ||
                        db.isProjectDeleting(run.projectId)
                    ) {
                        db.releaseRunSlot(runId);
                        return;
                    }
                    if (importing || [...assigned.values()].includes(runId))
                        throw new Error('Execution host is occupied');
                    const slot =
                        db.acquireRunSlot(runId, slots) ??
                        (assigned.has(0) ? 1 : 0);
                    if (slot === -1) {
                        if (
                            run.status === 'queued' ||
                            run.status === 'running' ||
                            run.status === 'recovering' ||
                            run.status === 'cancelling'
                        )
                            throw new Error('Run is waiting for dispatch');
                        return;
                    }
                    if (slot >= slots || assigned.has(slot))
                        throw new Error('Execution host is occupied');
                    assigned.set(slot, runId);
                    try {
                        // Keep the same slot through execution and recovery.
                        if (
                            run.status === 'queued' &&
                            !db.dispatchReserved(runId)
                        )
                            throw new Error('Run is waiting for dispatch');
                        await driveRun(run, slot, activitySignal);
                        stop.signal.throwIfAborted();
                    } finally {
                        assigned.delete(slot);
                        db.releaseRunSlot(runId);
                    }
                },
            );
        }
        let enqueued = new Set<string>();
        let retryCursor = 0;

        async function work() {
            if (sharedVolume) {
                await execution.resumeReclaims(sharedVolume);
                if (stop.signal.aborted) return;
            }
            // These Runs were fenced before capture failed. Retry the snapshot without another worker or Workflow.
            const capture = db.pendingCapture();
            if (capture) {
                await finish(capture);
                if (stop.signal.aborted) return;
            }
            if (scheduler) {
                // Reserve only available slots before publishing their Workflows.
                // SQLite retains the decisions if publication or the controller fails.
                for (let i = 0; !draining && i < slots; i++) {
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
                if (unfinished) return driveLocal(unfinished);
            }
            const attempt = db.nextTaskRetry(retryCursor);
            if (attempt) {
                retryCursor = attempt.rowId;
                await advanceTaskRetry(attempt);
                if (stop.signal.aborted) return;
            }
            const project = db.importing();
            if (project) {
                importing = true;
                try {
                    await importProject(db, host, execution, project);
                } finally {
                    importing = false;
                }
                return;
            }
            if (!scheduler && !draining) {
                const queued = db.next('queued');
                if (queued) await driveLocal(queued);
            }
        }

        async function driveLocal(run: Run) {
            if (options.goControl && run.status === 'queued')
                db.reserveDispatch(run.id, slots);
            const slot = db.acquireRunSlot(run.id, slots) ?? 0;
            if (slot < 0) throw new Error('Execution slot unavailable');
            try {
                await driveRun(run, slot);
            } finally {
                db.releaseRunSlot(run.id);
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

        function validateSharedRun(binding: Binding) {
            const target = checkedProjectSession(binding);
            if (!execution.sessionAvailable(target.session))
                throw conflict('session_not_ready', 'Session is not ready.');
            if (execution.hasVolumeWriter(target.volume))
                throw conflict(
                    'volume_busy',
                    'The volume already has a writer.',
                );
        }

        const url = await listen(
            executionHttp(
                db,
                token,
                wake,
                purgeOwner,
                requestCancellation,
                advanceProjectDeletion,
                {
                    environmentVersion: host.environmentVersion,
                    runView: taskRunView,
                    cancel(owner, taskId, runId) {
                        requestCancellation(owner, taskId, runId, true);
                        return taskRunView(db.taskRunRow(owner, taskId, runId));
                    },
                    retry(owner, taskId, runId, key) {
                        const run = db.taskRunRow(owner, taskId, runId);
                        const prior = db.taskRetryReceipt(taskId, key);
                        if (!prior) {
                            const reason = retryReason(run);
                            if (reason) throw new RetryUnavailable(reason);
                            try {
                                readProof(
                                    run,
                                    run.admittedGeneration!,
                                    run.admittedGeneration! + 1,
                                );
                            } catch {
                                throw new RetryUnavailable('stop_unconfirmed');
                            }
                        }
                        const checkpoint = db.taskCheckpoint(runId);
                        const { replay, attempt } = db.acceptTaskRetry(
                            owner,
                            taskId,
                            runId,
                            key,
                            {
                                oldGeneration: run.admittedGeneration ?? 0,
                                newGeneration:
                                    (run.admittedGeneration ?? 0) + 1,
                                workspaceSha256:
                                    checkpoint?.workspaceSha256 ?? '',
                                historySha256: checkpoint?.historySha256 ?? '',
                            },
                        );
                        return {
                            status: replay ? 200 : 202,
                            retry: {
                                id: attempt.id,
                                runId: attempt.newRunId,
                                state:
                                    attempt.phase === 'workspace_restored' ||
                                    attempt.phase === 'history_restored'
                                        ? 'preparing'
                                        : attempt.phase,
                            },
                        };
                    },
                    purgeSource: purgeTaskSource,
                },
                sharedVolume
                    ? (owner, project, key, prompt, sessionId) =>
                          db.addRun(
                              owner,
                              project,
                              key,
                              prompt,
                              sessionId,
                              validateSharedRun,
                          )
                    : undefined,
                options.adminDiagnostics,
                sharedVolume ? validateSharedRun : undefined,
            ),
            options.port,
            options.bindHost,
        );
        wake();
        const sharedGrants = new Map<string, string>();
        return {
            url,
            close,
            async drain() {
                db.beginRunDrain();
                draining = true;
                while (active || assigned.size || !db.consumeUpgradeStops()) {
                    stop.signal.throwIfAborted();
                    await delay(retryMs, undefined, { signal: stop.signal });
                }
            },
            sharedSessions: sharedVolume && {
                projectBinding: (owner: string, project: string) =>
                    db.sharedProjectBinding(owner, project),
                attach(source: Binding, target: Binding) {
                    const project = db.sharedProjectBinding(
                        source.tenant,
                        source.project,
                    );
                    if (project.volume !== source.volume) throw missing();
                    return execution.attach(source, target, sharedVolume);
                },
                rebuild(binding: Binding) {
                    ensureProjectRunIdle(binding.project);
                    return execution.rebuild(binding, sharedVolume);
                },
                async revoke(binding: Binding) {
                    ensureProjectRunIdle(binding.project);
                    const result = await execution.revoke(binding);
                    sharedGrants.delete(binding.session);
                    return result;
                },
                async release(binding: Binding) {
                    ensureProjectRunIdle(binding.project);
                    const result = await execution.release(
                        binding,
                        sharedVolume,
                    );
                    sharedGrants.delete(binding.session);
                    return result;
                },
                inspect: (session: string) => execution.inspect(session),
                admit(session: string, generation: number, run: string) {
                    ensureProjectRunIdle(execution.inspect(session).project);
                    const grant = execution.admit(
                        session,
                        generation,
                        run,
                        workerTimeoutMs,
                    );
                    sharedGrants.set(session, grant.token);
                    return grant;
                },
                finish(session: string, generation: number) {
                    const current = execution.inspect(session);
                    if (current.generation === generation)
                        sharedGrants.delete(session);
                    return execution.takeover(session, generation);
                },
                ingress() {
                    if (!host.sdk) throw new Error('SDK ingress unavailable');
                    return execution.sdkIngress(
                        host.sdk,
                        (grant) =>
                            sharedGrants.get(grant.session) === grant.token,
                    );
                },
            },
            reviewRun,
            closeTaskRun,
            closeTaskRetry,
            reconcileTaskRetry,
            listPendingRunReviews: () => db.listPendingRunReviews(),
            readTaskClosure: (id: string) => db.readTaskClosure(id),
            readTaskRetryClosure: (id: string) =>
                db.readTaskRetryClosure(id) ?? null,
        };
    } catch (error) {
        await close();
        throw error;
    }
}
