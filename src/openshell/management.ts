import type { Authority } from './authority.ts';

type StopObservation = Parameters<Authority['observeManagedStop']>[2];
type StartObservation = Parameters<Authority['publishManagedReady']>[3];

/**
 * Bind this service to the identity supplied by the trusted controller transport.
 * The worker transport must never provide or call a management service.
 */
export class SandboxManagement {
    private readonly authority: Authority;
    private readonly controller: string;

    constructor(authority: Authority, controller: string) {
        if (!controller) throw new Error('controller identity required');
        this.authority = authority;
        this.controller = controller;
    }

    prepareStop(session: string, generation: number, operation: string) {
        if (!operation) throw new Error('operation ID required');
        return this.authority.reserveStop(
            session,
            generation,
            operation,
            this.controller,
        );
    }

    claimRecovery(session: string, generation: number) {
        return this.authority.claimRecovery(
            session,
            generation,
            this.controller,
        );
    }

    /** The control plane separately verifies that the previous claimant exited. */
    replaceStoppedClaim(
        session: string,
        generation: number,
        expectedOwner: string,
    ) {
        this.authority.replaceStoppedRecoveryOwner(
            session,
            generation,
            expectedOwner,
            this.controller,
        );
    }

    confirmStop(session: string, observation: StopObservation) {
        this.authority.observeManagedStop(
            session,
            this.controller,
            observation,
        );
    }

    prepareStart(session: string, generation: number, operation: string) {
        if (!operation) throw new Error('operation ID required');
        return this.authority.reserveStart(
            session,
            generation,
            operation,
            this.controller,
        );
    }

    confirmStart(
        session: string,
        generation: number,
        observation: StartObservation,
    ) {
        this.authority.publishManagedReady(
            session,
            generation,
            this.controller,
            observation,
        );
    }
}
