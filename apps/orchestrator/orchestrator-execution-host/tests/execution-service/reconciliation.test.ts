import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { localHost } from '@orchestrator/execution-service/local.ts';
import { serveExecution } from '@orchestrator/execution-service/service.ts';
import { type ExecutionHost } from '@orchestrator/execution-service/types.ts';
import {
    testToken,
    readme,
    client,
    until,
    project,
    submit,
    start,
} from './fixtures/service.ts';

const temporalBinary = process.env.BENTO_TEST_TEMPORAL_BINARY;

test(
    'Temporal Activity retries a completed Run without repeating its effect',
    { timeout: 25_000, skip: !temporalBinary },
    async () => {
        assert(temporalBinary);
        const state = await mkdtemp(join(tmpdir(), 'bento-temporal-retry-'));
        const controlEnv = process.env.BENTO_GO_CONTROL;
        const reportEnv = process.env.BENTO_TEST_TEMPORAL_REPORT;
        const reportPath = join(state, 'report.json');
        let service: Awaited<ReturnType<typeof serveExecution>> | undefined;
        try {
            const wrapper = join(state, 'control');
            const quote = (value: string) =>
                "'" + value.replaceAll("'", "'\"'\"'") + "'";
            await writeFile(
                wrapper,
                '#!/bin/sh\nexec ' +
                    [
                        temporalBinary,
                        '-test.run=^TestTemporalRetryControlProcess$',
                    ]
                        .map(quote)
                        .join(' ') +
                    '\n',
                { mode: 0o700 },
            );
            process.env.BENTO_GO_CONTROL = wrapper;
            process.env.BENTO_TEST_TEMPORAL_REPORT = reportPath;
            const base = localHost(join(state, 'volume'));
            let workerCalls = 0;
            service = await serveExecution({
                state,
                host: {
                    ...base,
                    async worker(request, signal) {
                        workerCalls++;
                        return base.worker(request, signal);
                    },
                },
                token: testToken,
                retryMs: 20,
                workerTimeoutMs: 15_000,
                temporal: { address: 'fixture', taskQueue: 'fixture' },
            });
            const api = client(service.url);
            const target = await project(api);
            const run = await submit(api, target, 'retry effect', 'retry');
            const runId = run.split('/').at(-1);
            const deadline = performance.now() + 12_000;
            let report: unknown;
            for (;;) {
                try {
                    report = JSON.parse(await readFile(reportPath, 'utf8'));
                    break;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                        throw error;
                    if (performance.now() >= deadline)
                        throw new Error(
                            `Timed out after 12 seconds waiting for Temporal report for Run ${runId}`,
                            { cause: error },
                        );
                    await delay(20);
                }
            }
            assert.deepEqual(report, {
                runId,
                replyIds: ['go-1', 'go-2'],
            });
            const detail = await api(run);
            assert.equal(detail.status, 200);
            assert.equal(detail.json().status, 'succeeded');
            const diff = await api(run + '/diff');
            assert.equal(diff.status, 200);
            assert.equal(diff.text.match(/^\+retry effect$/gm)?.length, 1);
            assert.equal(
                await readFile(
                    join(
                        state,
                        'volume',
                        target.slice(1),
                        'volume',
                        'README.md',
                    ),
                    'utf8',
                ),
                '# Fixture\nretry effect\n',
            );
            assert.equal(workerCalls, 1);
        } finally {
            try {
                await service?.close();
            } finally {
                if (controlEnv === undefined)
                    delete process.env.BENTO_GO_CONTROL;
                else process.env.BENTO_GO_CONTROL = controlEnv;
                if (reportEnv === undefined)
                    delete process.env.BENTO_TEST_TEMPORAL_REPORT;
                else process.env.BENTO_TEST_TEMPORAL_REPORT = reportEnv;
                await rm(state, { recursive: true, force: true });
            }
        }
    },
);

test('private project initialization replays the same project after controller restart', async () => {
    const state = await mkdtemp(join(tmpdir(), 'bento-project-replay-'));
    const host = localHost(join(state, 'volume'));
    let service = await start(state, host);
    const key = 'space-initialization-key';
    const input = { name: 'Space project', files: readme };
    try {
        const first = await client(service.url)('', 'POST', input, key);
        assert.equal(first.status, 201);
        await service.close();
        service = await start(state, host);
        const api = client(service.url);
        const retry = await api('', 'POST', input, key);
        assert.equal(retry.status, 200);
        assert.equal(retry.json().id, first.json().id);
        assert.equal(
            (await api('', 'POST', { ...input, name: 'Other input' }, key))
                .status,
            409,
        );
        assert.deepEqual(
            (await api('')).json().projects?.map((row) => row.id),
            [first.json().id],
        );
        const otherOwner = await client(service.url, 'account-b')(
            '',
            'POST',
            input,
            key,
        );
        assert.equal(otherOwner.status, 201);
        assert.notEqual(otherOwner.json().id, first.json().id);
    } finally {
        await service.close();
        await rm(state, { recursive: true, force: true });
    }
});

test('a completed Run retries capture after restart without rerunning its worker', async () => {
    const state = await mkdtemp(join(tmpdir(), 'bento-capture-retry-'));
    const base = localHost(join(state, 'volume'));
    let calls = 0;
    let failCapture = false;
    const host: ExecutionHost = {
        ...base,
        async worker(request, signal) {
            calls++;
            const result = await base.worker(request, signal);
            failCapture = calls === 1;
            return result;
        },
        async snapshot(binding) {
            if (failCapture)
                throw new Error('Snapshot temporarily unavailable');
            return base.snapshot(binding);
        },
    };
    let service = await start(state, host);
    try {
        const first = client(service.url);
        const path = await project(first);
        const run = await submit(first, path, 'first change', 'first');
        await until(
            () => first(run),
            (r) => r.json().status === 'needs_review',
            'capture failed',
        );
        await service.close();
        failCapture = false;
        service = await start(state, host);
        const api = client(service.url);
        await until(
            () => api(run),
            (r) => r.json().status === 'succeeded',
            'capture retried',
        );
        assert.match((await api(run + '/diff')).text, /\+first change/);
        assert.equal(calls, 1);
        const next = await submit(api, path, 'next change', 'next');
        await until(
            () => api(next),
            (r) => r.json().status === 'succeeded',
            'next Run completed',
        );
    } finally {
        await service.close();
        await rm(state, { recursive: true, force: true });
    }
});
