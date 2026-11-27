import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { localHost } from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/local.ts';
import { serveExecution } from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/service.ts';
import { mockAccounts } from '@/apps/workspace/workspace-web/tests/acceptance/fixtures/workspace-api/src/account-store.ts';
import {
    demoAccounts,
    sessionAuth,
} from '@/apps/workspace/workspace-web/tests/acceptance/fixtures/workspace-api/src/auth.ts';
import { httpBackend } from '@/apps/workspace/workspace-web/tests/acceptance/fixtures/workspace-api/src/execution-service-http.ts';
import { taskEntryServer } from '@/apps/workspace/workspace-web/tests/acceptance/fixtures/workspace-api/src/server.ts';
import { mySpace } from '@/apps/workspace/workspace-web/tests/acceptance/fixtures/workspace-api/src/space/index.ts';
import { startQueueStorageFixture } from './queue-storage-fixture.ts';

async function within<T>(
    work: Promise<T>,
    ms: number,
    label: string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(Error(label + ' exceeded deadline')),
                    ms,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

// Production auth, HTTP, SQLite and localHost; identities and execution timing are controlled.
export async function startQueueIsolationFixture() {
    const directory = await mkdtemp(join(tmpdir(), 'bento-queue-isolation-'));
    const accounts = demoAccounts();
    const bearer = 'queue-fixture-' + randomUUID();
    const base = localHost(join(directory, 'volume'));
    const gates = new Map<string, () => void>();
    const enteredRuns: string[] = [];
    let releasedAll = false;
    let activeWorkers = 0;
    let peakWorkers = 0;
    let storage:
        Awaited<ReturnType<typeof startQueueStorageFixture>> | undefined;
    let execution: Awaited<ReturnType<typeof serveExecution>> | undefined;
    let space: ReturnType<typeof mySpace> | undefined;
    let api: Awaited<ReturnType<typeof taskEntryServer>> | undefined;
    let spaceOwner: 'fixture' | 'api' = 'fixture';
    const releaseAll = () => {
        releasedAll = true;
        for (const release of gates.values()) release();
        gates.clear();
        storage?.releaseParts();
    };
    async function observe() {
        const db = new DatabaseSync(join(directory, 'business.sqlite'), {
            readOnly: true,
        });
        try {
            db.exec('BEGIN');
            const count = (sql: string, owner: string) =>
                Number(db.prepare(sql).get(owner)!.n);
            const owners = Object.fromEntries(
                accounts.map(({ ownerId }) => [
                    ownerId,
                    {
                        tasks: count(
                            'SELECT count(*) n FROM tasks WHERE owner=?',
                            ownerId,
                        ),
                        runs: count(
                            'SELECT count(*) n FROM runs r JOIN projects p ON r.projectId=p.id WHERE p.owner=?',
                            ownerId,
                        ),
                        events: count(
                            'SELECT count(*) n FROM task_events e JOIN tasks t ON e.taskId=t.id WHERE t.owner=?',
                            ownerId,
                        ),
                        creationReceipts: count(
                            'SELECT count(*) n FROM task_creation_receipts WHERE owner=?',
                            ownerId,
                        ),
                        retryAttempts: count(
                            'SELECT count(*) n FROM retry_attempts a JOIN tasks t ON a.taskId=t.id WHERE t.owner=?',
                            ownerId,
                        ),
                        queued: count(
                            "SELECT count(*) n FROM runs r JOIN projects p ON r.projectId=p.id WHERE p.owner=? AND r.status='queued'",
                            ownerId,
                        ),
                    },
                ]),
            );
            const occupied = db
                .prepare(
                    `SELECT p.owner,r.status FROM runs r JOIN projects p ON p.id=r.projectId
                LEFT JOIN run_dispatches d ON d.runId=r.id
                WHERE r.status IN ('running','recovering','cancelling') OR (r.status='queued' AND d.runId IS NOT NULL)
                ORDER BY r.rowid`,
                )
                .all() as { owner: string; status: string }[];
            const queued = db
                .prepare(
                    `SELECT r.id,p.owner FROM runs r JOIN projects p ON p.id=r.projectId
                WHERE r.status='queued' AND NOT EXISTS(SELECT 1 FROM run_dispatches d WHERE d.runId=r.id)
                ORDER BY r.rowid`,
                )
                .all() as { id: string; owner: string }[];
            return {
                activeWorkers,
                peakWorkers,
                enteredRuns: [...enteredRuns],
                occupied,
                queued,
                owners,
            };
        } finally {
            db.close();
        }
    }
    let closing: Promise<void> | undefined;
    const close = () =>
        (closing ??= (async () => {
            releaseAll();
            const errors: unknown[] = [];
            let confirmed = true;
            if (execution) {
                const drain = new AbortController();
                try {
                    await within(
                        (async () => {
                            while (!drain.signal.aborted) {
                                const snapshot = await observe();
                                const db = new DatabaseSync(
                                    join(directory, 'business.sqlite'),
                                    { readOnly: true },
                                );
                                let pending: number;
                                try {
                                    pending = Number(
                                        db
                                            .prepare(
                                                "SELECT count(*) n FROM runs WHERE status NOT IN ('succeeded','failed','cancelled')",
                                            )
                                            .get()!.n,
                                    );
                                } finally {
                                    db.close();
                                }
                                if (
                                    !pending &&
                                    !snapshot.activeWorkers &&
                                    !snapshot.occupied.length &&
                                    !snapshot.queued.length
                                )
                                    return;
                                await delay(20, undefined, {
                                    signal: drain.signal,
                                });
                            }
                        })(),
                        30000,
                        'Run drain',
                    );
                } catch (error) {
                    errors.push(error);
                } finally {
                    drain.abort();
                }
            }
            const cleanup = async (
                work: (() => Promise<void>) | undefined,
                label: string,
            ) => {
                if (!work) return;
                try {
                    await within(work(), 10000, label);
                } catch (error) {
                    confirmed = false;
                    errors.push(error);
                }
            };
            await cleanup(
                api
                    ? () => api!.close()
                    : spaceOwner === 'fixture' && space
                      ? () => space!.close()
                      : undefined,
                'API/space close',
            );
            await cleanup(
                execution ? () => execution!.close() : undefined,
                'Execution close',
            );
            await cleanup(
                storage ? () => storage!.close() : undefined,
                'Storage close',
            );
            if (confirmed) {
                await rm(directory, { recursive: true, force: true });
                await assert.rejects(stat(directory), { code: 'ENOENT' });
            }
            if (errors.length)
                throw new AggregateError(
                    errors,
                    'Queue fixture cleanup failed' +
                        (confirmed ? '' : '; preserved ' + directory),
                );
        })());
    try {
        storage = await startQueueStorageFixture(
            directory,
            'http://127.0.0.1:4364',
        );
        execution = await serveExecution({
            state: directory,
            token: bearer,
            tenantQueueLimit: 2,
            retryMs: 20,
            workerTimeoutMs: 120000,
            host: {
                ...base,
                async worker(request, signal, slot, exit) {
                    if (request.mode !== 'execute')
                        return base.worker(request, signal, slot, exit);
                    assert.equal(request.prompt, 'noop');
                    const runId = request.grant.run;
                    enteredRuns.push(runId);
                    activeWorkers++;
                    peakWorkers = Math.max(peakWorkers, activeWorkers);
                    try {
                        if (!releasedAll)
                            await new Promise<void>((resolve) =>
                                gates.set(runId, resolve),
                            );
                        gates.delete(runId);
                        return await base.worker(request, signal, slot, exit);
                    } finally {
                        activeWorkers--;
                    }
                },
            },
        });
        const backend = httpBackend(execution.url, bearer, 5000);
        space = mySpace(
            join(directory, 'space.sqlite'),
            storage.storage,
            backend,
        );
        spaceOwner = 'api';
        api = await taskEntryServer({
            port: 4363,
            origin: 'http://127.0.0.1:4364',
            auth: sessionAuth(mockAccounts(accounts), false, false),
            backend,
            space,
        });
        return {
            accounts: accounts.map((account) => ({
                account: account.account,
                ownerId: account.ownerId,
                invite: 'demo-invite',
            })),
            storage,
            releaseRun(runId: string) {
                gates.get(runId)?.();
                gates.delete(runId);
            },
            releaseAll,
            observe,
            close,
        };
    } catch (error) {
        try {
            await close();
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                'Queue fixture startup and cleanup failed',
                { cause: cleanupError },
            );
        }
        throw error;
    }
}
