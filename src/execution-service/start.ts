import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commandHost } from './command-host.ts';
import { localHost } from './local.ts';
import { serveExecution } from './service.ts';
import type { ExecutionHost } from './types.ts';

async function main() {
    const {
        BENTO_STATE_DIR,
        BENTO_SERVICE_BEARER,
        BENTO_HOST_MODULE,
        BENTO_HOST_CONFIG,
        BENTO_PORT,
        BENTO_TEMPORAL_ADDRESS,
        BENTO_TEMPORAL_NAMESPACE,
        BENTO_TEMPORAL_TASK_QUEUE,
    } = process.env;
    if (!BENTO_STATE_DIR || !BENTO_SERVICE_BEARER)
        throw new Error('State and service bearer required');
    const state = resolve(BENTO_STATE_DIR);
    const port = Number(BENTO_PORT ?? 8788);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error('Invalid port');

    let host: ExecutionHost;
    const [mode, extra] = process.argv.slice(2);
    if (
        mode === '--local' &&
        extra === undefined &&
        !BENTO_HOST_MODULE &&
        !BENTO_HOST_CONFIG
    ) {
        host = localHost(resolve(state, 'local-fixture'));
        process.stderr.write(
            'Bento local fixture active. Model and OpenShell are disabled.\n',
        );
    } else if (mode === undefined && BENTO_HOST_CONFIG && !BENTO_HOST_MODULE) {
        host = await commandHost(resolve(BENTO_HOST_CONFIG));
    } else if (mode === undefined && BENTO_HOST_MODULE && !BENTO_HOST_CONFIG) {
        const module = (await import(
            pathToFileURL(resolve(BENTO_HOST_MODULE)).href
        )) as {
            default: (options: {
                state: string;
            }) => Promise<ExecutionHost> | ExecutionHost;
        };
        host = await module.default({ state });
        if (!host.sdk)
            throw new Error(
                'Trusted host must supply the OpenShell SDK ingress configuration',
            );
    } else {
        throw new Error(
            'Select local fixture or private OpenShell host configuration',
        );
    }

    if (BENTO_TEMPORAL_ADDRESS !== undefined && !BENTO_TEMPORAL_TASK_QUEUE)
        throw new Error('Temporal Task Queue required');
    if (
        !BENTO_TEMPORAL_ADDRESS &&
        (BENTO_TEMPORAL_NAMESPACE || BENTO_TEMPORAL_TASK_QUEUE)
    )
        throw new Error('Temporal address required');
    const service = await serveExecution({
        state,
        token: BENTO_SERVICE_BEARER,
        port,
        host,
        ...(BENTO_TEMPORAL_ADDRESS && BENTO_TEMPORAL_TASK_QUEUE
            ? {
                  temporal: {
                      address: BENTO_TEMPORAL_ADDRESS,
                      taskQueue: BENTO_TEMPORAL_TASK_QUEUE,
                      ...(BENTO_TEMPORAL_NAMESPACE
                          ? { namespace: BENTO_TEMPORAL_NAMESPACE }
                          : {}),
                  },
              }
            : {}),
    });
    process.stdout.write(service.url + '\n');
    const close = () => {
        const deadline = setTimeout(() => process.exit(1), 10_000);
        void service.close().then(() => clearTimeout(deadline));
    };
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
}

main().catch(() => {
    process.stderr.write(
        'Bento execution service failed to start. Check state directory, port, bearer, host module and Temporal configuration.\n',
    );
    process.exitCode = 1;
});
