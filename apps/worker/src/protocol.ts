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
    publicEventsUrl?: string;
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

export type PublicWorkerEvent =
    | { offset: number; kind: 'agent_reply' | 'step' | 'command'; text: string }
    | {
          offset: number;
          kind: 'check';
          name: string;
          status: 'passed' | 'failed' | 'not_run' | 'unavailable';
          output: string | null;
      };

export const maxTaskEventBatchBytes = 256 * 1024;
const maxTaskEventBatchItems = 100;

function validText(value: unknown, maxBytes: number): value is string {
    return (
        typeof value === 'string' &&
        Buffer.byteLength(value) <= maxBytes &&
        Buffer.from(value).toString('utf8') === value
    );
}

export function publicTaskEventBatch(value: unknown): PublicWorkerEvent[] {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        !('items' in value) ||
        !Array.isArray(value.items) ||
        value.items.length > maxTaskEventBatchItems
    )
        throw new Error('Invalid Task event batch');
    let previous = -1;
    return value.items.map((event: unknown) => {
        if (!event || typeof event !== 'object' || Array.isArray(event))
            throw new Error('Invalid Task event');
        const row = event as Record<string, unknown>;
        const { offset, kind } = row;
        if (
            typeof offset !== 'number' ||
            !Number.isSafeInteger(offset) ||
            offset <= previous
        )
            throw new Error('Invalid Task event offset');
        previous = offset;
        if (kind === 'check') {
            const { name, status, output } = row;
            if (
                Object.keys(row).length !== 5 ||
                !validText(name, 120) ||
                (status !== 'passed' &&
                    status !== 'failed' &&
                    status !== 'not_run' &&
                    status !== 'unavailable') ||
                !(output === null || validText(output, 4096))
            )
                throw new Error('Invalid Task check');
            return { offset, kind, name, status, output };
        }
        if (
            (kind !== 'agent_reply' && kind !== 'step' && kind !== 'command') ||
            Object.keys(row).length !== 3 ||
            !validText(row.text, 4096)
        )
            throw new Error('Invalid Task event');
        return { offset, kind, text: row.text };
    });
}

export async function writeTaskProjection(
    request: WorkerRequest,
    events: readonly PublicWorkerEvent[],
) {
    if (!request.publicEventsUrl) return;
    const url = request.publicEventsUrl;
    let previous = -1;
    async function send(items: PublicWorkerEvent[]) {
        const payload = JSON.stringify({ items });
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    redirect: 'error',
                    headers: {
                        authorization: 'Bearer ' + request.grant.token,
                        'content-type': 'application/json',
                    },
                    body: payload,
                    signal: AbortSignal.timeout(5000),
                });
                await response.body?.cancel();
                if (response.status === 200) return;
            } catch {
                // The first response can be lost after the transaction commits.
            }
        }
        throw new Error('Task projection receipt unavailable');
    }
    let batch: PublicWorkerEvent[] = [];
    for (const input of events) {
        const [event] = publicTaskEventBatch({ items: [input] });
        if (!event || event.offset <= previous)
            throw new Error('Task projection out of order');
        previous = event.offset;
        if (
            batch.length === maxTaskEventBatchItems ||
            Buffer.byteLength(JSON.stringify({ items: [...batch, event] })) >
                maxTaskEventBatchBytes
        ) {
            await send(batch);
            batch = [];
        }
        batch.push(event);
    }
    if (batch.length) await send(batch);
    await send([]);
}
