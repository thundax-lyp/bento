import { spawn } from 'node:child_process';
import { finished } from 'node:stream/promises';
import type { Duplex } from 'node:stream';
import type { WorkerGate, WorkerGrant } from './worker-gate.ts';

type Binding = ReturnType<WorkerGate['require']>;

/**
 * Bridge an authenticated ProxyCommand stream to the OpenShell direct-tcpip
 * route. The trusted launcher selects the complete argument list from the
 * stored binding. Inner OpenSSH and the DSH helper keep their wire protocol.
 */
export async function relaySsh(
    gate: WorkerGate,
    grant: WorkerGrant,
    client: Duplex,
    trustedArgs: (binding: Binding) => readonly string[],
    onRevoked: () => void = () => {},
): Promise<void> {
    try {
        await gate.channel(grant, async (binding, signal) => {
            const ssh = spawn('/usr/bin/ssh', trustedArgs(binding), {
                stdio: ['pipe', 'pipe', 'ignore'],
                signal,
            });
            const exited = new Promise<void>((resolve, reject) => {
                let failure: Error | undefined;
                ssh.on('error', (error) => {
                    failure = error;
                });
                ssh.once('close', (code) => {
                    if (failure) reject(failure);
                    else if (code !== 0 && !client.destroyed)
                        reject(new Error('SSH relay exited unsuccessfully'));
                    else resolve();
                });
            });
            const disconnect = () => {
                ssh.stdin.destroy();
                ssh.kill('SIGKILL');
            };
            const revoke = () => {
                onRevoked();
                disconnect();
            };
            client.once('close', disconnect);
            signal.addEventListener('abort', revoke, { once: true });
            ssh.stdin.on('error', () => client.destroy());
            ssh.stdout.on('error', () => client.destroy());
            client.pipe(ssh.stdin);
            ssh.stdout.pipe(client);
            try {
                await exited;
            } finally {
                client.removeListener('close', disconnect);
                signal.removeEventListener('abort', revoke);
                client.destroy();
                await finished(client, { cleanup: true }).catch(() => {});
            }
        });
    } finally {
        client.destroy();
    }
}
