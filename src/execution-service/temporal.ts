import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Store } from './store.ts';

export type TemporalRunOptions = {
    address: string;
    namespace?: string;
    taskQueue: string;
};

type Message = {
    id: string;
    method?: string;
    value?: unknown;
    error?: string;
};

export async function temporalRuns(
    options: TemporalRunOptions,
    slots: 1 | 2,
    advance: (runId: string) => Promise<void>,
) {
    const child = spawn(
        process.env.BENTO_GO_CONTROL ?? 'bento-orchestrator',
        ['temporal'],
        { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    const pending = new Map<
        string,
        { resolve(value: unknown): void; reject(error: Error): void }
    >();
    const advancing = new Set<Promise<void>>();
    let sequence = 0;
    let ready = false;
    let failure: Error | undefined;
    let closed = false;
    const exited = new Promise<void>((resolve) => {
        child.once('close', () => resolve());
    });
    function fail() {
        if (!failure) {
            failure = new Error(
                'Go Temporal controller stopped. Restart the execution service.',
            );
            if (ready && !closed) console.error(failure.message);
        }
        for (const request of pending.values()) request.reject(failure);
        pending.clear();
    }
    child.once('error', fail);
    child.once('close', fail);
    child.stdin.on('error', fail);
    function send(message: Message) {
        if (!child.stdin.destroyed)
            child.stdin.write(JSON.stringify(message) + '\n');
    }
    async function request(method: string, value?: unknown) {
        if (failure) throw failure;
        const id = 'host-' + ++sequence;
        const result = new Promise<unknown>((resolve, reject) => {
            pending.set(id, { resolve, reject });
        });
        const timer = setTimeout(
            () => {
                // A timed-out publication or callback has an unknown result.
                // Kill this controller and let persistent Run state drive recovery.
                fail();
                child.kill('SIGKILL');
            },
            method === 'start' ? 15_000 : method === 'close' ? 15_000 : 10_000,
        );
        timer.unref();
        try {
            send({ id, method, value });
            return await result;
        } finally {
            clearTimeout(timer);
        }
    }
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
        let message: Message;
        try {
            message = JSON.parse(line) as Message;
            if (typeof message.id !== 'string')
                throw new Error('Invalid control frame');
        } catch {
            fail();
            child.kill('SIGKILL');
            return;
        }
        if (message.method === 'advance') {
            if (!ready || closed || failure) {
                send({
                    id: message.id,
                    error: 'Execution host is stopping or starting',
                });
                return;
            }
            if (typeof message.value !== 'string') {
                send({ id: message.id, error: 'Invalid Run' });
                return;
            }
            const task = advance(message.value)
                .then(
                    () => send({ id: message.id, value: null }),
                    () =>
                        send({
                            id: message.id,
                            error: 'Run advancement failed',
                        }),
                )
                .finally(() => advancing.delete(task));
            advancing.add(task);
            return;
        }
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error));
        else waiter.resolve(message.value);
    });
    try {
        await request('start', { ...options, slots });
        ready = true;
    } catch (error) {
        child.kill('SIGKILL');
        await exited;
        throw error;
    }
    return {
        async choose(snapshot: ReturnType<Store['dispatchSnapshot']>) {
            const result = await request('choose', snapshot);
            if (typeof result !== 'string')
                throw new Error('Invalid dispatch selection');
            return result;
        },
        async enqueue(runId: string) {
            await request('enqueue', runId);
        },
        async purgeClosed(runId: string) {
            return (await request('purge', runId)) === true;
        },
        async close() {
            if (closed) return;
            closed = true;
            try {
                if (!failure) await request('close').catch(() => undefined);
            } finally {
                child.stdin.end();
                child.kill('SIGKILL');
                await exited;
                lines.close();
                // Keep the host controller lock until every callback is done,
                // including callbacks whose Temporal child has already exited.
                await Promise.allSettled(advancing);
            }
        },
    };
}
