import { installOpenShellProvider } from './provider.ts';
import {
    reconcileSessionPersistence,
    remoteSessionPersistence,
} from './remote-session.ts';
import {
    reserveOperation,
    type WorkerRequest,
    type WorkerResult,
} from './protocol.ts';
import { workerFrames } from './worker-frames.ts';

type Context = Parameters<typeof installOpenShellProvider>[0];
type Provider = Parameters<typeof installOpenShellProvider>[1];
type SessionId = Parameters<typeof reconcileSessionPersistence>[1];
type Persistence = Parameters<typeof reconcileSessionPersistence>[0];
type Event = {
    type: string;
    data?: { reason?: { kind?: string }; error?: { code?: string } };
};

export function completedTurn(events: readonly Event[]) {
    const end = events.findLast((event) => event.type === 'turn/end');
    return (
        end?.data?.reason?.kind === 'completed' &&
        !events.some(
            (event) =>
                event.type === 'tool/result' &&
                event.data?.error?.code === 'TOOL_OUTCOME_UNKNOWN',
        )
    );
}
type Agent = {
    session: { snapshotEvents(): readonly Event[] };
    followup(message: unknown): void;
    whenIdle(): Promise<void>;
};
type AgentHandle = { agent: Agent };
type AgentOptions = { provider: string; model: string };
type Runtime = {
    // The private worker bootstrap installs the pinned DSH SessionStore,
    // projections, agent, AgentLoop, checkpoint policy and LLM services.
    ctx: Context;
    agentOptions: AgentOptions;
    workspaceRoot: string;
    persistence(): Persistence;
    agents: {
        create(options: {
            sessionId: SessionId;
            meta: { cwd: string };
            agentOptions: AgentOptions;
        }): Promise<AgentHandle>;
        resume(options: {
            resumeSessionId: SessionId;
            agentOptions: AgentOptions;
        }): Promise<AgentHandle>;
    };
    flush(agent: Agent): Promise<void>;
    userMessage(prompt: string): unknown;
    initialize?(): Promise<void>;
    provider?: Provider;
    dispose(): Promise<void> | void;
};

type Effect = <T>(
    id: string,
    input: string,
    dispatch: () => Promise<T>,
) => Promise<T>;
export type DshWorkerBootstrap = (
    request: WorkerRequest,
    effect: Effect,
) => Promise<Runtime>;

/** One DSH turn or recovery with a fresh runtime. */
export async function runDshWorker(
    request: WorkerRequest,
    bootstrap: DshWorkerBootstrap,
): Promise<WorkerResult> {
    let review = false;
    const runtime = await bootstrap(request, async (id, input, dispatch) => {
        if (review) throw new Error('Previous operation requires review');
        try {
            if (!(await reserveOperation(request, id, input)))
                throw new Error('Operation already reserved');
            return await dispatch();
        } catch (error) {
            review = true;
            throw error;
        }
    });
    try {
        const { ctx, agentOptions, workspaceRoot } = runtime;
        await ctx.plugin(remoteSessionPersistence, {
            url: request.persistenceUrl,
            token: request.grant.token,
        });
        await runtime.initialize?.();
        const { agents } = runtime;
        const id = request.grant.session as SessionId;
        const persistence = runtime.persistence();
        const prior = await persistence.stat(id);
        if (request.mode === 'execute') {
            if (
                !runtime.provider ||
                !request.gateway ||
                request.prompt === undefined
            )
                throw new Error('OpenShell execution configuration required');
            await installOpenShellProvider(ctx, {
                ...runtime.provider,
                sandbox: request.binding.sandbox,
                workspaceRoot,
            });
        } else if (!prior) {
            return 'recovered';
        }
        if (prior) await reconcileSessionPersistence(persistence, id);
        const { agent } = prior
            ? await agents.resume({ resumeSessionId: id, agentOptions })
            : await agents.create({
                  sessionId: id,
                  meta: { cwd: workspaceRoot },
                  agentOptions,
              });
        if (request.mode === 'recover') {
            await runtime.flush(agent);
            return 'recovered';
        }

        const first = agent.session.snapshotEvents().length;
        agent.followup(runtime.userMessage(request.prompt ?? ''));
        await agent.whenIdle();
        await runtime.flush(agent);
        const events = agent.session.snapshotEvents().slice(first);
        return !review && completedTurn(events) ? 'completed' : 'review';
    } finally {
        await runtime.dispose();
    }
}

function workerRequest(input: string) {
    const value = JSON.parse(input) as WorkerRequest | null;
    if (value?.mode !== 'execute' && value?.mode !== 'recover')
        throw new Error('Unknown worker mode');
    return value;
}

/** Readiness and each receipt are emitted after imports and run cleanup respectively. */
export async function runDshWorkerLoop(bootstrap: DshWorkerBootstrap) {
    process.stdout.write('ready\n');
    for await (const frame of workerFrames(process.stdin, 128 * 1024)) {
        const result = await runDshWorker(workerRequest(frame), bootstrap);
        process.stdout.write(result + '\n');
    }
}

/** Worker launch protocol. Bootstrap configuration is private and stdout carries only the receipt. */
export async function runDshWorkerStdio(bootstrap: DshWorkerBootstrap) {
    try {
        const parts: Buffer[] = [];
        let bytes = 0;
        for await (const part of process.stdin) {
            const chunk = part as Buffer;
            bytes += chunk.length;
            if (bytes > 128 * 1024)
                throw new Error('Worker input exceeds size limit');
            parts.push(chunk);
        }
        const request = workerRequest(Buffer.concat(parts).toString('utf8'));
        const result = await runDshWorker(request, bootstrap);
        process.stdout.write(result + '\n');
    } catch {
        process.exitCode = 1;
    }
}
