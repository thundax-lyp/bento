import type { SingleHostExecution } from '../openshell/single-host.ts';
import type { ProjectDeletionReceipt, Store } from './store/index.ts';
import type { temporalRuns } from './temporal.ts';
import type { ExecutionHost } from './types.ts';

export function executionCleanup({
    db,
    execution,
    host,
    signal,
    currentScheduler,
    isActive,
    isAssigned,
}: {
    db: Store;
    execution: SingleHostExecution;
    host: ExecutionHost;
    signal: AbortSignal;
    currentScheduler: () =>
        Awaited<ReturnType<typeof temporalRuns>> | undefined;
    isActive: () => boolean;
    isAssigned: (run: string) => boolean;
}) {
    const projectPurges = new Map<string, Promise<ProjectDeletionReceipt>>();
    const purges = new Map<string, Promise<boolean>>();

    const taskSourcePurges = new Map<string, Promise<boolean>>();
    async function purgeTaskSource(
        owner: string,
        spaceId: string,
        operationId: string,
    ) {
        const scheduler = currentScheduler();
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
                    if (!host.purge || ids.some((id) => isAssigned(id)))
                        return false;
                    if (scheduler)
                        for (const id of ids)
                            if (!(await scheduler.purgeClosed(id)))
                                return false;
                    await execution.purge(binding, host.purge.bind(host));
                    db.purgeProject(binding, operationId, spaceId);
                }
                return db.finishTaskSourceDeletion(owner, spaceId, operationId);
            } catch {
                return false;
            }
        })().finally(() => taskSourcePurges.delete(key));
        taskSourcePurges.set(key, cleanup);
        return cleanup;
    }

    async function advanceProjectDeletion(
        owner: string,
        projectId: string,
        operationId: string,
    ): Promise<ProjectDeletionReceipt> {
        const scheduler = currentScheduler();
        signal.throwIfAborted();
        const receipt = db.beginProjectDeletion(owner, projectId, operationId);
        if (receipt.state !== 'deleting') return receipt;
        const existing = projectPurges.get(projectId);
        if (existing) return existing;
        const runs = db.projectRunIds(projectId);
        if ((scheduler && isActive()) || runs.some((run) => isAssigned(run)))
            return receipt;
        const task = (async (): Promise<ProjectDeletionReceipt> => {
            try {
                if (scheduler)
                    for (const run of runs)
                        if (!(await scheduler.purgeClosed(run))) return receipt;
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
        const scheduler = currentScheduler();
        const existing = purges.get(owner);
        if (existing) return existing;
        signal.throwIfAborted();
        db.drainOwner(owner);
        if (db.hasProjectDeletionInProgress(owner))
            return Promise.resolve(false);
        const task = (async () => {
            if ((scheduler && isActive()) || !db.ownerDrained(owner))
                return false;
            const bindings = db.ownerBindings(owner);
            for (const binding of bindings) {
                const runs = db.projectRunIds(binding.project);
                if (runs.some((run) => isAssigned(run))) return false;
                if (scheduler) {
                    let settled = true;
                    for (const run of runs)
                        if (!(await scheduler.purgeClosed(run)))
                            settled = false;
                    if (!settled) return false;
                }
                if (!host.purge)
                    throw new Error('Execution host cleanup is unavailable');
                await execution.purge(binding, host.purge.bind(host));
                db.purgeProject(binding);
            }
            db.clearProjectDeletionReceipts(owner);
            return true;
        })().finally(() => purges.delete(owner));
        purges.set(owner, task);
        return task;
    }

    return {
        advanceProjectDeletion,
        purgeOwner,
        purgeTaskSource,
        pending: () => [...purges.values(), ...projectPurges.values()],
    };
}
