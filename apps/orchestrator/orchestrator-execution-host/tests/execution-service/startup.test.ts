import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { localEnvironmentVersion } from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/local.ts';
import { commandHost } from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/command-host.ts';
import { testToken, client, until } from './fixtures/service.ts';
import {
    taskRetryTestClient,
    taskRetryTestInput,
} from './fixtures/task-retry.ts';

test('documented startup installs trusted review and waits for its cleanup', async () => {
    const state = await mkdtemp(join(tmpdir(), 'bento-start-review-'));
    const module = join(state, 'review.mjs');
    const marker = join(state, 'review-result');
    await writeFile(
        module,
        `
            import { writeFile } from 'node:fs/promises';
            export default function install(reviewRun) {
                const review = reviewRun({ failedGeneration: 0 }).then(
                    () => 'unexpected approval',
                    (error) => error.message,
                );
                return async () => writeFile(process.env.BENTO_TEST_REVIEW_RESULT, await review);
            }
        `,
    );
    const controller = spawn(
        process.execPath,
        [
            ...process.execArgv,
            fileURLToPath(
                new URL(
                    '../../src/execution-service/start.ts',
                    import.meta.url,
                ),
            ),
            '--local',
        ],
        {
            env: {
                ...process.env,
                BENTO_STATE_DIR: state,
                BENTO_EXECUTION_ENVIRONMENT_VERSION: localEnvironmentVersion,
                BENTO_SERVICE_BEARER: testToken,
                BENTO_PORT: '0',
                BENTO_REVIEW_MODULE: module,
                BENTO_TEST_REVIEW_RESULT: marker,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    const closed = once(controller, 'close');
    const lines = createInterface({ input: controller.stdout });
    try {
        const [url] = await Promise.race([
            once(lines, 'line'),
            closed.then(() => {
                throw new Error('Execution service exited before listening');
            }),
        ]);
        assert.equal((await client(url)('')).status, 200);
        controller.kill('SIGTERM');
        assert.deepEqual(await closed, [0, null]);
        assert.equal(await readFile(marker, 'utf8'), 'Invalid review proof');
    } finally {
        controller.kill('SIGKILL');
        await closed;
        lines.close();
        await rm(state, { recursive: true, force: true });
    }
});

test('startup requires the trusted host environment version', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'bento-task-start-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const { BENTO_EXECUTION_ENVIRONMENT_VERSION: _version, ...env } =
        process.env;
    void _version;
    for (const version of [undefined, 'sha256:' + 'f'.repeat(64)]) {
        const state = join(directory, version ? 'mismatch' : 'missing');
        const child = spawn(
            process.execPath,
            [
                ...process.execArgv,
                fileURLToPath(
                    new URL(
                        '../../src/execution-service/start.ts',
                        import.meta.url,
                    ),
                ),
                '--local',
            ],
            {
                env: {
                    ...env,
                    BENTO_STATE_DIR: state,
                    BENTO_SERVICE_BEARER: testToken,
                    ...(version
                        ? { BENTO_EXECUTION_ENVIRONMENT_VERSION: version }
                        : {}),
                },
                stdio: 'ignore',
            },
        );
        assert.deepEqual(await once(child, 'close'), [1, null]);
        await assert.rejects(readFile(join(state, 'business.sqlite')), {
            code: 'ENOENT',
        });
    }
});

test('recovery owner gates the normal service startup before opening state', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'bento-recovery-gate-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const gate = join(root, 'gate.json');
    const command = join(root, 'owner');
    const reply = join(root, 'owner.json');
    const owner = {
        host: 'backup',
        epoch: 2,
        checkpoint: 'a'.repeat(64),
        isolation: 'b'.repeat(64),
    };
    await writeFile(
        command,
        '#!/bin/sh\n[ "$1" = test-deployment ] && cat "$(dirname "$0")/owner.json"\n',
        { mode: 0o700 },
    );
    await writeFile(
        gate,
        JSON.stringify({
            deployment: 'test-deployment',
            authorityCommand: command,
            ...owner,
        }),
    );

    function start(state: string) {
        return spawn(
            process.execPath,
            [
                ...process.execArgv,
                fileURLToPath(
                    new URL(
                        '../../src/execution-service/start.ts',
                        import.meta.url,
                    ),
                ),
                '--local',
            ],
            {
                env: {
                    ...process.env,
                    BENTO_STATE_DIR: state,
                    BENTO_EXECUTION_ENVIRONMENT_VERSION:
                        localEnvironmentVersion,
                    BENTO_SERVICE_BEARER: testToken,
                    BENTO_PORT: '0',
                    BENTO_RECOVERY_GATE: gate,
                },
                stdio: ['ignore', 'pipe', 'ignore'],
            },
        );
    }

    const rejected = join(root, 'rejected');
    for (const mismatch of [
        undefined,
        { ...owner, host: 'source' },
        { ...owner, epoch: owner.epoch - 1 },
        { ...owner, checkpoint: 'c'.repeat(64) },
        { ...owner, isolation: 'd'.repeat(64) },
    ]) {
        if (mismatch) await writeFile(reply, JSON.stringify(mismatch));
        assert.deepEqual(await once(start(rejected), 'close'), [1, null]);
        await assert.rejects(readFile(join(rejected, 'business.sqlite')), {
            code: 'ENOENT',
        });
    }

    await writeFile(reply, JSON.stringify(owner));
    const child = start(join(root, 'accepted'));
    const closed = once(child, 'close');
    const lines = createInterface({ input: child.stdout });
    try {
        const [url] = await Promise.race([
            once(lines, 'line'),
            closed.then(() => {
                throw new Error('Current owner did not start');
            }),
        ]);
        assert.equal((await client(url)('')).status, 200);
        child.kill('SIGTERM');
        assert.deepEqual(await closed, [0, null]);
    } finally {
        child.kill('SIGKILL');
        await closed;
        lines.close();
    }
});

test('command host requests the frozen environment and exposes no fixture recovery', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'bento-command-version-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const protobuf = join(directory, 'node_modules', '@bufbuild', 'protobuf');
    await mkdir(protobuf, { recursive: true });
    await writeFile(
        join(protobuf, 'index.js'),
        'module.exports = { fromBinary() {} };',
    );
    await writeFile(join(directory, 'raw.mjs'), 'export {};');
    await writeFile(join(directory, 'local-material'), 'fixture');
    const control = join(directory, 'control.cjs');
    await writeFile(
        control,
        `
        let json = '';
        process.stdin.on('data', chunk => json += chunk);
        process.stdin.on('end', () => {
            const {action,binding,environmentVersion} = JSON.parse(json);
            if (action !== 'provisionTask') process.exit(1);
            process.stdout.write(JSON.stringify({
                sandbox:binding.sandbox,volume:binding.volume,running:true,installed:true,
                environmentVersion:environmentVersion === 'bad' ? 'other' : environmentVersion,
            }));
        });
    `,
    );
    const configPath = join(directory, 'host.json');
    const settings = {
        imageDigest: 'sha256:' + '0'.repeat(64),
        policyDigest: 'sha256:' + '1'.repeat(64),
        gateway: 'https://fixture.invalid',
        workspace: 'workspace',
        ca: 'local-material',
        cert: 'local-material',
        key: 'local-material',
        sdkRaw: 'raw.mjs',
        control: { command: process.execPath, args: [control] },
        worker: { command: process.execPath, args: [control] },
    };
    await writeFile(
        configPath,
        JSON.stringify({ ...settings, imageDigest: 'invalid' }),
    );
    await assert.rejects(
        commandHost(configPath),
        /Invalid execution environment identity/,
    );
    await writeFile(configPath, JSON.stringify(settings));
    const host = await commandHost(configPath);
    assert.equal(host.environmentVersion, localEnvironmentVersion);
    assert.equal(host.taskRecovery, undefined);
    assert.equal(host.observeWorkerExit, undefined);
    assert.equal(host.taskCancellationRequiresTrustedObservation, true);
    const prewarmed = { ...settings, prewarmWorker: true };
    await writeFile(configPath, JSON.stringify(prewarmed));
    const warmHost = await commandHost(configPath);
    assert.equal(warmHost.supportsRunningCancellation, true);
    assert.equal(warmHost.supportsTaskRunningCancellation, undefined);
    const taskObservationModule = 'observations.mjs';
    await writeFile(
        join(directory, taskObservationModule),
        'export default {};',
    );
    await writeFile(
        configPath,
        JSON.stringify({ ...settings, taskObservationModule }),
    );
    await assert.rejects(
        commandHost(configPath),
        /require a module and warm workers/,
    );
    await writeFile(
        configPath,
        JSON.stringify({ ...prewarmed, taskObservationModule }),
    );
    await assert.rejects(
        commandHost(configPath),
        /Invalid trusted Task observation module/,
    );
    const completeModule = 'observations-complete.mjs';
    await writeFile(
        join(directory, completeModule),
        `
        const noObservation = async () => null;
        export default {
            observeWorkerExit: noObservation,
            observeTaskVolumeStopped: noObservation,
            taskRecovery: {
                retryObservation: noObservation,
                queryRestore: noObservation,
                restoreTask: noObservation,
                observeSdkRetrySafety: noObservation,
            },
        };
    `,
    );
    await writeFile(
        configPath,
        JSON.stringify({ ...prewarmed, taskObservationModule: completeModule }),
    );
    const observing = await commandHost(configPath);
    assert.equal(observing.supportsRunningCancellation, true);
    assert.equal(observing.supportsTaskRunningCancellation, true);
    assert.equal(observing.taskCancellationRequiresTrustedObservation, true);

    const binding = {
        tenant: 'tenant',
        project: randomUUID(),
        session: randomUUID(),
        sandbox: 'sandbox',
        volume: 'volume',
    };
    const frozen = 'sha256:' + 'e'.repeat(64);
    assert.equal(
        (await host.provisionTask(binding, [], frozen)).environmentVersion,
        frozen,
    );
    await assert.rejects(
        host.provisionTask(binding, [], 'bad'),
        /observation mismatch/,
    );
});

