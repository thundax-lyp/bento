import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prewarmedWorker } from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/warm-worker.ts';
import type { WorkerRequest } from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/types.ts';
import { until } from './fixtures/service.ts';

test(
    'warm Worker abort closes only the selected slot',
    { timeout: 10_000 },
    async (t) => {
        const root = await mkdtemp(join(tmpdir(), 'bento-warm-cancel-'));
        const fixture = join(root, 'worker.cjs');
        await writeFile(
            fixture,
            `
        const { createInterface } = require('node:readline');
        const { existsSync, writeFileSync } = require('node:fs');
        const { join } = require('node:path');
        createInterface({ input: process.stdin }).on('line', line => {
            const { grant: { run } } = JSON.parse(line);
            writeFileSync(join(process.argv[2], run), String(process.pid));
            const timer = setInterval(() => {
                if (!existsSync(join(process.argv[2], run + '.release'))) return;
                clearInterval(timer);
                console.log('completed');
            }, 10);
        });
        console.log('ready');
    `,
        );
        const host = prewarmedWorker(
            { command: process.execPath, args: [fixture, root] },
            2,
        );
        const lifetime = new AbortController();
        const close = host.warmWorker(lifetime.signal);
        t.after(async () => {
            lifetime.abort();
            await close();
            await rm(root, { recursive: true, force: true });
        });
        const request = (run: string): WorkerRequest => ({
            grant: { token: 'fixture', session: run, run, generation: 1 },
            binding: {
                tenant: run,
                project: run,
                session: run,
                volume: run,
                sandbox: run,
            },
            mode: 'execute',
            prompt: 'fixture',
            operationUrl: 'http://fixture.invalid',
            persistenceUrl: 'http://fixture.invalid',
        });
        const a = new AbortController();
        const b = new AbortController();
        let exited = false;
        const first = assert.rejects(
            host.worker(request('a'), a.signal, 0, () => {
                exited = true;
            }),
        );
        const second = host.worker(request('b'), b.signal, 1);
        const pid = async (run: string) =>
            until(
                () => readFile(join(root, run), 'utf8').then(Number, () => 0),
                (value) => value > 0,
                'Worker PID',
            );
        const [pidA, pidB] = await Promise.all([pid('a'), pid('b')]);
        assert.notEqual(pidA, pidB);
        a.abort();
        await first;
        assert.equal(exited, true);
        assert.throws(() => process.kill(pidA, 0), { code: 'ESRCH' });
        assert.equal(process.kill(pidB, 0), true);
        await writeFile(join(root, 'b.release'), '');
        assert.equal(await second, 'completed');
        assert.equal(await pid('b'), pidB);
    },
);
