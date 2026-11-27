import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { constants } from 'node:fs';
import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    readlink,
    rm,
    writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { localHost } from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/local.ts';
import { snapshotSha256 } from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/service.ts';
import {
    TaskRestoreEvidenceConflict,
    executionBindingDigest,
    type ExecutionHost,
    type WorkerRequest,
} from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/types.ts';
import {
    readme,
    client,
    until,
    project,
    submit,
    rpc,
    start,
    type ResponseBody,
} from './fixtures/service.ts';

test('restores the completed Run business ledger from an isolated backup', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'bento-ledger-restore-'));
    const original = join(root, 'source');
    const restored = join(root, 'restore');
    const source = join(original, 'business.sqlite');
    const archive = join(root, 'backup.sqlite');
    const target = join(restored, 'business.sqlite');
    const prompt = 'ledger restore fixture';
    const key = 'ledger-restore-key';
    let service: Awaited<ReturnType<typeof start>> | undefined;
    let restoreCalls = 0;
    let digest: string;
    try {
        service = await start(original, localHost(join(original, 'volume')));
        const api = client(service.url);
        const projectPath = await project(api);
        const projectView = await api(projectPath);
        assert.equal(projectView.status, 200);
        assert.equal(projectView.json().status, 'ready');
        const runsPath = projectPath + '/runs';
        const accepted = await api(runsPath, 'POST', { prompt }, key);
        assert.equal(accepted.status, 202);
        const runId = accepted.json().id;
        assert(runId);
        assert(accepted.json().sessionId);
        const runPath = runsPath + '/' + runId;
        const before = await until(
            () => api(runPath),
            (r) => r.json().status === 'succeeded',
            'ledger fixture Run succeeded',
        );
        assert.equal(before.status, 200);
        assert.equal(before.json().sessionId, accepted.json().sessionId);
        const diff = await api(runPath + '/diff');
        assert.equal(diff.status, 200);
        assert.match(diff.text, /\+ledger restore fixture/);
        const replay = await api(runsPath, 'POST', { prompt }, key);
        assert.equal(replay.status, 200);
        assert.equal(replay.json().id, runId);
        assert.equal(replay.json().status, 'succeeded');

        await service.close();
        service = undefined;
        const sourceDb = new DatabaseSync(source, { readOnly: true });
        try {
            await backup(sourceDb, archive);
        } finally {
            sourceDb.close();
        }
        const archiveDb = new DatabaseSync(archive, { readOnly: true });
        try {
            assert.equal(
                archiveDb.prepare('PRAGMA integrity_check').get()
                    ?.integrity_check,
                'ok',
            );
            assert.deepEqual(
                archiveDb.prepare('PRAGMA foreign_key_check').all(),
                [],
            );
            const row = archiveDb
                .prepare(
                    'SELECT status, receipt, key, prompt, sessionId, diff FROM runs WHERE id = ?',
                )
                .get(runId);
            assert(row);
            assert.deepEqual(
                { ...row },
                {
                    status: 'succeeded',
                    receipt: 1,
                    key,
                    prompt,
                    sessionId: accepted.json().sessionId,
                    diff: diff.text,
                },
            );
        } finally {
            archiveDb.close();
        }

        await mkdir(restored, { mode: 0o700 });
        await copyFile(archive, target, constants.COPYFILE_EXCL);
        const sha256 = async (path: string) =>
            createHash('sha256')
                .update(await readFile(path))
                .digest('hex');
        digest = await sha256(archive);
        assert.equal(await sha256(target), digest);

        const fixture = localHost(join(restored, 'volume'));
        const unexpected = async (): Promise<never> => {
            restoreCalls++;
            throw new Error(
                'Terminal ledger restore must not touch the fixture host',
            );
        };
        service = await start(restored, {
            ...fixture,
            provision: unexpected,
            snapshot: unexpected,
            start: unexpected,
            stop: unexpected,
            running: unexpected,
            stopped: unexpected,
            worker: unexpected,
        });
        const restoredApi = client(service.url);
        const restoredProject = await restoredApi(projectPath);
        assert.equal(restoredProject.status, 200);
        assert.deepEqual(restoredProject.json(), projectView.json());
        const restoredRun = await restoredApi(runPath);
        assert.equal(restoredRun.status, 200);
        assert.deepEqual(restoredRun.json(), before.json());
        const restoredDiff = await restoredApi(runPath + '/diff');
        assert.equal(restoredDiff.status, 200);
        assert.equal(restoredDiff.text, diff.text);
        assert.equal(
            (await client(service.url, 'account-b')(runPath)).status,
            404,
        );
        const restoredReplay = await restoredApi(
            runsPath,
            'POST',
            { prompt },
            key,
        );
        assert.equal(restoredReplay.status, 200);
        assert.deepEqual(restoredReplay.json(), replay.json());
        const conflict = await restoredApi(
            runsPath,
            'POST',
            { prompt: 'different fixture input' },
            key,
        );
        assert.equal(conflict.status, 409);
        assert.equal(
            JSON.parse(conflict.text).error.code,
            'idempotency_conflict',
        );
        const list = await restoredApi(runsPath);
        assert.equal(list.status, 200);
        assert.deepEqual(JSON.parse(list.text), { runs: [replay.json()] });

        await service.close();
        service = undefined;
        assert.equal(restoreCalls, 0);
        assert.equal(await sha256(archive), digest);
    } finally {
        try {
            await service?.close();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }
    t.diagnostic('business.sqlite SHA-256 ' + digest);
});

