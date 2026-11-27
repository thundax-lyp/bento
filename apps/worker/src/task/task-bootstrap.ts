import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DshWorkerBootstrap } from '../runtime/dsh-worker.ts';
import { projectTaskChecks, type TrustedTaskCheck } from './task-projection.ts';

type Runtime = Awaited<ReturnType<DshWorkerBootstrap>>;
type BaseRuntime = Runtime & {
    trustedTaskChecks?(events: readonly unknown[]): readonly TrustedTaskCheck[];
};

const bootstrap: DshWorkerBootstrap = async (request, effect) => {
    const path = process.env.BENTO_DSH_BASE_BOOTSTRAP;
    if (!path || !isAbsolute(path))
        throw new Error('An absolute base DSH bootstrap path is required');
    const resolved = await realpath(path);
    if (resolved === (await realpath(fileURLToPath(import.meta.url))))
        throw new Error('The base DSH bootstrap cannot reference itself');
    const { default: createRuntime } = (await import(
        pathToFileURL(resolved).href
    )) as { default?: unknown };
    if (typeof createRuntime !== 'function')
        throw new Error('Invalid base DSH bootstrap export');

    const runtime = await (
        createRuntime as (
            ...args: Parameters<DshWorkerBootstrap>
        ) => Promise<BaseRuntime>
    )(request, effect);
    if (request.mode !== 'execute' || !request.publicEventsUrl) return runtime;

    try {
        const initialize = runtime.initialize;
        const publicEvents = runtime.publicEvents;
        const trustedTaskChecks = runtime.trustedTaskChecks;
        return {
            get ctx() {
                return runtime.ctx;
            },
            get agentOptions() {
                return runtime.agentOptions;
            },
            get workspaceRoot() {
                return runtime.workspaceRoot;
            },
            get agents() {
                return runtime.agents;
            },
            get provider() {
                return runtime.provider!;
            },
            persistence: (...args) => runtime.persistence(...args),
            flush: (...args) => runtime.flush(...args),
            userMessage: (...args) => runtime.userMessage(...args),
            dispose: (...args) => runtime.dispose(...args),
            ...(initialize
                ? {
                      initialize: (...args: Parameters<typeof initialize>) =>
                          initialize.apply(runtime, args),
                  }
                : {}),
            ...(publicEvents && trustedTaskChecks
                ? {
                      publicEvents: (
                          events: Parameters<typeof publicEvents>[0],
                      ) => {
                          const visible = publicEvents.call(runtime, events);
                          const checks = trustedTaskChecks.call(
                              runtime,
                              events,
                          );
                          return projectTaskChecks(
                              events.length,
                              visible,
                              checks,
                          );
                      },
                  }
                : {}),
        };
    } catch (error) {
        try {
            await runtime.dispose();
        } catch {
            // Preserve the failure that prevented the facade from being built.
        }
        throw error;
    }
};

export default bootstrap;
