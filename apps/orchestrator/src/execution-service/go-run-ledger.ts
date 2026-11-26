import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

type Binding = {
    Owner: string;
    Workspace: string;
    Session: string;
    Sandbox: string;
    Volume: string;
};

type Task = { ID: string; Name: string; Binding: Binding };

type Attempt = { RunID: string; ID: string; Generation: number };
type Stops = { Host?: string; Sandbox?: string };
type TerminalStatus = 'succeeded' | 'failed' | 'cancelled';
type Run = {
    ID: string;
    Prompt: string;
    Binding: Binding;
    Status:
        | TerminalStatus
        | 'queued'
        | 'starting'
        | 'running'
        | 'stopping'
        | 'unknown';
    Generation: number;
};

type Commands = {
    ready: [Record<string, never>, true];
    submit: [{ runId: string; binding: Binding; prompt: string }, Run];
    submitTaskRun: [
        { task: Task; runId: string; key: string; prompt: string },
        { Task: Task; Run: Run; Sequence: number; Replay: boolean },
    ];
    task: [{ owner: string; taskId: string }, Task];
    admitWorker: [{ attempt: Attempt; binding: Binding }, void];
    run: [{ runId: string }, Run];
    attempt: [
        { runId: string; generation: number },
        Attempt & { Stops: Stops; Completion: string; Resolution: string },
    ];
    publishDispatch: [
        {
            runId: string;
            temporal: { Address: string; Namespace: string; TaskQueue: string };
        },
        string,
    ];
    reserveDispatch: [{ runId: string }, string];
    consumeStart: [
        { runId: string; attemptId: string },
        { attempt: Attempt; issued: boolean },
    ];
    markRunning: [{ attempt: Attempt }, void];
    recordCompletion: [{ attempt: Attempt; reference: string }, void];
    cancelQueued: [{ runId: string }, void];
    revoke: [{ attempt: Attempt }, void];
    recordStop: [{ attempt: Attempt; stops: Stops }, void];
    markUnknown: [{ attempt: Attempt }, void];
    resolve: [
        {
            attempt: Attempt;
            outcome: { Status: 'queued' | TerminalStatus; Reference: string };
        },
        void,
    ];
};

export class LedgerRejection extends Error {
    readonly code: string;

    constructor(code: string) {
        super(code);
        this.code = code;
    }
}

// A lost response has an unknown transaction outcome. Callers reconcile using
// the original Run and attempt identifiers after reopening the controller.
export async function connectGoRunLedger(
    path: string,
    executable = process.env.BENTO_GO_CONTROL ?? 'bento-orchestrator',
) {
    const child = spawn(executable, ['run-ledger', path], {
        stdio: ['pipe', 'pipe', 'inherit'],
    });
    const pending = new Map<
        string,
        { resolve(value: unknown): void; reject(error: Error): void }
    >();
    const channels = new Map<
        AbortController,
        { attempt: Attempt; done: Promise<void> }
    >();
    let sequence = 0;
    let stopped = false;
    const exited = new Promise<void>((resolve) => {
        child.once('close', () => resolve());
    });
    const unavailable = () =>
        new Error('Go Run ledger unavailable. Reconcile before retrying.');
    function fail() {
        if (stopped) return;
        stopped = true;
        const error = unavailable();
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
        for (const channel of channels.keys()) channel.abort(error);
        child.kill();
    }
    child.once('error', fail);
    child.once('close', fail);
    child.stdin.on('error', fail);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
        try {
            const reply = JSON.parse(line) as {
                id: string;
                value?: unknown;
                error?: string;
            };
            const waiter = pending.get(reply.id);
            if (!waiter) throw new Error('Unexpected ledger response');
            pending.delete(reply.id);
            if (reply.error) waiter.reject(new LedgerRejection(reply.error));
            else waiter.resolve(reply.value);
        } catch {
            fail();
        }
    });
    async function call<M extends keyof Commands>(
        method: M,
        request: Commands[M][0],
    ): Promise<Commands[M][1]> {
        if (stopped) throw unavailable();
        const id = String(++sequence);
        const frame = JSON.stringify({ ...request, id, method }) + '\n';
        if (Buffer.byteLength(frame) >= 512 * 1024)
            throw new Error('Run ledger request too large');
        const result = new Promise<unknown>((resolve, reject) => {
            pending.set(id, { resolve, reject });
        });
        const timer = setTimeout(fail, 10_000);
        timer.unref();
        try {
            child.stdin.write(frame);
            return (await result) as Commands[M][1];
        } finally {
            clearTimeout(timer);
        }
    }

    try {
        if ((await call('ready', {})) !== true) throw unavailable();
    } catch (error) {
        fail();
        await exited;
        throw error;
    }
    function matchingChannels(attempt: Attempt) {
        return [...channels.entries()].filter(
            ([, current]) =>
                current.attempt.RunID === attempt.RunID &&
                current.attempt.ID === attempt.ID &&
                current.attempt.Generation === attempt.Generation,
        );
    }

    return {
        call<M extends Exclude<keyof Commands, 'revoke'>>(
            method: M,
            request: Commands[M][0],
        ) {
            return call(method, request);
        },
        async workerChannel<T>(
            attempt: Attempt,
            binding: Binding,
            connect: (signal: AbortSignal) => Promise<T>,
        ): Promise<T> {
            const controller = new AbortController();
            let finish!: () => void;
            const done = new Promise<void>((resolve) => {
                finish = resolve;
            });
            channels.set(controller, { attempt: { ...attempt }, done });
            try {
                await call('admitWorker', { attempt, binding });
                controller.signal.throwIfAborted();
                return await connect(controller.signal);
            } finally {
                channels.delete(controller);
                finish();
            }
        },
        async revoke(attempt: Attempt) {
            const revoked = call('revoke', { attempt });
            // Queue the ledger command before notifying callbacks, so any
            // reentrant admission follows the revocation on the same pipe.
            for (const [controller] of matchingChannels(attempt))
                controller.abort(new LedgerRejection('stale_attempt'));
            await revoked;
        },
        async awaitChannelClosure(attempt: Attempt) {
            await Promise.all(
                matchingChannels(attempt).map(([, channel]) => channel.done),
            );
        },
        async close() {
            child.stdin.end();
            await exited;
        },
    };
}
