import { appendFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveExecution } from '@orchestrator/execution-service/service.ts';
import { localHost } from '@orchestrator/execution-service/local.ts';
import { executionBindingDigest } from '@orchestrator/execution-service/types.ts';

export type HostConfig = {
    schema: 1;
    state: string;
    volume: string;
    proxyDirectory: string;
    controlBinary: string;
    address: string;
    namespace: string;
    taskQueue: string;
    mode: 'pass' | 'drop';
};
const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
async function main() {
    const config = JSON.parse(
        await readFile(process.argv[2]!, 'utf8'),
    ) as HostConfig;
    if (
        config.schema !== 1 ||
        ![
            config.state,
            config.volume,
            config.proxyDirectory,
            config.controlBinary,
        ].every(isAbsolute) ||
        !/^127\.0\.0\.1:\d+$/.test(config.address) ||
        !config.namespace.startsWith('bento-a6-') ||
        !['pass', 'drop'].includes(config.mode) ||
        !process.send
    )
        throw new Error('Invalid acceptance host configuration');
    const quote = (value: string) =>
        "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const wrapper = join(config.proxyDirectory, 'control');
    await writeFile(
        wrapper,
        '#!/bin/sh\nexec ' +
            [
                process.execPath,
                join(
                    root,
                    'apps/orchestrator/orchestrator-execution-host/tests/acceptance/temporal-retry/control-proxy.mjs',
                ),
            ]
                .map(quote)
                .join(' ') +
            ' "$@"\n',
        { mode: 0o700 },
    );
    const proxyConfig = join(config.proxyDirectory, 'proxy-config.json');
    await writeFile(
        proxyConfig,
        JSON.stringify({
            schema: 1,
            socketPath: join(config.proxyDirectory, 'c.sock'),
            directory: config.proxyDirectory,
            mode: config.mode,
        }),
        { mode: 0o600 },
    );
    process.env.BENTO_GO_CONTROL = wrapper;
    process.env.BENTO_A6_PROXY_CONFIG = proxyConfig;
    const base = localHost(config.volume);
    const starting = serveExecution({
        state: config.state,
        token: 'fixture-only-bento-a6-service-bearer',
        bindHost: '127.0.0.1',
        port: 0,
        workerPort: { persistence: 0, operation: 0, sdk: 0 },
        retryMs: 20,
        workerTimeoutMs: 15000,
        host: {
            ...base,
            async worker(request, signal, slot, onWorkerExit) {
                appendFileSync(
                    join(config.state, 'worker-calls.ndjson'),
                    JSON.stringify({
                        schema: 1,
                        runId: request.grant.run,
                        sessionId: request.grant.session,
                        generation: request.grant.generation,
                        mode: request.mode,
                        bindingDigest: executionBindingDigest(request.binding),
                    }) + '\n',
                    { mode: 0o600, flush: true },
                );
                return base.worker(request, signal, slot, onWorkerExit);
            },
        },
        temporal: {
            address: config.address,
            namespace: config.namespace,
            taskQueue: config.taskQueue,
        },
    });
    let closing: Promise<void> | undefined;
    const close = () =>
        (closing ??= (async () => {
            try {
                const service = await starting;
                await service.close();
                if (process.connected) process.send!({ type: 'closed' });
            } catch {
                process.exitCode = 1;
                if (process.connected)
                    process.send!({ type: 'error', code: 'host_close_failed' });
            } finally {
                if (process.connected) process.disconnect();
            }
        })());
    process.on('message', (message) => {
        if ((message as { type?: string })?.type === 'close') void close();
    });
    process.once('disconnect', () => {
        void close();
    });
    process.once('SIGINT', () => {
        void close();
    });
    process.once('SIGTERM', () => {
        void close();
    });
    try {
        const service = await starting;
        if (process.connected && !closing)
            process.send!({ type: 'ready', url: service.url });
        else await close();
    } catch {
        process.exitCode = 1;
        if (process.connected)
            process.send!({ type: 'error', code: 'host_start_failed' });
        await close();
    }
}
void main().catch(() => {
    process.exitCode = 1;
    if (process.connected) {
        process.send!({ type: 'error', code: 'host_start_failed' });
        process.disconnect();
    }
});
