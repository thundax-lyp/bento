import { operationId, publicTaskEventBatch } from '@/apps/worker/protocol.ts';
import { mkdir, realpath } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import type { Http2Server } from 'node:http2';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SingleHostExecution } from '../openshell/single-host.ts';
import { unifiedDiff } from './diff.ts';
import { executionHttp, RetryUnavailable } from './http.ts';
import { conflict, textSnapshot } from './input.ts';
import { snapshotSha256 } from './snapshot.ts';
import { projectBinding, Store, type ProjectDeletionReceipt } from './store.ts';
import { taskRetryRecovery } from './task-retry-recovery.ts';
import { taskRunViews } from './task-run-view.ts';
import type { TemporalRunOptions, temporalRuns } from './temporal.ts';
import {
    executionBindingDigest,
    sha256Digest,
    type Binding,
    type ExecutionHost,
    type FileText,
    type WorkerRequest,
    type WorkerResult,
} from './types.ts';

type Run = ReturnType<Store['findRun']>;
type Server = HttpServer | Http2Server;

type Review = {
    runId: string;
    failedGeneration: number;
    readyGeneration: number;
    stableOperationId: string;
    expectedSnapshotSha256: string;
};

export { snapshotSha256 } from './snapshot.ts';
type Options = {
    state: string;
    token: string;
    port?: number;
    bindHost?: '127.0.0.1' | '0.0.0.0';
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
    const projectPurges = new Map<string, Promise<ProjectDeletionReceipt>>();
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
        await Promise.allSettled([
            ...purges.values(),
            ...projectPurges.values(),
        ]);
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
        const executing = new Map<
            string,
            {
                generation: number;
                abort: AbortController;
                exitConfirmed: boolean;
            }
        >();
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
        const taskProjectionEnds = new Set<string>();
        const projectionKey = (grant: WorkerRequest['grant']) =>
            grant.run + ':' + grant.generation;
        function acceptTaskEvents(
            grant: WorkerRequest['grant'],
            body: unknown,
        ) {
            const run = db.findRun(grant.run);
            if (
                !canExecute(grant) ||
                run.sessionId !== grant.session ||
                run.admittedGeneration !== grant.generation ||
                run.taskSequence === null
            )
                throw new Error('Task event grant mismatch');
            const events = publicTaskEventBatch(body).map((event) =>
                event.kind === 'check'
                    ? {
                          offset: event.offset,
                          kind: event.kind,
                          text: event.name,
                          check: {
                              name: event.name,
                              status: event.status,
                              output: event.output,
                          },
                      }
                    : { ...event, check: null },
            );
            db.appendTaskEvents(
                run.projectId,
                run.id,
                grant.generation,
                events,
            );
            if (events.length === 0)
                taskProjectionEnds.add(projectionKey(grant));
        }
        const operationUrl = await listen(
            execution.operationIngress(canExecute, acceptTaskEvents),
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
            if (run.taskSequence === null) db.confirmReview(runId, proof, diff);
            else {
                const initial = db.taskInitialFiles(run.projectId);
                const cumulative = await unifiedDiff(initial, after);
                stop.signal.throwIfAborted();
                if (db.reviewReceipt(runId, proof)) return;
                checkBinding();
                db.publishTaskResult(
                    runId,
                    {
                        baselineSha256: snapshotSha256(
                            textSnapshot(JSON.parse(run.baseline ?? 'null')),
                        ),
                        initialSha256: snapshotSha256(initial),
                        afterSha256: expectedSnapshotSha256,
                        incremental: diff,
                        cumulative,
                    },
                    proof,
                );
            }
        }

        function supportsCancellation(run: Run) {
            return (
                host.supportsRunningCancellation === true ||
                (run.taskSequence !== null &&
                    host.supportsTaskRunningCancellation === true)
            );
        }

        async function taskExit(
            run: Run,
            binding: Binding,
            generation: number,
        ) {
            const bindingDigest = executionBindingDigest(binding);
            if (
                run.admittedGeneration !== generation ||
                run.admittedBindingDigest !== bindingDigest
            )
                return undefined;
            const prior = db.taskExit(run.id, generation);
            if (prior)
                return prior.bindingDigest === bindingDigest
                    ? prior
                    : undefined;
            const observed = await host.observeWorkerExit?.(
                binding,
                run.id,
                generation,
            );
            if (
                !observed ||
                observed.sessionId !== binding.session ||
                observed.runId !== run.id ||
                observed.generation !== generation ||
                observed.bindingDigest !== bindingDigest ||
                !Number.isFinite(Date.parse(observed.exitedAt))
            )
                return undefined;
            return db.recordTaskExit(
                run.id,
                generation,
                bindingDigest,
                observed.exitedAt,
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

        async function reconcileFixtureWrite(
            run: Run,
            binding: Binding,
            generation: number,
        ) {
            const operation = operationId(run.id, 'local-demo');
            if (!execution.operation(binding.session, generation, operation))
                return;
            const receipt = await host.taskRecovery?.readFixtureWriteReceipt?.(
                binding,
                run.id,
                generation,
            );
            if (!receipt) return;
            const inputDigest = sha256Digest(run.prompt);
            const current = textSnapshot(await host.snapshot(binding)).find(
                (file) => file.path === receipt.relativePath,
            );
            if (
                receipt.sessionId !== binding.session ||
                receipt.runId !== run.id ||
                receipt.generation !== generation ||
                receipt.bindingDigest !== executionBindingDigest(binding) ||
                receipt.operationId !== operation ||
                receipt.inputDigest !== inputDigest ||
                !current ||
                sha256Digest(current.text) !== receipt.fileSha256
            )
                throw new Error('Invalid fixture write evidence');
            execution.observeTaskFixtureWrite(
                binding.session,
                generation,
                operation,
                sha256Digest(inputDigest),
            );
        }

        async function stopAndProve(run: Run) {
            const generation = run.admittedGeneration;
            const recovery = host.taskRecovery;
            if (generation === null || !recovery) return false;
            if (
                host.sdk &&
                (!host.sdk.decodeExecEvent ||
                    !host.observeWorkerExit ||
                    !recovery.observeSdkRetrySafety)
            )
                return false;
            const binding = db.binding(run);
            const exit = await taskExit(run, binding, generation);
            if (!exit) return false;
            if (!readyBinding(binding, generation + 1))
                await execution.takeover(binding.session, generation);
            if (!readyBinding(binding, generation + 1)) return false;
            const prior = db.readStopProof(run.id);
            if (prior) {
                readProof(run, generation, generation + 1);
                return true;
            }
            await reconcileFixtureWrite(run, binding, generation);
            if (execution.hasUnknownOperations(binding.session, generation))
                return false;
            let effect;
            if (host.sdk) {
                const observed = await recovery.observeSdkRetrySafety!(
                    binding,
                    run.id,
                    generation,
                );
                if (!observed) return false;
                const exitedAt = Date.parse(observed.exitedAt);
                const observedAt = Date.parse(observed.observedAt);
                if (
                    observed.sessionId !== binding.session ||
                    observed.runId !== run.id ||
                    observed.generation !== generation ||
                    observed.bindingDigest !==
                        executionBindingDigest(binding) ||
                    observed.exitedAt !== exit.exitedAt ||
                    !Number.isFinite(exitedAt) ||
                    !Number.isFinite(observedAt) ||
                    exitedAt > observedAt ||
                    observedAt > Date.now()
                )
                    return false;
                effect = observed;
            } else {
                effect = await recovery.retryObservation(
                    binding,
                    run.id,
                    generation,
                );
            }
            const history = execution.historyQuiescence(binding.session);
            if (
                !effect ||
                effect.workspaceOnly !== true ||
                effect.unknownOperations !== 0 ||
                history.handleOpen ||
                history.pendingBatches !== 0
            )
                return false;
            if (!readyBinding(binding, generation + 1)) return false;
            const proof = {
                taskId: run.projectId,
                runId: run.id,
                sessionId: binding.session,
                bindingDigest: executionBindingDigest(binding),
                oldGeneration: generation,
                newGeneration: generation + 1,
                workerExitedAt: exit.exitedAt,
                authorityState: 'READY',
                authorityRun: null,
                hasCapability: false,
                unknownOperations: 0,
                pendingBatches: 0,
                workspaceOnly: true,
                observedAt: new Date().toISOString(),
            };
            db.recordStopProof(run.id, JSON.stringify(proof));
            return true;
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

        async function closeTaskRun(input: {
            runId: string;
            decision: 'failed' | 'unconfirmed';
            expectedGeneration: number;
        }) {
            if (input.decision !== 'failed' && input.decision !== 'unconfirmed')
                throw conflict('review_unavailable', 'Invalid closure.');
            const prior = db.readTaskClosure(input.runId);
            if (prior) {
                if (
                    prior.authorityGeneration !== input.expectedGeneration ||
                    prior.decision !== input.decision
                )
                    throw conflict(
                        'review_unavailable',
                        'Closure decision changed.',
                    );
                return;
            }
            const run = db.findRun(input.runId);
            const generation = run.admittedGeneration;
            const binding = db.binding(run);
            const history = execution.historyQuiescence(binding.session);
            const exit =
                generation === null
                    ? undefined
                    : await taskExit(run, binding, generation);
            if (
                run.taskSequence === null ||
                run.status !== 'needs_review' ||
                generation === null ||
                !exit ||
                input.expectedGeneration <= generation ||
                !readyBinding(binding, input.expectedGeneration) ||
                history.handleOpen ||
                history.pendingBatches
            )
                throw conflict(
                    'review_unavailable',
                    'Task closure evidence unavailable.',
                );
            db.closeTaskRun(
                run.id,
                input.decision,
                input.expectedGeneration,
                sha256Digest(
                    JSON.stringify({
                        exitReceiptDigest: sha256Digest(JSON.stringify(exit)),
                        bindingDigest: executionBindingDigest(binding),
                        oldGeneration: generation,
                        newGeneration: input.expectedGeneration,
                    }),
                ),
            );
        }

        async function closeTaskRetry(input: {
            attemptId: string;
            expectedGeneration: number;
        }) {
            const prior = db.readTaskRetryClosure(input.attemptId);
            if (prior) {
                if (prior.authorityGeneration !== input.expectedGeneration)
                    throw conflict(
                        'review_unavailable',
                        'Retry closure changed.',
                    );
                return;
            }
            const attempt = db.taskRetry(input.attemptId);
            if (
                attempt.phase !== 'blocked' ||
                input.expectedGeneration !== attempt.newGeneration ||
                advancingRetries.has(attempt.id)
            )
                throw conflict(
                    'review_unavailable',
                    'Retry is not awaiting closure.',
                );
            advancingRetries.add(attempt.id);
            try {
                const run = db.findRun(attempt.sourceRunId);
                const binding = db.binding(run);
                const exit = await taskExit(
                    run,
                    binding,
                    attempt.oldGeneration,
                );
                const history = execution.historyQuiescence(binding.session);
                if (
                    !exit ||
                    history.handleOpen ||
                    history.pendingBatches ||
                    !readyBinding(binding, input.expectedGeneration)
                )
                    throw conflict(
                        'review_unavailable',
                        'Retry cleanup evidence unavailable.',
                    );
                const cleanupObservation = await host.observeRetryCleanup?.(
                    binding,
                    attempt.id,
                    input.expectedGeneration,
                );
                const bindingDigest = executionBindingDigest(binding);
                if (
                    !cleanupObservation ||
                    cleanupObservation.attemptId !== attempt.id ||
                    cleanupObservation.generation !== attempt.newGeneration ||
                    cleanupObservation.bindingDigest !== bindingDigest ||
                    cleanupObservation.restoreIdle !== true ||
                    cleanupObservation.volumeWriters !== 0 ||
                    cleanupObservation.sandboxStopped !== true ||
                    !readyBinding(binding, input.expectedGeneration) ||
                    !Number.isFinite(Date.parse(cleanupObservation.observedAt))
                )
                    throw conflict(
                        'review_unavailable',
                        'Retry cleanup evidence unavailable.',
                    );
                db.closeBlockedTaskRetry(
                    attempt.id,
                    input.expectedGeneration,
                    sha256Digest(
                        JSON.stringify({
                            exitReceiptDigest: sha256Digest(
                                JSON.stringify(exit),
                            ),
                            bindingDigest,
                            authorityGeneration: input.expectedGeneration,
                            cleanupObservation,
                        }),
                    ),
                );
            } finally {
                advancingRetries.delete(attempt.id);
            }
        }

        async function reconcileTaskRetry(input: {
            attemptId: string;
            expectedGeneration: number;
        }): Promise<'pending' | 'queued'> {
            const attempt = db.taskRetry(input.attemptId);
            if (attempt.newGeneration !== input.expectedGeneration)
                return 'pending';
            if (attempt.phase === 'queued') return 'queued';
            if (attempt.phase !== 'blocked' || advancingRetries.has(attempt.id))
                return 'pending';
            advancingRetries.add(attempt.id);
            try {
                const { binding, proof } = verifiedStopProof(attempt);
                await verifyRestoredTask(attempt, binding, proof);
                db.finalizeTaskRetry(attempt.id, 'blocked');
                wake();
                return 'queued';
            } catch {
                return 'pending';
            } finally {
                advancingRetries.delete(attempt.id);
            }
        }

        const taskSourcePurges = new Map<string, Promise<boolean>>();
        async function purgeTaskSource(
            owner: string,
            spaceId: string,
            operationId: string,
        ) {
            const key = JSON.stringify([owner, spaceId, operationId]);
            const prior = taskSourcePurges.get(key);
            if (prior) return prior;
            const cleanup = (async () => {
                try {
                    for (const binding of db.taskSourceDeletionBindings(
                        owner,
                        spaceId,
                        operationId,
                    )) {
                        const ids = db.projectRunIds(binding.project);
                        if (
                            !host.purge ||
                            ids.some((id) =>
                                [...assigned.values()].includes(id),
                            )
                        )
                            return false;
                        if (scheduler)
                            for (const id of ids)
                                if (!(await scheduler.purgeClosed(id)))
                                    return false;
                        await execution.purge(binding, host.purge.bind(host));
                        db.purgeProject(binding, operationId, spaceId);
                    }
                    return db.finishTaskSourceDeletion(
                        owner,
                        spaceId,
                        operationId,
                    );
                } catch {
                    return false;
                }
            })().finally(() => taskSourcePurges.delete(key));
            taskSourcePurges.set(key, cleanup);
            return cleanup;
        }

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
            const binding = db.binding(run);
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

        async function worker(
            run: Run,
            binding: Binding,
            mode: WorkerRequest['mode'],
            slot: number,
        ) {
            const current = execution.inspect(binding.session);
            if (run.taskSequence !== null && mode === 'execute') {
                if (
                    run.expectedGeneration !== null &&
                    run.expectedGeneration !== current.generation
                )
                    throw new Error('Queued retry generation changed');
                db.recordTaskAdmission(
                    run.id,
                    current.generation,
                    executionBindingDigest(binding),
                );
            }
            const grant = execution.admit(
                binding.session,
                current.generation,
                run.id,
                workerTimeoutMs,
            );
            live.set(grant.token, mode);
            const attempt =
                mode === 'execute'
                    ? {
                          generation: grant.generation,
                          abort: new AbortController(),
                          exitConfirmed: false,
                      }
                    : undefined;
            if (attempt) executing.set(run.id, attempt);
            const onWorkerExit =
                attempt && supportsCancellation(run)
                    ? () => {
                          if (
                              stop.signal.aborted ||
                              executing.get(run.id) !== attempt
                          )
                              return;
                          attempt.exitConfirmed = true;
                          if (run.taskSequence !== null) {
                              if (host.observeWorkerExit) {
                                  void taskExit(
                                      db.findRun(run.id),
                                      binding,
                                      grant.generation,
                                  ).catch(() => {});
                              } else {
                                  db.recordTaskExit(
                                      run.id,
                                      grant.generation,
                                      executionBindingDigest(binding),
                                      new Date().toISOString(),
                                  );
                              }
                          }
                          try {
                              db.markCancellationWorkerClosed(
                                  run.id,
                                  attempt.generation,
                              );
                          } catch {
                              // Retain the observed exit for the next advancement.
                          }
                      }
                    : undefined;
            const signal = AbortSignal.any([
                stop.signal,
                AbortSignal.timeout(workerTimeoutMs),
                ...(attempt ? [attempt.abort.signal] : []),
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
                        ...(run.taskSequence !== null && mode === 'execute'
                            ? {
                                  publicEventsUrl: new URL(
                                      '/task-events',
                                      operationUrl,
                                  ).href,
                              }
                            : {}),
                        ...(mode === 'execute' ? { prompt: run.prompt } : {}),
                    },
                    signal,
                    slot,
                    onWorkerExit,
                );
                const result = await Promise.race([task, aborted]);
                if (
                    result === 'completed' &&
                    run.taskSequence !== null &&
                    !taskProjectionEnds.has(projectionKey(grant))
                )
                    return 'review';
                return result;
            } finally {
                live.delete(grant.token);
                taskProjectionEnds.delete(projectionKey(grant));
                signal.removeEventListener('abort', onAbort);
                // A replacement must wait for the single slot to close on lease expiry.
                if (
                    closeWarmWorker &&
                    signal.aborted &&
                    !attempt?.abort.signal.aborted
                )
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
                const task = db.taskConfig(binding.project);
                const observation = task
                    ? await host.provisionTask(
                          binding,
                          files,
                          task.environmentVersion,
                      )
                    : await host.provision(binding, files);
                if (
                    task &&
                    (!('environmentVersion' in observation) ||
                        observation.environmentVersion !==
                            task.environmentVersion)
                )
                    throw new Error('Task environment observation mismatch');
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
                db.importResult(project.id, 'failed', 'preparation_failed');
            }
        }

        async function driveCancellation(run: Run): Promise<void> {
            const generation = run.cancelGeneration;
            if (generation === null)
                throw new Error('Cancellation intent unavailable');
            const binding = db.binding(run);
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

        async function driveRun(run: Run, slot: number) {
            if (run.status === 'cancelling') return driveCancellation(run);
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
            if (!db.start(queued.id, before, slots)) {
                if (db.findRun(queued.id).status === 'cancelled') return;
                throw new Error('Execution host has pending recovery work');
            }
            try {
                if (
                    (await worker(queued, binding, 'execute', slot)) ===
                    'completed'
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
            await settle(current, slot);
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
                    const run = db.findRun(runId);
                    if (
                        run.status === 'cancelled' ||
                        db.isProjectDeleting(run.projectId)
                    )
                        return;
                    if (importing || [...assigned.values()].includes(runId))
                        throw new Error('Execution host is occupied');
                    const slot = assigned.has(0) ? 1 : 0;
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
                        await driveRun(run, slot);
                        stop.signal.throwIfAborted();
                    } finally {
                        assigned.delete(slot);
                    }
                },
            );
        }
        let enqueued = new Set<string>();
        let retryCursor = 0;

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

        async function advanceProjectDeletion(
            owner: string,
            projectId: string,
            operationId: string,
        ): Promise<ProjectDeletionReceipt> {
            stop.signal.throwIfAborted();
            const receipt = db.beginProjectDeletion(
                owner,
                projectId,
                operationId,
            );
            if (receipt.state !== 'deleting') return receipt;
            const existing = projectPurges.get(projectId);
            if (existing) return existing;
            const runs = db.projectRunIds(projectId);
            if (
                (scheduler && active) ||
                runs.some((run) => [...assigned.values()].includes(run))
            )
                return receipt;
            const task = (async (): Promise<ProjectDeletionReceipt> => {
                try {
                    if (scheduler)
                        for (const run of runs)
                            if (!(await scheduler.purgeClosed(run)))
                                return receipt;
                    if (!host.purge) return receipt;
                    const binding = db.projectDeletionBinding(
                        owner,
                        projectId,
                        operationId,
                    );
                    await execution.purge(binding, host.purge.bind(host));
                    db.purgeProject(binding, operationId);
                    return { state: 'deleted' };
                } catch {
                    // Retry from the same durable receipt after an unconfirmed cleanup.
                    return receipt;
                }
            })().finally(() => projectPurges.delete(projectId));
            projectPurges.set(projectId, task);
            return task;
        }

        function purgeOwner(owner: string) {
            const existing = purges.get(owner);
            if (existing) return existing;
            stop.signal.throwIfAborted();
            db.drainOwner(owner);
            if (db.hasProjectDeletionInProgress(owner))
                return Promise.resolve(false);
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
                db.clearProjectDeletionReceipts(owner);
                return true;
            })().finally(() => purges.delete(owner));
            purges.set(owner, task);
            return task;
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
            ),
            options.port,
            options.bindHost,
        );
        wake();
        return {
            url,
            close,
            reviewRun,
            closeTaskRun,
            closeTaskRetry,
            reconcileTaskRetry,
            readTaskClosure: (id: string) => db.readTaskClosure(id),
            readTaskRetryClosure: (id: string) =>
                db.readTaskRetryClosure(id) ?? null,
        };
    } catch (error) {
        await close();
        throw error;
    }
}
