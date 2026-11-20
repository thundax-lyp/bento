import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry, type AgentHandle } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import {
    LlmAdapter,
    LlmRuntime,
    createUserMessage,
} from '@deepseek-ai/dsh-llm';
import { SessionStore, type SessionEvent } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import * as checkpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Transport } from '@connectrpc/connect';
import type { DshWorkerBootstrap } from './dsh-worker.ts';
import type { OpenShellProviderConfig } from './provider.ts';
import { createRunSdkTransport } from './sdk-transport.ts';

export type BaseBootstrapConfig = {
    schema: 1;
    sdkModule: string;
    modelAdapterModule: string;
    provider: string;
    model: string;
    workspaceRoot: string;
    helper: string;
    fileSystemHelper: string;
    node: string;
};
export type ModelAdapterFactory = (options: {
    provider: string;
    model: string;
}) => Promise<{ adapter: LlmAdapter; dispose(): Promise<void> | void }>;

type Runtime = Awaited<ReturnType<DshWorkerBootstrap>>;
type WorkerAgent = Parameters<Runtime['flush']>[0];
type OfficialAgent = AgentHandle['agent'];
type WorkerEvents = ReturnType<WorkerAgent['session']['snapshotEvents']>;
const adapters = new WeakSet<LlmAdapter>();

async function configuration(): Promise<BaseBootstrapConfig> {
    const path = process.env.BENTO_DSH_RUNTIME_CONFIG;
    if (!path || !isAbsolute(path))
        throw new Error('An absolute Worker runtime configuration is required');
    try {
        const value: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('Invalid configuration');
        const row = value as Record<string, unknown>;
        const fields = [
            'sdkModule',
            'modelAdapterModule',
            'provider',
            'model',
            'workspaceRoot',
            'helper',
            'fileSystemHelper',
            'node',
        ];
        if (
            row.schema !== 1 ||
            Object.keys(row).length !== fields.length + 1 ||
            Object.keys(row).some(
                (key) => key !== 'schema' && !fields.includes(key),
            ) ||
            fields.some(
                (key) =>
                    typeof row[key] !== 'string' ||
                    !row[key] ||
                    /[\0\r\n]/.test(row[key] as string),
            )
        )
            throw new Error('Invalid configuration');
        const config = row as BaseBootstrapConfig;
        for (const key of [
            'workspaceRoot',
            'helper',
            'fileSystemHelper',
            'node',
        ] as const)
            if (!posix.isAbsolute(config[key]))
                throw new Error('Invalid sandbox path');
        for (const key of ['sdkModule', 'modelAdapterModule'] as const) {
            if (!isAbsolute(config[key]))
                throw new Error('Invalid module path');
            config[key] = await realpath(config[key]);
            if (!(await stat(config[key])).isFile())
                throw new Error('Invalid module file');
        }
        return Object.freeze(config);
    } catch {
        throw new Error('Invalid Worker runtime configuration');
    }
}

function consumedFields(events: readonly SessionEvent[]): WorkerEvents {
    for (const event of events) {
        if (
            event.type === 'turn/end' &&
            typeof event.data.reason.kind !== 'string'
        )
            throw new Error('Invalid DSH turn outcome');
        if (
            event.type === 'tool/result' &&
            event.data.error !== undefined &&
            typeof event.data.error.code !== 'string'
        )
            throw new Error('Invalid DSH tool outcome');
    }
    // Other SDK event data is preserved, including string request/header.reason.
    return events as WorkerEvents;
}

