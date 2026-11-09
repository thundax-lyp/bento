import { spawn } from 'node:child_process';
import type { ExecutionHost } from './types.ts';
import { workerReceipt, type Launch } from './worker.ts';
import { workerFrames } from './worker-frames.ts';

function startSlot({ command, args = [], cwd, env = {} }: Launch) {
    const child = spawn(command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
    });
    const frames = workerFrames(child.stdout, 128);
    let stopping = false;
    let timer: NodeJS.Timeout | undefined;
    const closed = new Promise<void>((resolve) => {
        child.once('close', () => {
            clearTimeout(timer);
            resolve();
        });
    });
    const stop = () => {
        if (stopping || child.exitCode !== null || child.signalCode !== null)
            return;
        stopping = true;
        child.kill('SIGTERM');
        timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        timer.unref();
    };
    child.on('error', stop);
    child.stdin.on('error', stop);

    const startup = setTimeout(stop, 30_000);
    startup.unref();
    const ready = frames
        .next()
        .then(({ value }) => {
            if (value !== 'ready')
                throw new Error('Worker did not become ready');
        })
        .finally(() => clearTimeout(startup));
    void ready.catch(stop);

    return {
        ready,
        closed,
        stop,
        async run(request: Parameters<ExecutionHost['worker']>[0]) {
            await ready;
            if (
                stopping ||
                child.exitCode !== null ||
                child.signalCode !== null
            )
                throw new Error('Warm worker exited before dispatch');
            child.stdin.write(JSON.stringify(request) + '\n');
            return workerReceipt((await frames.next()).value);
        },
    };
}

/** The launcher must own the complete worker lifetime, including its container. */
export function prewarmedWorker(
    launch: Launch,
): Pick<ExecutionHost, 'worker' | 'warmWorker'> {
    let slot: ReturnType<typeof startSlot> | undefined;
    let busy = false;
    let lifetime: AbortSignal | undefined;
    let replenish: NodeJS.Timeout | undefined;

    function ensureSlot() {
        lifetime?.throwIfAborted();
        if (slot) return slot;
        const current = startSlot(launch);
        slot = current;
        void current.closed.then(() => {
            slot = undefined;
            if (!busy && !lifetime?.aborted) schedule();
        });
        return current;
    }

    function schedule() {
        clearTimeout(replenish);
        replenish = setTimeout(() => {
            if (!lifetime?.aborted && !busy) ensureSlot();
        }, 500);
        replenish.unref();
    }

    return {
        warmWorker(signal) {
            lifetime = signal;
            signal.addEventListener(
                'abort',
                () => {
                    clearTimeout(replenish);
                    slot?.stop();
                },
                { once: true },
            );
            ensureSlot();
            return async () => {
                await slot?.closed;
            };
        },
        async worker(request, signal) {
            signal.throwIfAborted();
            if (busy) throw new Error('Warm worker is occupied');
            const current = ensureSlot();
            busy = true;
            signal.addEventListener('abort', current.stop, { once: true });
            try {
                const result = await current.run(request);
                signal.throwIfAborted();
                if (result === 'review') {
                    current.stop();
                    await current.closed;
                }
                return result;
            } catch (error) {
                current.stop();
                await current.closed;
                throw error;
            } finally {
                busy = false;
                signal.removeEventListener('abort', current.stop);
                if (!slot && !lifetime?.aborted) schedule();
            }
        },
    };
}
