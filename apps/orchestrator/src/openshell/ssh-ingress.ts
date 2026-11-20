import { createServer } from 'node:net';
import { Buffer } from 'node:buffer';
import type { WorkerGate, WorkerGrant } from './worker-gate.ts';
import { relaySsh } from './ssh-relay.ts';

type Binding = ReturnType<WorkerGate['require']>;

export function createSshIngress(
    gate: WorkerGate,
    resolveGrant: (
        request: Pick<WorkerGrant, 'token' | 'run' | 'generation'>,
    ) => WorkerGrant,
    trustedArgs: (binding: Binding) => readonly string[],
    audit: (event: string, generation?: number) => void,
) {
    return createServer((socket) => {
        let header = Buffer.alloc(0);
        socket.on('error', () => socket.destroy());
        socket.setTimeout(5000, () => socket.destroy());
        function handshake(chunk: Buffer) {
            header = Buffer.concat([header, chunk]);
            const end = header.indexOf(10);
            if (end < 0 && header.length <= 4096) return;
            socket.removeListener('data', handshake);
            let grant: WorkerGrant;
            try {
                if (end < 0 || end > 4096 || end !== header.length - 1)
                    throw new Error('invalid relay handshake');
                const request = JSON.parse(header.subarray(0, end).toString());
                grant = resolveGrant(request);
                gate.require(grant);
            } catch {
                audit('DENIED');
                socket.end('DENIED\n');
                return;
            }
            socket.setTimeout(0);
            socket.write('OK\n');
            audit('OPEN', grant.generation);
            void relaySsh(gate, grant, socket, trustedArgs, () => {
                audit('REVOKE_STREAM', grant.generation);
            })
                .catch(() => audit('RELAY_ERROR', grant.generation))
                .finally(() => audit('CLOSED', grant.generation));
        }
        socket.on('data', handshake);
    });
}