test('restores stopped execution state and continues fenced session history', async (t) => {
    const root = await mkdtemp(
        join(tmpdir(), 'bento-execution-state-restore-'),
    );
    const source = join(root, 'source');
    const archive = join(root, 'backup');
    const restored = join(root, 'restore');
    const names = [
        'business.sqlite',
        'authority.sqlite',
        'history.sqlite',
    ] as const;
    const batches = [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
    ] as const;
    const prompt = 'restore-source';
    const idempotencyKey = 'restore-source-key';
    let service: Awaited<ReturnType<typeof start>> | undefined;
    let sourceGrant: { request: WorkerRequest; key: string } | undefined;
    let nextRequest: WorkerRequest | undefined;
    let sourceCalls = 0;
    let restoreCalls = 0;
    let workerFailure: { error: unknown } | undefined;

    const turn = (number: number) => {
        const seq = (number - 1) * 2;
        return [
            {
                type: 'turn/start',
                seq,
                time: 1700000000001 + seq,
                data: { turn: number },
            },
            {
                type: 'turn/end',
                seq: seq + 1,
                time: 1700000000002 + seq,
                data: { turn: number, reason: { kind: 'completed' } },
            },
        ];
    };
    const events = [turn(1), turn(2)] as const;
    const receipts = batches.map((batch, index) => ({
        epoch: index + 1,
        batch,
        digest: createHash('sha256')
            .update(JSON.stringify(events[index]))
            .digest('hex'),
        first: index * 2,
        count: 2,
    }));
    const header = (id: string) => ({
        id,
        version: 4,
        createdAt: 1700000000000,
        isSeeded: false,
    });
    const sha256 = async (path: string) =>
        createHash('sha256')
            .update(await readFile(path))
            .digest('hex');

    async function call<T = unknown>(
        request: WorkerRequest,
        method: string,
        fields: object = {},
    ): Promise<T> {
        const response = await rpc(request, method, fields);
        assert.equal(response.status, 200, method);
        const result = (await response.json()) as { ok: boolean; value: T };
        assert.equal(result.ok, true, method);
        return result.value;
    }

    async function commitTurn(
        request: WorkerRequest,
        key: string,
        index: 0 | 1,
    ) {
        const fields = {
            key,
            batch: batches[index],
            events: events[index],
        };
        await call(request, 'stage', fields);
        assert.deepEqual(
            await call(request, 'append', fields),
            receipts[index],
        );
        assert.deepEqual(
            await call(request, 'append', fields),
            receipts[index],
        );
        assert.deepEqual(await call(request, 'reconcile', { key }), {
            outcome: 'already-committed',
            receipt: receipts[index],
        });
        await call(request, 'flush', { key });
        await call(request, 'close', { key });
    }

    function fixture(
        state: string,
        execute: (request: WorkerRequest) => Promise<void>,
    ): ExecutionHost {
        return {
            ...localHost(join(state, 'volume')),
            async worker(request) {
                try {
                    assert.equal(request.mode, 'execute');
                    await execute(request);
                    return 'completed';
                } catch (error) {
                    workerFailure ??= { error };
                    throw error;
                }
            },
        };
    }

    async function completed(api: ReturnType<typeof client>, runPath: string) {
        const response = await until(
            () => api(runPath),
            (value) => {
                if (workerFailure) throw workerFailure.error;
                return value.json().status === 'succeeded';
            },
            'restored fixture Run succeeded',
        );
        assert.equal(response.status, 200);
        return response.json();
    }

    function inspect(
        state: string,
        binding: WorkerRequest['binding'],
        runIds: string[],
        epoch: 1 | 2,
    ) {
        const read = (
            name: (typeof names)[number],
            query: (db: DatabaseSync) => void,
        ) => {
            const db = new DatabaseSync(join(state, name), {
                readOnly: true,
            });
            try {
                if (state === archive) {
                    assert.equal(
                        db.prepare('PRAGMA integrity_check').get()
                            ?.integrity_check,
                        'ok',
                    );
                    assert.deepEqual(
                        db.prepare('PRAGMA foreign_key_check').all(),
                        [],
                    );
                }
                query(db);
            } finally {
                db.close();
            }
        };
        read('business.sqlite', (db) => {
            const projects = db
                .prepare(
                    'SELECT owner AS tenant, id AS project, sessionId AS session, sandbox, volume FROM projects',
                )
                .all();
            assert.deepEqual(
                projects.map((row) => ({ ...row })),
                [binding],
            );
            const runs = db
                .prepare(
                    'SELECT id, projectId, sessionId, status, receipt FROM runs ORDER BY rowid',
                )
                .all();
            assert.deepEqual(
                runs.map((row) => ({ ...row })),
                runIds.map((id) => ({
                    id,
                    projectId: binding.project,
                    sessionId: binding.session,
                    status: 'succeeded',
                    receipt: 1,
                })),
            );
        });
        read('authority.sqlite', (db) => {
            const rows = db.prepare('SELECT * FROM execution_sessions').all();
            assert.deepEqual(
                rows.map((row) => ({ ...row })),
                [
                    {
                        ...binding,
                        generation: epoch + 1,
                        state: 'READY',
                        run: null,
                        capability: null,
                        expires: null,
                        retiring: 0,
                    },
                ],
            );
        });
        read('history.sqlite', (db) => {
            const sessions = db
                .prepare(
                    'SELECT id, header, epoch, owner, handle, next, revision, inherited, materialized FROM sessions',
                )
                .all();
            assert.deepEqual(
                sessions.map((row) => ({
                    ...row,
                    header: JSON.parse(String(row.header)),
                })),
                [
                    {
                        id: binding.session,
                        header: header(binding.session),
                        epoch,
                        owner: 'bento:revoked',
                        handle: null,
                        next: epoch * 2,
                        revision: epoch,
                        inherited: 0,
                        materialized: 1,
                    },
                ],
            );
            const storedEvents = db
                .prepare('SELECT id, seq, event FROM events ORDER BY seq')
                .all();
            assert.deepEqual(
                storedEvents.map((row) => ({
                    ...row,
                    event: JSON.parse(String(row.event)),
                })),
                events
                    .slice(0, epoch)
                    .flat()
                    .map((event) => ({
                        id: binding.session,
                        seq: event.seq,
                        event,
                    })),
            );
            const storedReceipts = db
                .prepare('SELECT * FROM batch_receipts ORDER BY epoch')
                .all();
            assert.deepEqual(
                storedReceipts.map((row) => ({ ...row })),
                receipts.slice(0, epoch).map((receipt) => ({
                    id: binding.session,
                    ...receipt,
                })),
            );
            assert.deepEqual(
                db.prepare('SELECT * FROM batch_intents').all(),
                [],
            );
        });
    }

    try {
        service = await start(
            source,
            fixture(source, async (request) => {
                sourceCalls++;
                assert.equal(request.grant.generation, 1);
                const { key } = await call<{ key: string }>(request, 'create', {
                    header: header(request.grant.session),
                });
                sourceGrant = { request, key };
                await commitTurn(request, key, 0);
            }),
        );
        const api = client(service.url);
        const projectPath = await project(api);
        const runPath = await submit(api, projectPath, prompt, idempotencyKey);
        const sourceDetail = await completed(api, runPath);
        assert.equal(sourceCalls, 1);
        assert(sourceGrant);
        const old = sourceGrant;
        const binding = old.request.binding;
        const runsPath = projectPath + '/runs';
        const replay = await api(runsPath, 'POST', { prompt }, idempotencyKey);
        assert.equal(replay.status, 200);
        const sourceReplay = replay.json();
        assert.equal(sourceReplay.id, sourceDetail.id);
        assert.equal(sourceReplay.status, 'succeeded');
        await service.close();
        service = undefined;

        await mkdir(archive, { mode: 0o700 });
        for (const name of names) {
            const db = new DatabaseSync(join(source, name), {
                readOnly: true,
            });
            try {
                await backup(db, join(archive, name));
            } finally {
                db.close();
            }
        }
        inspect(archive, binding, [sourceDetail.id], 1);
        await mkdir(restored, { mode: 0o700 });
        const digests = new Map<string, string>();
        for (const name of names) {
            const backupPath = join(archive, name);
            const target = join(restored, name);
            const digest = await sha256(backupPath);
            digests.set(name, digest);
            await copyFile(backupPath, target, constants.COPYFILE_EXCL);
            assert.equal(await sha256(target), digest);
        }
        const volume = join('volume', binding.project, 'volume');
        const data = await readFile(join(source, volume, 'README.md'));
        assert.deepEqual(data, Buffer.from('# Fixture\n'));
        await mkdir(join(restored, volume), {
            recursive: true,
            mode: 0o700,
        });
        const restoredFile = join(restored, volume, 'README.md');
        await writeFile(restoredFile, data, { flag: 'wx', mode: 0o600 });
        assert.deepEqual(await readFile(restoredFile), data);

        service = await start(
            restored,
            fixture(restored, async (request) => {
                restoreCalls++;
                nextRequest = request;
                assert.deepEqual(request.binding, binding);
                assert.equal(request.grant.generation, 2);
                const stale = { ...request, grant: old.request.grant };
                assert.equal(
                    (
                        await rpc(stale, 'append', {
                            key: old.key,
                            batch: batches[0],
                            events: events[0],
                        })
                    ).status,
                    403,
                );
                assert.equal(
                    (await rpc(stale, 'flush', { key: old.key })).status,
                    403,
                );
                assert.equal(
                    (await rpc(stale, 'close', { key: old.key })).status,
                    403,
                );
                assert.deepEqual(await call(request, 'stat'), {
                    header: header(binding.session),
                    eventCount: 2,
                    revision: '1',
                    formatStatus: 'current',
                });
                const { key } = await call<{ key: string }>(request, 'open', {
                    access: 'write',
                });
                assert.deepEqual(await call(request, 'read', { key }), {
                    eventState: 'detached',
                    events: events[0],
                });
                await commitTurn(request, key, 1);
            }),
        );
        const restoredApi = client(service.url);
        const restoredDetail = await restoredApi(runPath);
        assert.equal(restoredDetail.status, 200);
        assert.deepEqual(restoredDetail.json(), sourceDetail);
        const restoredReplay = await restoredApi(
            runsPath,
            'POST',
            { prompt },
            idempotencyKey,
        );
        assert.equal(restoredReplay.status, 200);
        assert.deepEqual(restoredReplay.json(), sourceReplay);
        const nextPath = await submit(
            restoredApi,
            projectPath,
            'restore-next',
            'restore-next-key',
        );
        assert.notEqual(nextPath, runPath);
        const nextDetail = await completed(restoredApi, nextPath);
        assert.equal(restoreCalls, 1);
        assert(nextRequest);
        assert.equal(nextRequest.grant.run, nextDetail.id);
        const list = await restoredApi(runsPath);
        assert.equal(list.status, 200);
        const { runs } = JSON.parse(list.text) as { runs: ResponseBody[] };
        assert.deepEqual(
            runs.map(({ id }) => id).sort(),
            [sourceDetail.id, nextDetail.id].sort(),
        );
        await service.close();
        service = undefined;
        inspect(restored, binding, [sourceDetail.id, nextDetail.id], 2);
        for (const [name, digest] of digests) {
            assert.equal(await sha256(join(archive, name)), digest);
            t.diagnostic(name + ' SHA-256 ' + digest);
        }
    } finally {
        try {
            await service?.close();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }
});

test('fixture recovery journals a verified volume and refuses overlap with an active writer', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'bento-task-host-'));
    const server = createServer(async (req, res) => {
        for await (const chunk of req) void chunk;
        if (req.url === '/operations') {
            res.writeHead(201).end();
            return;
        }
        res.end(JSON.stringify({ ok: true, value: { key: 'fixture' } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        server.close();
        server.closeAllConnections();
        await rm(directory, { recursive: true, force: true });
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}`;
    const binding = {
        tenant: 'tenant',
        project: randomUUID(),
        session: randomUUID(),
        sandbox: 'sandbox',
        volume: 'volume',
    };
    let host = localHost(directory);
    await host.provisionTask(binding, readme, host.environmentVersion);
    const grant = (generation: number) => ({
        run: randomUUID(),
        session: binding.session,
        generation,
        token: 'fixture',
    });
    const request = (generation: number): WorkerRequest => ({
        mode: 'execute',
        binding,
        grant: grant(generation),
        persistenceUrl: url,
        operationUrl: url,
        prompt: 'edited',
    });
    const preWrite = request(1);
    await assert.rejects(host.worker(preWrite, AbortSignal.abort()));
    assert.equal(
        await host.taskRecovery!.readFixtureWriteReceipt!(
            binding,
            preWrite.grant.run,
            1,
        ),
        null,
    );
    assert.deepEqual(await host.snapshot(binding), readme);

    const writes = join(directory, binding.project, 'writes');
    await writeFile(writes, 'block receipt directory');
    const unknown = request(2);
    await assert.rejects(host.worker(unknown, new AbortController().signal));
    await rm(writes);
    assert.equal(
        await host.taskRecovery!.readFixtureWriteReceipt!(
            binding,
            unknown.grant.run,
            2,
        ),
        null,
    );
    assert.match((await host.snapshot(binding))[0]!.text, /edited\n$/);

    const run = request(3);
    const attemptId = randomUUID();
    const digest = snapshotSha256(readme);
    const marker = join(directory, binding.project, 'running');
    const beforeFailedStop = await host.snapshot(binding);
    await rm(marker);
    await mkdir(marker);
    await assert.rejects(
        host.taskRecovery!.restoreTask(binding, attemptId, readme, digest),
    );
    assert.deepEqual(await host.snapshot(binding), beforeFailedStop);
    assert.equal(
        await host.taskRecovery!.queryRestore(binding, attemptId),
        null,
    );
    await rm(marker, { recursive: true });
    await host.provisionTask(binding, readme, host.environmentVersion);
    const execution = host.worker(run, new AbortController().signal);
    await assert.rejects(
        host.taskRecovery!.restoreTask(binding, attemptId, readme, digest),
        /active writer/,
    );
    assert.equal(await execution, 'completed');
    const receipt = await host.taskRecovery!.readFixtureWriteReceipt!(
        binding,
        run.grant.run,
        3,
    );
    assert(receipt);
    assert.equal(
        receipt.fileSha256,
        createHash('sha256')
            .update((await host.snapshot(binding))[0]!.text)
            .digest('hex'),
    );
    host = localHost(directory);
    assert.deepEqual(
        await host.taskRecovery!.readFixtureWriteReceipt!(
            binding,
            run.grant.run,
            3,
        ),
        receipt,
    );
    assert(await host.observeWorkerExit!(binding, run.grant.run, 3));
    await assert.rejects(
        host.taskRecovery!.restoreTask(
            binding,
            attemptId,
            readme,
            'f'.repeat(64),
        ),
        /input digest/,
    );
    assert.deepEqual(
        await host.taskRecovery!.restoreTask(
            binding,
            attemptId,
            readme,
            digest,
        ),
        { attemptId, sha256: digest },
    );
    host = localHost(directory);
    assert.deepEqual(
        await host.taskRecovery!.queryRestore(binding, attemptId),
        { attemptId, phase: 'ready', sha256: digest },
    );
    assert.deepEqual(
        await host.taskRecovery!.restoreTask(
            binding,
            attemptId,
            readme,
            digest,
        ),
        { attemptId, sha256: digest },
    );
    assert.deepEqual(await host.snapshot(binding), readme);
});

test('prepared restore validates staging before changing the published pointer', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'bento-task-stage-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const binding = {
        tenant: 'tenant',
        project: randomUUID(),
        session: randomUUID(),
        sandbox: 'sandbox',
        volume: 'volume',
    };
    const host = localHost(directory);
    await host.provisionTask(binding, readme, host.environmentVersion);
    const root = join(directory, binding.project);
    const pointer = join(root, 'task-volume');
    const previousVolume = await readlink(pointer);
    const attemptId = randomUUID();
    const stagedVolume = 'volume-' + attemptId;
    await mkdir(join(root, stagedVolume));
    await writeFile(join(root, stagedVolume, 'README.md'), 'damaged staging');
    await mkdir(join(root, 'restores'));
    const sha256 = snapshotSha256(readme);
    await writeFile(
        join(root, 'restores', attemptId + '.json'),
        JSON.stringify({
            attemptId,
            phase: 'prepared',
            sha256,
            bindingDigest: executionBindingDigest(binding),
            previousVolume,
            stagedVolume,
        }),
    );
    const restarted = localHost(directory);
    await assert.rejects(
        restarted.taskRecovery!.restoreTask(binding, attemptId, readme, sha256),
        (error: unknown) =>
            error instanceof TaskRestoreEvidenceConflict &&
            /staging differs/.test(error.message),
    );
    assert.equal(await readlink(pointer), previousVolume);
    assert.deepEqual(await restarted.snapshot(binding), readme);
    await rm(join(root, stagedVolume), { recursive: true });
    await assert.rejects(
        restarted.taskRecovery!.restoreTask(binding, attemptId, readme, sha256),
        TaskRestoreEvidenceConflict,
    );
    assert.equal(await readlink(pointer), previousVolume);
    assert.deepEqual(await restarted.snapshot(binding), readme);
});
