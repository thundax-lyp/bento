import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localHost } from '@/apps/orchestrator/src/execution-service/local.ts';
import { serveExecution } from '@/apps/orchestrator/src/execution-service/service.ts';
import { Store } from '@/apps/orchestrator/src/execution-service/store.ts';
import { projectTaskChecks } from '@/apps/worker/task-projection.ts';
import { mockAccounts } from '@/apps/workspace/api/src/account-store.ts';
import { demoAccounts, sessionAuth } from '@/apps/workspace/api/src/auth.ts';
import { httpBackend } from '@/apps/workspace/api/src/execution-service-http.ts';
import { taskEntryServer } from '@/apps/workspace/api/src/server.ts';

// Synthetic execution and identity only. HTTP, DTO mapping and SQLite are production code.
export const privateCanary = 'synthetic-terminal-private-diagnostic';

export async function startTerminalResultsFixture(): Promise<{
    seedFailure(taskId: string): Promise<string>;
    close(): Promise<void>;
}> {
    const state = await mkdtemp(join(tmpdir(), 'bento-browser-terminal-'));
    const base = localHost(join(state, 'volume'));
    const accounts = demoAccounts();
    const demo = accounts.find((account) => account.account === 'demo')!;
    const bearer = 'fixture-terminal-service-' + randomUUID();
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
        release = resolve;
    });
    const host: Parameters<typeof serveExecution>[0]['host'] = {
        ...base,
        async worker(request, signal, slot, exit) {
            if (request.mode === 'execute') {
                assert(
                    [
                        'terminal-nonempty',
                        'noop',
                        'terminal-checks',
                        'terminal-unavailable',
                    ].includes(request.prompt ?? ''),
                );
                if (request.prompt === 'terminal-unavailable') await pending;
                assert(request.publicEventsUrl);
                async function send(items: unknown[]) {
                    const response = await fetch(request.publicEventsUrl!, {
                        method: 'POST',
                        headers: {
                            authorization: 'Bearer ' + request.grant.token,
                            'content-type': 'application/json',
                        },
                        body: JSON.stringify({ items }),
                        signal: AbortSignal.timeout(3000),
                    });
                    await response.body?.cancel();
                    return response.status;
                }
                // The private field is rejected at the actual Worker HTTP boundary.
                assert.equal(
                    await send([
                        {
                            offset: 0,
                            kind: 'agent_reply',
                            text: '公开结论',
                            privateDiagnostic: privateCanary,
                        },
                    ]),
                    403,
                );
                const checks =
                    request.prompt === 'terminal-checks'
                        ? projectTaskChecks(
                              4,
                              [],
                              [
                                  { version: 1, offset: 0, outcome: 'pass' },
                                  { version: 1, offset: 1, outcome: 'fail' },
                                  { version: 1, offset: 2, outcome: 'skip' },
                                  {
                                      version: 1,
                                      offset: 3,
                                      outcome: 'unavailable',
                                  },
                              ],
                          )
                        : [];
                assert.equal(
                    await send([
                        ...checks,
                        { offset: 4, kind: 'agent_reply', text: '公开结论' },
                    ]),
                    200,
                );
            }
            return base.worker(
                request.mode === 'execute' &&
                    request.prompt !== 'terminal-nonempty'
                    ? { ...request, prompt: 'noop' }
                    : request,
                signal,
                slot,
                exit,
            );
        },
    };
    const start = () =>
        serveExecution({
            state,
            host,
            token: bearer,
            retryMs: 20,
            workerTimeoutMs: 15000,
        });
    let execution = await start();
    let backend = httpBackend(execution.url, bearer, 5000);
    let api: Awaited<ReturnType<typeof taskEntryServer>>;
    try {
        api = await taskEntryServer({
            port: 4333,
            origin: 'http://127.0.0.1:4334',
            auth: sessionAuth(mockAccounts(accounts), false, false),
            backend: (owner, operation) => backend(owner, operation),
        });
    } catch (error) {
        await execution.close();
        await rm(state, { recursive: true, force: true });
        throw error;
    }
    return {
        async seedFailure(taskId) {
            // Explicit terminal fixture, seeded while the controller is closed.
            // This proves persisted failed-result consumption, not failure orchestration.
            await execution.close();
            const store = new Store(join(state, 'business.sqlite'), 16);
            let runId: string;
            try {
                const { run } = store.enqueueTaskRun(
                    demo.ownerId,
                    taskId,
                    randomUUID(),
                    'terminal-failed',
                );
                runId = run.id;
                store.status(
                    run.id,
                    'failed',
                    'Run stopped before completion.',
                );
            } finally {
                store.close();
            }
            execution = await start();
            backend = httpBackend(execution.url, bearer, 5000);
            return runId;
        },
        async close() {
            release();
            await api.close();
            await execution.close();
            await rm(state, { recursive: true, force: true });
        },
    };
}