test('startup registers the seven trusted review callbacks only in process', async (t) => {
    const state = await mkdtemp(join(tmpdir(), 'bento-task-review-module-'));
    const module = join(state, 'review.mjs');
    const marker = join(state, 'review-callbacks');
    await writeFile(
        module,
        `
        import { writeFile } from 'node:fs/promises';
        export default function install(...callbacks) {
            const types = callbacks.map(callback => typeof callback);
            if (callbacks[2]('missing') !== null || callbacks[4]('missing') !== null)
                throw new Error('Unexpected audit receipt');
            return () => writeFile(process.env.BENTO_TEST_REVIEW_RESULT,JSON.stringify(types));
        }
    `,
    );
    const child = spawn(
        process.execPath,
        [
            ...process.execArgv,
            fileURLToPath(
                new URL(
                    '../../src/execution-service/start.ts',
                    import.meta.url,
                ),
            ),
            '--local',
        ],
        {
            env: {
                ...process.env,
                BENTO_STATE_DIR: state,
                BENTO_SERVICE_BEARER: testToken,
                BENTO_PORT: '0',
                BENTO_EXECUTION_ENVIRONMENT_VERSION: localEnvironmentVersion,
                BENTO_REVIEW_MODULE: module,
                BENTO_TEST_REVIEW_RESULT: marker,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    const closed = once(child, 'close');
    const lines = createInterface({ input: child.stdout });
    t.after(async () => {
        child.kill('SIGKILL');
        await closed;
        lines.close();
        await rm(state, { recursive: true, force: true });
    });
    const [url] = await Promise.race([
        once(lines, 'line'),
        closed.then(() => {
            throw new Error('Review fixture failed to start');
        }),
    ]);
    for (const endpoint of [
        '/v1/tasks/closure',
        '/v1/task-retries/reconcile',
        '/api/tasks/closure',
    ]) {
        const res = await fetch(url + endpoint, {
            headers: {
                authorization: 'Bearer ' + testToken,
                'x-bento-owner-id': 'account-a',
            },
        });
        assert.equal(res.status, 404);
    }
    child.kill('SIGTERM');
    assert.deepEqual(await closed, [0, null]);
    assert.deepEqual(
        JSON.parse(await readFile(marker, 'utf8')),
        Array(7).fill('function'),
    );
});

test(
    'trusted pending review consumer receives one durable record across restart',
    { timeout: 15_000 },
    async (t) => {
        const state = await mkdtemp(join(tmpdir(), 'bento-review-notice-'));
        const reviewPath = join(state, 'review.mjs');
        const hostPath = join(state, 'host.mjs');
        const receiptPath = join(state, 'received.sqlite');
        const pollPath = join(state, 'poll.json');
        const commandPath = join(state, 'close.json');
        const localModule = new URL(
            '../../src/execution-service/local.ts',
            import.meta.url,
        ).href;
        await writeFile(
            hostPath,
            `
        import { localHost } from ${JSON.stringify(localModule)};
        import { join } from 'node:path';
        export default function make({ state }) {
            const base = localHost(join(state, 'volume'));
            return { ...base,
                sdk: { upstream: new URL('https://127.0.0.1:1'), workspace: 'default',
                    credentials: { ca: Buffer.alloc(0), cert: Buffer.alloc(0), key: Buffer.alloc(0) },
                    decode() { throw new Error('unexpected gateway call'); },
                },
                async worker(request, signal, slot, onExit) {
                    if (request.mode === 'recover') return 'recovered';
                    await base.worker(request, signal, slot, onExit);
                    return 'review';
                },
            };
        }
    `,
        );
        await writeFile(
            reviewPath,
            `
        import { DatabaseSync } from 'node:sqlite';
        import { readFile, rename, writeFile } from 'node:fs/promises';
        export default function install(_review,close,_read,_retry,_audit,_reconcile,list) {
            const db = new DatabaseSync(process.env.BENTO_TEST_REVIEW_RECEIPTS);
            db.exec('CREATE TABLE IF NOT EXISTS received (runId TEXT PRIMARY KEY, updatedAt TEXT NOT NULL)');
            const record = db.prepare('INSERT OR IGNORE INTO received VALUES (?,?)');
            let inFlight = Promise.resolve();
            const timer = setInterval(() => {
                inFlight = inFlight.then(async () => {
                    const rows = list();
                    for (const { runId, updatedAt } of rows) record.run(runId, updatedAt);
                    const output = process.env.BENTO_TEST_REVIEW_POLL;
                    await writeFile(output+'.tmp', JSON.stringify({ pid:process.pid, rows }));
                    await rename(output+'.tmp', output);
                    const raw = await readFile(process.env.BENTO_TEST_REVIEW_COMMAND, 'utf8').catch(error => {
                        if (error.code === 'ENOENT') return null;
                        throw error;
                    });
                    if (raw) await close(JSON.parse(raw));
                });
            },1000);
            return async () => {
                clearInterval(timer);
                await inFlight;
                db.close();
            };
        }
    `,
        );
        const executable = fileURLToPath(
            new URL('../../src/execution-service/start.ts', import.meta.url),
        );
        const started: { stop: () => Promise<void> }[] = [];
        t.after(async () => {
            for (const controller of started) await controller.stop();
            await rm(state, { recursive: true, force: true });
        });
        async function startProcess() {
            const child = spawn(
                process.execPath,
                [...process.execArgv, executable],
                {
                    env: {
                        ...process.env,
                        BENTO_STATE_DIR: state,
                        BENTO_SERVICE_BEARER: testToken,
                        BENTO_PORT: '0',
                        BENTO_EXECUTION_ENVIRONMENT_VERSION:
                            localEnvironmentVersion,
                        BENTO_HOST_MODULE: hostPath,
                        BENTO_REVIEW_MODULE: reviewPath,
                        BENTO_TEST_REVIEW_RECEIPTS: receiptPath,
                        BENTO_TEST_REVIEW_POLL: pollPath,
                        BENTO_TEST_REVIEW_COMMAND: commandPath,
                    },
                    stdio: ['ignore', 'pipe', 'pipe'],
                },
            );
            const closed = once(child, 'close');
            const lines = createInterface({ input: child.stdout });
            const controller = {
                async stop() {
                    if (child.exitCode === null && child.signalCode === null)
                        child.kill('SIGTERM');
                    assert.deepEqual(await closed, [0, null]);
                    lines.close();
                },
            };
            started.push(controller);
            const [url] = await Promise.race([
                once(lines, 'line'),
                closed.then(() => {
                    throw new Error('Review consumer fixture exited');
                }),
            ]);
            return { ...controller, pid: child.pid, url: url as string };
        }
        const poll = async () =>
            JSON.parse(await readFile(pollPath, 'utf8').catch(() => 'null'));
        function receipts() {
            const db = new DatabaseSync(receiptPath, { readOnly: true });
            try {
                return db
                    .prepare('SELECT * FROM received ORDER BY runId')
                    .all();
            } finally {
                db.close();
            }
        }
        const first = await startProcess();
        const api = taskRetryTestClient(() => first.url);
        const created = await api(
            '/tasks',
            'POST',
            taskRetryTestInput(),
            randomUUID(),
        );
        assert.equal(created.status, 202, created.text);
        const taskPath = '/tasks/' + created.json().task.id;
        await until(
            () => api(taskPath),
            (value) => value.json().task.status === 'ready',
            'Task is ready',
        );
        const submitted = await api(
            taskPath + '/runs',
            'POST',
            { prompt: 'noop' },
            randomUUID(),
        );
        assert.equal(submitted.status, 202, submitted.text);
        const runId = submitted.json().run.id as string;
        const runPath = taskPath + '/runs/' + runId;
        const received = await until(
            poll,
            (value) =>
                value?.pid === first.pid &&
                value.rows.some(
                    (row: { runId: string }) => row.runId === runId,
                ),
            'Trusted review received',
        );
        assert.equal(received.rows.length, 1);
        assert.deepEqual(Object.keys(received.rows[0]).sort(), [
            'runId',
            'updatedAt',
        ]);
        assert.deepEqual(
            receipts().map((row) => ({ ...row })),
            received.rows,
        );
        await first.stop();
        const second = await startProcess();
        const reopened = taskRetryTestClient(() => second.url);
        const seenAgain = await until(
            poll,
            (value) => value?.pid === second.pid && value.rows.length === 1,
            'Review receipt after restart',
        );
        assert.deepEqual(seenAgain.rows, received.rows);
        assert.equal(receipts().length, 1);
        assert.equal((await reopened('/review/pending')).status, 404);
        await writeFile(
            commandPath,
            JSON.stringify({
                runId,
                decision: 'failed',
                expectedGeneration: 3,
            }),
        );
        await until(
            poll,
            (value) => value?.pid === second.pid && !value.rows.length,
            'Decided review removed',
        );
        assert.equal((await reopened(runPath)).json().run.status, 'failed');
        assert.equal(receipts().length, 1);
    },
);
