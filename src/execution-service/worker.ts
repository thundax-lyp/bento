import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { WorkerRequest, WorkerResult } from './types.ts';

export function operationId(run: string, stableId: string) {
    return run + ':' + createHash('sha256').update(stableId).digest('hex');
}

export async function reserveOperation(
    request: WorkerRequest,
    id: string,
    input: string,
    signal?: AbortSignal,
) {
    if (request.mode !== 'execute')
        throw new Error('Recovery cannot dispatch operations');
    const response = await fetch(new URL('/operations', request.operationUrl), {
        method: 'POST',
        headers: {
            authorization: 'Bearer ' + request.grant.token,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            id: operationId(request.grant.run, id),
            input: createHash('sha256').update(input).digest('hex'),
        }),
        signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
            : AbortSignal.timeout(5000),
    });
    if (response.status === 201) return true;
    if (response.status === 409) return false;
    throw new Error('Operation reservation failed');
}

export type Launch = {
    command: string;
    args?: readonly string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
};

export function invokeProcess(
    { command, args = [], cwd, env = {} }: Launch,
    input: unknown,
    signal: AbortSignal,
    maxOutput: number,
) {
    return new Promise<string>((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env,
            signal,
            killSignal: 'SIGKILL',
            stdio: ['pipe', 'pipe', 'ignore'],
        });
        const output: Buffer[] = [];
        let bytes = 0;
        const failed = () =>
            reject(new Error('Adapter exited without a valid response'));
        child.stdout.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxOutput) child.kill('SIGKILL');
            else output.push(chunk);
        });
        child.stdin.on('error', failed);
        child.once('error', failed);
        child.once('close', (code) => {
            if (code !== 0 || bytes > maxOutput) return failed();
            try {
                resolve(
                    new TextDecoder('utf-8', { fatal: true }).decode(
                        Buffer.concat(output),
                    ),
                );
            } catch {
                failed();
            }
        });
        child.stdin.end(JSON.stringify(input));
    });
}

/** The launch command owns OS isolation, process supervision and network routing. */
export function processWorker(launch: Launch) {
    return async (
        request: WorkerRequest,
        signal: AbortSignal,
    ): Promise<WorkerResult> => {
        const receipt = (
            await invokeProcess(launch, request, signal, 128)
        ).trim();
        if (
            receipt === 'completed' ||
            receipt === 'review' ||
            receipt === 'recovered'
        )
            return receipt;
        throw new Error('Worker exited without a valid receipt');
    };
}
