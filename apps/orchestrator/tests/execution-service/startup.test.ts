import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { localEnvironmentVersion } from '@/apps/orchestrator/execution-service/local.ts';
import { commandHost } from '@/apps/orchestrator/execution-service/command-host.ts';
import { testToken, client } from './fixtures/service.ts';

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
                new URL('../../execution-service/start.ts', import.meta.url),
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
                        '../../execution-service/start.ts',
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

test('startup registers the six trusted review callbacks only in process', async (t) => {
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
                new URL('../../execution-service/start.ts', import.meta.url),
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
        Array(6).fill('function'),
    );
});
