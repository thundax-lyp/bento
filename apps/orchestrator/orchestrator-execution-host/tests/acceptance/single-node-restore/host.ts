import { commandHost } from '@orchestrator/execution-service/command-host.ts';
import { serveExecution } from '@orchestrator/execution-service/service.ts';

/** Reuses the production command adapter and execution service without localHost. */
export async function startAcceptanceHost(options: {
    state: string;
    token: string;
    hostConfig: string;
    environmentVersion: string;
    temporal: { address: string; namespace: string; taskQueue: string };
}) {
    const host = await commandHost(options.hostConfig);
    if (host.environmentVersion !== options.environmentVersion)
        throw new Error('host_environment_mismatch');
    return serveExecution({
        state: options.state,
        token: options.token,
        host,
        port: 0,
        bindHost: '127.0.0.1',
        workerPort: { persistence: 0, operation: 0, sdk: 0 },
        temporal: options.temporal,
    });
}
