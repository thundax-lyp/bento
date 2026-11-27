import type { Authority } from './authority.ts';

type SessionView = ReturnType<Authority['inspect']>;
type StopFacts = Parameters<Authority['observeStop']>[1];
type PolicyFacts = Parameters<Authority['publishReady']>[2];

/** Only the control plane can hold this adapter and its management credentials. */
export interface ExecutionControl {
    revokeWrites(session: SessionView): Promise<void>;
    revokeCredentials(session: SessionView): Promise<void>;
    closeChannels(session: SessionView): Promise<void>;
    stopSandbox(session: SessionView): Promise<void>;
    observeStop(session: SessionView): Promise<StopFacts>;
    installPolicy(session: SessionView, nextGeneration: number): Promise<void>;
    observePolicy(
        session: SessionView,
        nextGeneration: number,
    ): Promise<PolicyFacts>;
}

/**
 * Single-controller orchestration. Adapter actions must be idempotent and scoped to the
 * supplied session and generation. Stop evidence must refer to the old execution incarnation.
 */
export class ExecutionController {
    private readonly authority: Authority;
    private readonly control: ExecutionControl;

    constructor(authority: Authority, control: ExecutionControl) {
        this.authority = authority;
        this.control = control;
    }

    async cancel(session: string, expectedGeneration: number) {
        const current = this.authority.inspect(session);
        if (current.generation !== expectedGeneration)
            throw new Error('stale cancel');
        if (current.state === 'RUNNING' || current.state === 'READY') {
            this.authority.beginDrain(session, expectedGeneration);
        }
        return this.reconcile(session, expectedGeneration);
    }

    async reconcile(session: string, expectedGeneration: number) {
        let current = this.authority.inspect(session);
        if (current.generation !== expectedGeneration)
            throw new Error('stale reconciliation');
        if (current.state === 'DRAINING' || current.state === 'UNKNOWN') {
            try {
                await this.control.revokeWrites(current);
                await this.control.revokeCredentials(current);
                await this.control.closeChannels(current);
                await this.control.stopSandbox(current);
                this.authority.observeStop(
                    session,
                    await this.control.observeStop(current),
                );
            } catch (error) {
                this.authority.observeStop(session, {
                    sandbox: current.sandbox,
                    generation: current.generation,
                    stopped: false,
                    channelsClosed: false,
                    credentialsRevoked: false,
                    writesRevoked: false,
                });
                throw error;
            }
            current = this.authority.inspect(session);
        }
        if (current.state === 'STOPPED') {
            const nextGeneration = expectedGeneration + 1;
            await this.control.installPolicy(current, nextGeneration);
            this.authority.publishReady(
                session,
                expectedGeneration,
                await this.control.observePolicy(current, nextGeneration),
            );
        }
        return this.authority.inspect(session);
    }
}
