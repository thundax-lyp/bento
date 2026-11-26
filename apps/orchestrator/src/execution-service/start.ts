import type { AdminDiagnostics } from './admin-diagnostics.ts';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commandHost } from './command-host.ts';
import { localHost } from './local.ts';
import { serveExecution } from './service.ts';
import type { ExecutionHost } from './types.ts';

type ExecutionService = Awaited<ReturnType<typeof serveExecution>>;

type InstallReview = (
    reviewRun: ExecutionService['reviewRun'],
    closeTaskRun: ExecutionService['closeTaskRun'],
    readTaskClosure: ExecutionService['readTaskClosure'],
    closeTaskRetry: ExecutionService['closeTaskRetry'],
    readTaskRetryClosure: ExecutionService['readTaskRetryClosure'],
    reconcileTaskRetry: ExecutionService['reconcileTaskRetry'],
    listPendingRunReviews: ExecutionService['listPendingRunReviews'],
    sharedSessions?: ExecutionService['sharedSessions'],
) => () => void | Promise<void>;

async function main() {
    const {
        BENTO_STATE_DIR,
        BENTO_EXECUTION_ENVIRONMENT_VERSION,
        BENTO_SERVICE_BEARER,
        BENTO_ADMIN_SERVICE_BEARER,
        BENTO_ADMIN_WORKSPACE_GRANTS,
        BENTO_HOST_MODULE,
        BENTO_HOST_CONFIG,
        BENTO_REVIEW_MODULE,
        BENTO_PORT,
        BENTO_BIND_HOST = '127.0.0.1',
        BENTO_TENANT_QUEUE_LIMIT,
        BENTO_TEMPORAL_ADDRESS,
        BENTO_TEMPORAL_NAMESPACE,
        BENTO_TEMPORAL_TASK_QUEUE,
    } = process.env;
    if (!BENTO_STATE_DIR || !BENTO_SERVICE_BEARER)
        throw new Error('State and service bearer required');
    if (
        !/^sha256:[0-9a-f]{64}$/.test(BENTO_EXECUTION_ENVIRONMENT_VERSION ?? '')
    )
        throw new Error('Execution environment version required');
    const state = resolve(BENTO_STATE_DIR);
    const port = Number(BENTO_PORT ?? 8788);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error('Invalid port');
    if (BENTO_BIND_HOST !== '127.0.0.1' && BENTO_BIND_HOST !== '0.0.0.0')
        throw new Error('Invalid execution API bind host');

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

    if (host.environmentVersion !== BENTO_EXECUTION_ENVIRONMENT_VERSION)
        throw new Error('Execution environment version mismatch');

    if (BENTO_TEMPORAL_ADDRESS !== undefined && !BENTO_TEMPORAL_TASK_QUEUE)
        throw new Error('Temporal Task Queue required');
    if (
        !BENTO_TEMPORAL_ADDRESS &&
        (BENTO_TEMPORAL_NAMESPACE || BENTO_TEMPORAL_TASK_QUEUE)
    )
        throw new Error('Temporal address required');
    const installReview = BENTO_REVIEW_MODULE
        ? (
              (await import(
                  pathToFileURL(resolve(BENTO_REVIEW_MODULE)).href
              )) as {
                  default: InstallReview;
              }
          ).default
        : undefined;
    if (BENTO_REVIEW_MODULE && typeof installReview !== 'function')
        throw new Error('Trusted review module must export an installer');
    if (
        Boolean(BENTO_ADMIN_SERVICE_BEARER) !==
        Boolean(BENTO_ADMIN_WORKSPACE_GRANTS)
    )
        throw new Error(
            'Admin service bearer and Workspace grants must be configured together',
        );
    const service = await serveExecution({
        ...(BENTO_ADMIN_SERVICE_BEARER && BENTO_ADMIN_WORKSPACE_GRANTS
            ? {
                  adminDiagnostics: {
                      token: BENTO_ADMIN_SERVICE_BEARER,
                      grants: JSON.parse(
                          BENTO_ADMIN_WORKSPACE_GRANTS,
                      ) as AdminDiagnostics['grants'],
                  },
              }
            : {}),
        state,
        token: BENTO_SERVICE_BEARER,
        port,
        bindHost: BENTO_BIND_HOST,
        host,
        ...(process.env.BENTO_GO_AUTHORITY
            ? { goControl: process.env.BENTO_GO_AUTHORITY }
            : {}),
        ...(BENTO_TENANT_QUEUE_LIMIT === undefined
            ? {}
            : { tenantQueueLimit: Number(BENTO_TENANT_QUEUE_LIMIT) }),
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
    let stopReview: ReturnType<InstallReview> | undefined;
    try {
        stopReview = installReview?.(
            service.reviewRun,
            service.closeTaskRun,
            service.readTaskClosure,
            service.closeTaskRetry,
            service.readTaskRetryClosure,
            service.reconcileTaskRetry,
            service.listPendingRunReviews,
            ...(service.sharedSessions ? [service.sharedSessions] : []),
        );
        if (installReview && typeof stopReview !== 'function')
            throw new Error(
                'Trusted review module must return a cleanup function',
            );
    } catch (error) {
        await service.close();
        throw error;
    }
    let stopping = false;
    const close = () => {
        if (stopping) return;
        stopping = true;
        void service
            .drain()
            .then(() => stopReview?.())
            .finally(() => service.close())
            .catch(() => {
                process.stderr.write(
                    'Bento execution service shutdown failed.\n',
                );
                process.exitCode = 1;
            });
    };
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
    process.stdout.write(service.url + '\n');
}

main().catch(() => {
    process.stderr.write(
        'Bento execution service failed to start. Check state directory, port, bearer, environment version, host and review modules, and Temporal configuration.\n',
    );
    process.exitCode = 1;
});