const bootstrap: DshWorkerBootstrap = async (request) => {
    if (
        !request ||
        !['execute', 'recover'].includes(request.mode) ||
        !request.binding ||
        !request.grant ||
        request.binding.session !== request.grant.session ||
        !Number.isSafeInteger(request.grant.generation) ||
        request.grant.generation < 1 ||
        typeof request.grant.run !== 'string' ||
        !request.grant.run ||
        (['tenant', 'project', 'session', 'sandbox', 'volume'] as const).some(
            (key) =>
                typeof request.binding[key] !== 'string' ||
                !request.binding[key],
        )
    )
        throw new Error('Invalid Worker execution identity');
    const config = await configuration();
    const ctx = new Context();
    const handles = new Set<AgentHandle>();
    const official = new WeakMap<WorkerAgent, OfficialAgent>();
    let sdk: ReturnType<typeof createRunSdkTransport> | undefined;
    let provider: OpenShellProviderConfig | undefined;
    let modelDispose: (() => Promise<void> | void) | undefined;
    let adapter: LlmAdapter | undefined;
    let unregister: (() => void) | undefined;
    let initialized = false;
    let disposal: Promise<void> | undefined;

    function dispose() {
        disposal ??= Promise.resolve().then(async () => {
            const errors: unknown[] = [];
            async function attempt(action: () => unknown | Promise<unknown>) {
                try {
                    await action();
                } catch (error) {
                    errors.push(error);
                }
            }
            const owned = [...handles];
            handles.clear();
            for (const handle of owned) await attempt(() => handle.dispose());
            await attempt(() => {
                const stop = unregister;
                unregister = undefined;
                stop?.();
            });
            await attempt(() => ctx.fiber.dispose());
            await attempt(() => sdk?.close());
            await attempt(() => modelDispose?.());
            if (errors.length === 1) throw errors[0];
            if (errors.length)
                throw new AggregateError(
                    errors,
                    'Worker runtime cleanup failed',
                );
        });
        return disposal;
    }

    function wrap(handle: AgentHandle) {
        handles.add(handle);
        const real = handle.agent;
        const agent: WorkerAgent = {
            session: {
                snapshotEvents: () =>
                    consumedFields(real.session.snapshotEvents()),
            },
            followup(message: Parameters<OfficialAgent['followup']>[0]) {
                real.followup(message);
            },
            whenIdle: () => real.whenIdle(),
        };
        official.set(agent, real);
        return { agent };
    }

    try {
        if (request.mode === 'execute') {
            if (!request.gateway) throw new Error('Run SDK ingress required');
            sdk = createRunSdkTransport(request.gateway, request.grant.token);
            const module = (await import(
                pathToFileURL(config.sdkModule).href
            )) as {
                SandboxClient: new (
                    transport: Transport,
                ) => OpenShellProviderConfig['interactiveClient'];
            };
            if (typeof module.SandboxClient !== 'function')
                throw new Error('Official SandboxClient constructor required');
            const client = new module.SandboxClient(sdk.transport);
            if (typeof client.execInteractive !== 'function')
                throw new Error('Official interactive SDK required');
            provider = {
                interactiveClient: client,
                sandbox: request.binding.sandbox,
                workspaceRoot: config.workspaceRoot,
                helper: config.helper,
                fileSystemHelper: config.fileSystemHelper,
                node: config.node,
                defaultMode: 'workspace-write',
                requireFullEnforcement: true,
            };
            const { default: factory } = (await import(
                pathToFileURL(config.modelAdapterModule).href
            )) as { default?: unknown };
            if (typeof factory !== 'function')
                throw new Error('Model adapter factory required');
            const resource = await (factory as ModelAdapterFactory)(
                Object.freeze({
                    provider: config.provider,
                    model: config.model,
                }),
            );
            if (resource && typeof resource.dispose === 'function')
                modelDispose = () => resource.dispose();
            if (
                !resource ||
                Object.keys(resource).length !== 2 ||
                !Object.hasOwn(resource, 'adapter') ||
                !Object.hasOwn(resource, 'dispose') ||
                !(resource.adapter instanceof LlmAdapter) ||
                !modelDispose ||
                adapters.has(resource.adapter)
            )
                throw new Error(
                    'A fresh model adapter and disposer are required for each Run',
                );
            adapter = resource.adapter;
            adapters.add(adapter);
        }

        return {
            ctx,
            workspaceRoot: config.workspaceRoot,
            agentOptions: { provider: config.provider, model: config.model },
            ...(provider ? { provider } : {}),
            async initialize() {
                if (initialized || disposal)
                    throw new Error(
                        'Worker runtime is no longer initializable',
                    );
                initialized = true;
                await ctx.plugin(AgentRegistry);
                await ctx.plugin(SessionStore);
                await ctx.plugin(SessionProjectionRegistry);
                await ctx.plugin(LlmRuntime);
                await ctx.plugin(SystemPrompt);
                await ctx.plugin(ToolRuntime);
                await ctx.plugin(AgentLoop);
                await ctx.plugin(checkpointPolicy);
                if (adapter)
                    unregister = ctx.llm.registerAdapter(
                        [config.provider],
                        adapter,
                    );
            },
            agents: {
                async create(options) {
                    return wrap(await ctx.agents.create(options));
                },
                async resume(options) {
                    return wrap(await ctx.agents.resume(options));
                },
            },
            persistence: () => ctx.sessionPersistence,
            async flush(agent) {
                const real = official.get(agent);
                if (
                    !real ||
                    ctx.sessions.get(
                        request.grant.session as Parameters<
                            typeof ctx.sessions.get
                        >[0],
                    ) !== real.session
                )
                    throw new Error('Worker Session identity changed');
                if (!(await ctx.sessions.flush(real.session)))
                    throw new Error('Worker Session flush failed');
            },
            userMessage(prompt) {
                return createUserMessage({
                    source: { kind: 'user' },
                    content: [{ type: 'text', text: prompt }],
                });
            },
            dispose,
        };
    } catch (error) {
        try {
            await dispose();
        } catch (cleanup) {
            throw new AggregateError(
                [error, cleanup],
                'Worker runtime setup and cleanup failed',
                { cause: cleanup },
            );
        }
        throw error;
    }
};

export default bootstrap;
