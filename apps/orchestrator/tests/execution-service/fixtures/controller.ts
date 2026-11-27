import assert from 'node:assert/strict';
import { openSync, closeSync, fsyncSync, writeSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { localHost } from '@/apps/orchestrator/src/execution-service/local.ts';
import { type WorkerRequest } from '@/apps/orchestrator/src/execution-service/types.ts';
import { processWorker } from '@/apps/orchestrator/src/execution-service/worker.ts';
import { reserveOperation } from '@/apps/worker/protocol.ts';
import { fixtureSdk, rpc, start } from './service.ts';

const testFile = fileURLToPath(import.meta.url);

async function effectWorker(state: string) {
    const parts: Buffer[] = [];
    for await (const part of process.stdin) parts.push(part as Buffer);
    const request = JSON.parse(
        Buffer.concat(parts).toString('utf8'),
    ) as WorkerRequest;
    assert.equal(request.mode, 'execute');
    const created = await rpc(request, 'create', {
        header: {
            id: request.grant.session,
            version: 4,
            createdAt: Date.now(),
            isSeeded: false,
        },
    });
    assert.equal(created.status, 200);
    const result = (await created.json()) as {
        ok: boolean;
        value: { key: string };
    };
    assert(result.ok);
    await writeFile(
        join(state, 'old-grant.json'),
        JSON.stringify({ request, key: result.value.key }),
        { mode: 0o600 },
    );
    assert.equal(
        await reserveOperation(request, 'fault-effect', 'append'),
        true,
    );
    const file = openSync(
        join(state, 'volume', request.binding.project, 'volume', 'README.md'),
        'a',
    );
    writeSync(file, 'once\n');
    fsyncSync(file);
    closeSync(file);
    process.exit(73);
}

async function crashController(state: string) {
    const base = localHost(join(state, 'volume'));
    const service = await start(state, {
        ...base,
        sdk: fixtureSdk,
        worker: processWorker({
            command: process.execPath,
            args: [...process.execArgv, testFile, '--effect-worker', state],
        }),
        async stop(binding) {
            await base.stop(binding);
            await writeFile(join(state, 'stop-observed'), '');
            throw new Error('Lost stop acknowledgment');
        },
        async stopped() {
            return false;
        },
    });
    process.stdout.write(service.url + '\n');
}

async function projectDeleteControlFixture(counter: string) {
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
        const { id, method } = JSON.parse(line) as {
            id: string;
            method: string;
        };
        let result: { value: unknown } | { error: string } = { value: null };
        if (method === 'purge') {
            const count =
                Number(await readFile(counter, 'utf8').catch(() => '0')) + 1;
            await writeFile(counter, String(count));
            result =
                count === 2
                    ? { error: 'Unconfirmed workflow deletion' }
                    : { value: count >= 3 };
        } else if (method !== 'start' && method !== 'close') {
            result = { error: 'Unexpected control method' };
        }
        process.stdout.write(JSON.stringify({ id, ...result }) + '\n');
        if (method === 'close') break;
    }
}

async function taskCrashController(state: string, fault: string) {
    const base = localHost(join(state, 'volume'));
    const service = await start(state, {
        ...base,
        taskRecovery: {
            ...base.taskRecovery!,
            async retryObservation(...args) {
                if (fault === 'after-authority') process.exit(79);
                return base.taskRecovery!.retryObservation(...args);
            },
        },
        async worker(request, signal, slot) {
            if (request.mode !== 'execute')
                return base.worker(request, signal, slot);
            if (fault === 'before-write') {
                assert(
                    await reserveOperation(
                        request,
                        'local-demo',
                        request.prompt!,
                        signal,
                    ),
                );
                process.exit(79);
            }
            if (fault === 'before-receipt') {
                // The fixture write reaches the volume but cannot save its evidence.
                await writeFile(
                    join(state, 'volume', request.binding.project, 'writes'),
                    'receipt fault',
                );
                await base.worker(request, signal, slot).catch(() => {});
                process.exit(79);
            }
            await base.worker(request, signal, slot);
            if (fault === 'before-authority') process.exit(79);
            // The host exit and write receipts exist; there is no successful Run receipt.
            return 'review';
        },
    });
    process.stdout.write(service.url + '\n');
}

if (process.argv[2] === '--effect-worker') {
    await effectWorker(process.argv[3] ?? '');
} else if (process.argv[2] === '--project-delete-control-fixture') {
    await projectDeleteControlFixture(process.argv[3] ?? '');
} else if (process.argv[2] === '--crash-controller') {
    await crashController(process.argv[3] ?? '');
} else if (process.argv[2] === '--task-crash-controller') {
    await taskCrashController(process.argv[3] ?? '', process.argv[4] ?? '');
}
