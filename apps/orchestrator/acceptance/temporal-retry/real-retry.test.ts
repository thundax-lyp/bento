import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { acquireTemporal, type TemporalTool } from './tool.ts';
import { own, stopOwned, freePort, startServer, root } from './process.ts';

let suite: string;
let tool: TemporalTool;
before(
    async () => {
        suite = await mkdtemp('/tmp/bento-a6-tools-');
        tool = await acquireTemporal(suite, AbortSignal.timeout(540000));
    },
    { timeout: 540000 },
);
after(async () => {
    if (suite) await rm(suite, { recursive: true, force: true });
});

test(
    'A6 tool: verified CLI and persistent server lifecycle',
    { timeout: 180000 },
    async (t) => {
        const directory = await mkdtemp('/tmp/bento-a6-');
        const port = await freePort(),
            namespace = 'bento-a6-' + randomUUID();
        let server: Awaited<ReturnType<typeof startServer>> | undefined;
        let removable = true;
        try {
            server = await startServer(
                tool,
                directory,
                { port, namespace, createNamespace: true },
                t.signal,
            );
            assert((await stat(join(directory, 'temporal.sqlite'))).size > 0);
            await server.close();
            server = undefined;
            server = await startServer(
                tool,
                directory,
                { port, namespace, createNamespace: false },
                t.signal,
            );
            await server.close();
            server = undefined;
        } catch (error) {
            removable = !(error instanceof AggregateError);
            throw error;
        } finally {
            if (server) await server.close();
            if (removable)
                await rm(directory, { recursive: true, force: true });
        }
        await assert.rejects(stat(directory), { code: 'ENOENT' });
    },
);

test(
    'A6 cleanup: managed process timeout and spawn failure',
    { timeout: 15000 },
    async () => {
        const directory = await mkdtemp('/tmp/bento-a6-');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const child = own(
            process.execPath,
            [
                '-e',
                "process.on('SIGINT',()=>{});console.log('ready');setInterval(()=>{},1000)",
            ],
            {
                cwd: root,
                env: process.env,
                log: join(directory, 'ignore.log'),
                ipc: false,
            },
        );
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(new Error('Inline child readiness timeout')),
                    3000,
                );
                child.child.stdout!.once('data', () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
            const result = await stopOwned(child, 100);
            assert.equal(result.forced, true);
            assert.equal(result.signal, 'SIGKILL');
            const missing = own(join(directory, 'nonexistent'), [], {
                cwd: root,
                env: process.env,
                log: join(directory, 'missing.log'),
                ipc: false,
            });
            const exit = await missing.closed;
            assert.notEqual(exit.code, 0);
        } finally {
            await stopOwned(child, 100);
            await rm(directory, { recursive: true, force: true });
        }
        await assert.rejects(stat(directory), { code: 'ENOENT' });
    },
);
