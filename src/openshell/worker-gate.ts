import type { Authority } from './authority.ts';

import type { Grant as WorkerGrant } from '../../apps/worker/protocol.ts';
export type { Grant as WorkerGrant } from '../../apps/worker/protocol.ts';

type Binding = ReturnType<Authority['authorize']>;

/** Shared authorization for SSH relay and persistence ingress. */
export class WorkerGate {
    private readonly channels = new Map<AbortController, WorkerGrant>();
    private readonly timer: NodeJS.Timeout;

    constructor(privateAuthority: Authority, pollMs = 100) {
        this.authority = privateAuthority;
        this.timer = setInterval(() => {
            for (const [controller, grant] of this.channels) {
                try {
                    this.require(grant);
                } catch (error) {
                    controller.abort(error);
                }
            }
        }, pollMs);
        this.timer.unref();
    }

    private readonly authority: Authority;

    require(grant: WorkerGrant): Binding {
        const binding = this.authority.authorize(grant.token);
        if (
            binding.session !== grant.session ||
            binding.run !== grant.run ||
            binding.generation !== grant.generation
        )
            throw new Error('worker grant does not match execution');
        return binding;
    }

    /** The callback must settle only once its transport is actually closed. */
    async channel<T>(
        grant: WorkerGrant,
        connect: (binding: Binding, signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
        const binding = this.require(grant);
        const controller = new AbortController();
        this.channels.set(controller, { ...grant });
        try {
            return await connect(binding, controller.signal);
        } finally {
            this.channels.delete(controller);
        }
    }

    revokeChannels(session: string, generation: number) {
        for (const [controller, grant] of this.channels) {
            if (grant.session === session && grant.generation === generation)
                controller.abort(new Error('execution revoked'));
        }
    }

    channelsClosed(session: string, generation: number) {
        return ![...this.channels.values()].some(
            (grant) =>
                grant.session === session && grant.generation === generation,
        );
    }

    close() {
        clearInterval(this.timer);
        for (const controller of this.channels.keys()) controller.abort();
    }
}
