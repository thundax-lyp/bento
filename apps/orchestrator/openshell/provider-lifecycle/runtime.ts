import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import {
    AgentRegistry,
    type AgentHandle,
    type AgentOptions,
} from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import {
    LlmRuntime,
    LlmAdapter,
    createUserMessage,
    type GenerateOptions,
    type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import {
    SessionStore,
    type SessionId,
    type SessionEvent,
} from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import * as checkpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy';
import { SessionOwnershipLostError } from '@deepseek-ai/dsh-session-persistence';
import type { DshWorkerBootstrap } from '@/apps/worker/dsh-worker.ts';

type WorkerRuntime = Awaited<ReturnType<DshWorkerBootstrap>>;
type WorkerAgent = Parameters<WorkerRuntime['flush']>[0];
type WorkerEvents = ReturnType<WorkerAgent['session']['snapshotEvents']>;
type OfficialAgent = AgentHandle['agent'];
type SharedRuntime = Awaited<ReturnType<typeof createOfficialRuntime>>;

class LocalTurnAdapter extends LlmAdapter {
    private readonly beforeStream: (options: GenerateOptions) => void;
    constructor(beforeStream: (options: GenerateOptions) => void) {
        super();
        this.beforeStream = beforeStream;
    }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        options.signal?.throwIfAborted();
        this.beforeStream(options);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'a2-local-response' };
        yield {
            type: 'block-end',
            index: 0,
            block: { type: 'text', text: 'a2-local-response' },
        };
        yield { type: 'finish', reason: { kind: 'stop' } };
    }
}

export async function createOfficialRuntime(options: {
    workspaceRoot: string;
    sessionId: SessionId;
    beforeStream: (options: GenerateOptions) => void;
}) {
    const ctx = new Context();
    const handles = new Set<AgentHandle>();
    const agentOptions = {
        provider: 'a2-local',
        model: 'fixture',
    } satisfies AgentOptions;
    let unregisterAdapter: (() => void) | undefined;
    let disposal: Promise<void> | undefined;
    async function disposeOnce(revoked: boolean) {
        const errors: unknown[] = [];
        async function attempt(action: () => unknown | Promise<unknown>) {
            try {
                await action();
            } catch (error) {
                errors.push(error);
            }
        }
        if (revoked) await attempt(() => assert.equal(handles.size, 1));
        for (const handle of [...handles]) {
            handles.delete(handle);
            await attempt(() =>
                revoked
                    ? assert.rejects(
                          handle.dispose(),
                          SessionOwnershipLostError,
                      )
                    : handle.dispose(),
            );
        }
        if (revoked)
            await attempt(async () => {
                const persistence = ctx.sessionPersistence;
                assert(
                    'dispose' in persistence &&
                        typeof persistence.dispose === 'function',
                );
                await assert.rejects(
                    persistence.dispose(),
                    (error: unknown) => {
                        assert(error instanceof AggregateError);
                        assert.equal(
                            error.message,
                            'Session persistence close failed',
                        );
                        assert.equal(error.errors.length, 1);
                        assert(
                            error.errors[0] instanceof
                                SessionOwnershipLostError,
                        );
                        return true;
                    },
                );
            });
        await attempt(() => {
            const unregister = unregisterAdapter;
            unregisterAdapter = undefined;
            unregister?.();
        });
        await attempt(() => ctx.fiber.dispose());
        if (errors.length === 1) throw errors[0];
        if (errors.length)
            throw new AggregateError(errors, 'A2 runtime cleanup failed');
    }
    return {
        ctx,
        agentOptions,
        workspaceRoot: options.workspaceRoot,
        get agents() {
            return ctx.agents;
        },
        async initialize() {
            await ctx.plugin(AgentRegistry);
            const create = ctx.agents.create.bind(ctx.agents);
            ctx.agents.create = async (...args) => {
                const handle = await create(...args);
                handles.add(handle);
                return handle;
            };
            const resume = ctx.agents.resume.bind(ctx.agents);
            ctx.agents.resume = async (...args) => {
                const handle = await resume(...args);
                handles.add(handle);
                return handle;
            };
            await ctx.plugin(SessionStore);
            await ctx.plugin(SessionProjectionRegistry);
            await ctx.plugin(LlmRuntime);
            await ctx.plugin(SystemPrompt);
            await ctx.plugin(ToolRuntime);
            await ctx.plugin(AgentLoop);
            await ctx.plugin(checkpointPolicy);
            unregisterAdapter = ctx.llm.registerAdapter(
                ['a2-local'],
                new LocalTurnAdapter(options.beforeStream),
            );
        },
        persistence() {
            return ctx.sessionPersistence;
        },
        async flush(agent: OfficialAgent | WorkerAgent) {
            const session = ctx.sessions.get(options.sessionId);
            assert(session);
            assert.equal(session, agent.session);
            assert.equal(await ctx.sessions.flush(session), true);
        },
        userMessage(prompt: string) {
            return createUserMessage({
                source: { kind: 'user' },
                content: [{ type: 'text', text: prompt }],
            });
        },
        dispose(options?: { revoked?: boolean }) {
            disposal ??= disposeOnce(options?.revoked ?? false);
            return disposal;
        },
    };
}

// The production consumer only reads these fields on these two event types.
// request/header.reason is a string in the pinned SDK, so full structural
// compatibility with the production Event declaration is not claimed here.
function assertWorkerConsumedFields(events: readonly SessionEvent[]): void {
    for (const event of events) {
        assert.equal(typeof event.type, 'string');
        if (event.type === 'turn/end') {
            assert(
                event.data.reason !== null &&
                    typeof event.data.reason === 'object',
            );
            assert.equal(typeof event.data.reason.kind, 'string');
        }
        if (event.type === 'tool/result' && event.data.error !== undefined) {
            assert(
                event.data.error !== null &&
                    typeof event.data.error === 'object',
            );
            assert.equal(typeof event.data.error.code, 'string');
        }
    }
}

export function createWorkerBootstrapRuntime(
    shared: SharedRuntime,
): WorkerRuntime {
    const agents = new WeakMap<WorkerAgent, OfficialAgent>();
    function wrap(handle: AgentHandle) {
        const real = handle.agent;
        const agent: WorkerAgent = {
            session: {
                snapshotEvents() {
                    const events = real.session.snapshotEvents();
                    assertWorkerConsumedFields(events);
                    return events as WorkerEvents;
                },
            },
            followup(message: Parameters<OfficialAgent['followup']>[0]) {
                real.followup(message);
            },
            whenIdle() {
                return real.whenIdle();
            },
        };
        agents.set(agent, real);
        return { agent };
    }
    return {
        ctx: shared.ctx,
        agentOptions: shared.agentOptions,
        workspaceRoot: shared.workspaceRoot,
        agents: {
            async create(options) {
                return wrap(await shared.agents.create(options));
            },
            async resume(options) {
                return wrap(await shared.agents.resume(options));
            },
        },
        initialize() {
            return shared.initialize();
        },
        persistence() {
            return shared.persistence();
        },
        userMessage(prompt) {
            return shared.userMessage(prompt);
        },
        async flush(agent) {
            const real = agents.get(agent);
            assert(real);
            assert.equal(
                shared.ctx.sessions.get(real.session.id),
                real.session,
            );
            await shared.flush(real);
        },
        dispose() {
            return shared.dispose();
        },
    };
}
