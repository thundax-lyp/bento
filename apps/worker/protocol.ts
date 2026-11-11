import { createHash } from 'node:crypto';

export type Binding = {
    tenant: string;
    project: string;
    session: string;
    sandbox: string;
    volume: string;
};

export type Grant = {
    token: string;
    session: string;
    run: string;
    generation: number;
};

export type WorkerRequest = {
    mode: 'execute' | 'recover';
    binding: Binding;
    grant: Grant;
    prompt?: string;
    persistenceUrl: string;
    operationUrl: string;
    gateway?: string;
};

export type WorkerResult = 'completed' | 'review' | 'recovered';

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
