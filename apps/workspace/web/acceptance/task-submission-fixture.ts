import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { localHost } from '@/apps/orchestrator/src/execution-service/local.ts';
import { serveExecution } from '@/apps/orchestrator/src/execution-service/service.ts';
import { mockAccounts } from '@/apps/workspace/api/src/account-store.ts';
import { demoAccounts, sessionAuth } from '@/apps/workspace/api/src/auth.ts';
import { httpBackend } from '@/apps/workspace/api/src/execution-service-http.ts';
import { taskEntryServer } from '@/apps/workspace/api/src/server.ts';
import { mySpace } from '@/apps/workspace/api/src/space/index.ts';
import {
    spaceObjectKey,
    spaceStorage,
} from '@/apps/workspace/api/src/space/storage.ts';

// Identity, saved object bytes and Worker are synthetic; API, freezing and SQLite are production.
export async function startTaskSubmissionFixture() {
    const state = await mkdtemp(join(tmpdir(), 'bento-submission-'));
    const base = localHost(join(state, 'volume'));
    const accounts = demoAccounts();
    const demo = accounts.find((a) => a.account === 'demo')!;
    const auth = sessionAuth(mockAccounts(accounts), false, false);
    const bearer = 'fixture-submission-' + randomUUID();
    const source = {
        spaceId: randomUUID(),
        fileId: randomUUID(),
        path: 'input.txt' as const,
        name: 'Submission source' as const,
    };
    let seeded = false;
    let currentSource = Buffer.from('base\n');
    let sourceReads = 0;
    const prepares = new Map<string, number>();
    const executes = new Map<string, number>();
    const gates = new Map<string, () => void>();
    const unexpected = () => {
        throw new Error('Unexpected storage operation');
    };
    const storage = spaceStorage('http://127.0.0.1:1', 'fixture', 'us-east-1');
    storage.read = async (key, size) => {
        assert.equal(key, spaceObjectKey(source.fileId));
        assert.equal(size, 5);
        sourceReads++;
        return Buffer.from(currentSource);
    };
    storage.create =
        storage.signPart =
        storage.parts =
        storage.complete =
        storage.empty =
        storage.abort =
        storage.size =
        storage.remove =
        storage.preview =
        storage.download =
            unexpected;
    const host: Parameters<typeof serveExecution>[0]['host'] = {
        ...base,
        async provisionTask(binding, files, environmentVersion) {
            prepares.set(
                binding.project,
                (prepares.get(binding.project) ?? 0) + 1,
            );
            return base.provisionTask(binding, files, environmentVersion);
        },
        async worker(request, signal, slot, exit) {
            if (request.mode === 'execute') {
                const taskId = request.binding.project;
                executes.set(taskId, (executes.get(taskId) ?? 0) + 1);
                assert(
                    ['noop', 'hold-submission'].includes(request.prompt ?? ''),
                );
                if (request.prompt === 'hold-submission')
                    await new Promise<void>((resolve) =>
                        gates.set(taskId, resolve),
                    );
                assert(request.publicEventsUrl);
                const projection = await fetch(request.publicEventsUrl, {
                    method: 'POST',
                    headers: {
                        authorization: 'Bearer ' + request.grant.token,
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify({
                        items: [
                            {
                                offset: 0,
                                kind: 'agent_reply',
                                text: 'Submission accepted.',
                            },
                        ],
                    }),
                    signal: AbortSignal.timeout(3000),
                });
                assert.equal(projection.status, 200);
                await projection.body?.cancel();
            }
            return base.worker(
                request.mode === 'execute'
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
    let space = mySpace(join(state, 'space.sqlite'), storage, (owner, op) =>
        backend(owner, op),
    );
    const listen = () =>
        taskEntryServer({
            port: 4343,
            origin: 'http://127.0.0.1:4344',
            auth,
            backend: (owner, op) => backend(owner, op),
            space,
        });
    let api: Awaited<ReturnType<typeof taskEntryServer>>;
    try {
        api = await listen();
    } catch (error) {
        await space.close();
        await execution.close();
        await rm(state, { recursive: true, force: true });
        throw error;
    }
    return {
        async seedSource() {
            if (!seeded) {
                const db = new DatabaseSync(join(state, 'space.sqlite'));
                try {
                    db.exec('BEGIN');
                    db.prepare(
                        'INSERT INTO space_projects(id,owner,name) VALUES (?,?,?)',
                    ).run(source.spaceId, demo.ownerId, source.name);
                    db.prepare(
                        'INSERT INTO space_uploads(id,project,owner,path,size,manifest,state,storageId,expires,signedUntil,cleanup) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                    ).run(
                        source.fileId,
                        source.spaceId,
                        demo.ownerId,
                        source.path,
                        5,
                        JSON.stringify([
                            createHash('sha256')
                                .update('base\n')
                                .digest('base64'),
                        ]),
                        'saved',
                        null,
                        0,
                        0,
                        null,
                    );
                    db.exec('COMMIT');
                    seeded = true;
                } catch (error) {
                    db.exec('ROLLBACK');
                    throw error;
                } finally {
                    db.close();
                }
            }
            return source;
        },
        setSourceText(text: string) {
            currentSource = Buffer.from(text);
        },
        releaseRun(taskId: string) {
            gates.get(taskId)?.();
            gates.delete(taskId);
        },
        async observe(taskId: string) {
            const db = new DatabaseSync(join(state, 'business.sqlite'), {
                readOnly: true,
            });
            const count = (sql: string) =>
                db.prepare(sql).get(taskId)!.n as number;
            try {
                return {
                    prepare: prepares.get(taskId) ?? 0,
                    execute: executes.get(taskId) ?? 0,
                    runs: count(
                        'SELECT COUNT(*) AS n FROM runs WHERE projectId=?',
                    ),
                    userMessages: count(
                        "SELECT COUNT(*) AS n FROM task_events WHERE taskId=? AND json_extract(body,'$.kind')='user_message'",
                    ),
                    creationReceipts: count(
                        'SELECT COUNT(*) AS n FROM task_creation_receipts WHERE taskId=?',
                    ),
                    sourceReads,
                };
            } finally {
                db.close();
            }
        },
        async reopen() {
            const db = new DatabaseSync(join(state, 'business.sqlite'), {
                readOnly: true,
            });
            try {
                assert.equal(
                    db
                        .prepare(
                            "SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running','recovering','needs_review','cancelling')",
                        )
                        .get()!.n,
                    0,
                );
            } finally {
                db.close();
            }
            await api.close();
            await execution.close();
            execution = await start();
            backend = httpBackend(execution.url, bearer, 5000);
            space = mySpace(join(state, 'space.sqlite'), storage, (owner, op) =>
                backend(owner, op),
            );
            api = await listen();
        },
        async close() {
            for (const release of gates.values()) release();
            gates.clear();
            await api.close();
            await execution.close();
            await rm(state, { recursive: true, force: true });
        },
    };
}
