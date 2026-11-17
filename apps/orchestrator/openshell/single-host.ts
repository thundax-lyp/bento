import { maxTaskEventBatchBytes } from '@/apps/worker/protocol.ts';
import { createServer } from 'node:http';
import { Authority } from './authority.ts';
import { SandboxManagement } from './management.ts';
import { PersistenceFence } from './persistence-fence.ts';
import { createPersistenceIngress } from './persistence-ingress.ts';
import { SessionHistory, type VerifiedStopProof } from './session-history.ts';
import { createSdkIngress } from './sdk-ingress.ts';
import type { SdkIngressOptions } from './sdk-ingress.ts';
import { WorkerGate, type WorkerGrant } from './worker-gate.ts';

type Binding = Parameters<Authority['bind']>[0];
type Session = ReturnType<Authority['inspect']>;
type Running = Parameters<SandboxManagement['confirmStart']>[2];
type GrantFilter = (grant: WorkerGrant) => boolean;

/** Adapter owned by the trusted OpenShell/Docker host. Observations must be independent of command acknowledgements. */
export interface SingleHostSandbox {
    stop(session: Readonly<Session>): Promise<void>;
    stopped(session: Readonly<Session>): Promise<boolean>;
    start(session: Readonly<Session>): Promise<void>;
    running(session: Readonly<Session>): Promise<Omit<Running, 'generation'>>;
}

/** One trusted controller owns these databases and the sandbox lifecycle. */
export class SingleHostExecution {
    private readonly sandbox: SingleHostSandbox;
    private readonly authority: Authority;
    private readonly gate: WorkerGate;
    private readonly history: SessionHistory;
    private readonly fence: PersistenceFence;
    private readonly management: SandboxManagement;
    private readonly recovering = new Set<string>();

    constructor(
        paths: { authority: string; history: string },
        sandbox: SingleHostSandbox,
    ) {
        this.sandbox = sandbox;
        this.authority = new Authority(paths.authority);
        this.history = new SessionHistory(paths.history);
        this.fence = new PersistenceFence(paths.history);
        this.gate = new WorkerGate(this.authority);
        this.management = new SandboxManagement(this.authority, 'single-host');
    }

    bind(binding: Binding, observation: Omit<Running, 'generation'>) {
        if (!observation.running || observation.volume !== binding.volume)
            throw new Error('workspace binding unconfirmed');
        this.authority.bind(binding, { ...observation, generation: 1 });
    }

    inspect(session: string) {
        return this.authority.inspect(session);
    }

    async purge(binding: Binding, remove: (binding: Binding) => Promise<void>) {
        const generation = this.authority.checkPurge(binding);
        if (generation !== undefined)
            this.gate.revokeChannels(binding.session, generation);
        await remove(binding);
        this.history.purge(binding.session);
        this.authority.purge(binding.session);
    }

    hasUnknownOperations(session: string, generation: number): boolean {
        return this.authority.hasUnknownOperations(session, generation);
    }

    operation(session: string, generation: number, id: string) {
        return this.authority.operation(session, generation, id);
    }

    observeTaskFixtureWrite(
        sessionId: string,
        oldGeneration: number,
        operationId: string,
        expectedFingerprint: string,
    ) {
        this.requireReadyHistory(sessionId, oldGeneration + 1);
        const operation = this.authority.operation(
            sessionId,
            oldGeneration,
            operationId,
        );
        if (!operation || operation.digest !== expectedFingerprint)
            throw new Error('Fixture operation fingerprint mismatch');
        if (operation.state === 'SUCCEEDED') return;
        if (operation.state !== 'UNKNOWN')
            throw new Error('Fixture operation outcome conflict');
        this.authority.observeOperation(
            sessionId,
            oldGeneration,
            operationId,
            'SUCCEEDED',
        );
    }

    historyQuiescence(sessionId: string) {
        return this.history.quiescence(sessionId);
    }

    private requireReadyHistory(sessionId: string, generation: number) {
        const current = this.inspect(sessionId);
        if (
            current.state !== 'READY' ||
            current.run !== null ||
            current.hasCapability ||
            current.generation !== generation
        )
            throw new Error('Session authority is not ready and unassigned');
    }

    checkpointHistory(sessionId: string, runId: string, generation: number) {
        this.requireReadyHistory(sessionId, generation);
        return this.history.checkpoint(sessionId, runId, generation);
    }

    validateRestoreCheckpoint(
        sessionId: string,
        sourceRunId: string,
        oldGeneration: number,
        checkpointSha256: string,
    ): void {
        this.requireReadyHistory(sessionId, oldGeneration + 1);
        this.history.validateRestoreCheckpoint(
            sessionId,
            sourceRunId,
            oldGeneration,
            checkpointSha256,
        );
    }

    restoreHistory(proof: VerifiedStopProof) {
        this.requireReadyHistory(proof.sessionId, proof.newGeneration);
        return this.history.restore(proof);
    }

    restoredHistoryDigest(proof: VerifiedStopProof) {
        this.requireReadyHistory(proof.sessionId, proof.newGeneration);
        return this.history.restoredDigest(proof);
    }

    admit(session: string, generation: number, run: string, leaseMs: number) {
        const current = this.inspect(session);
        if (current.state !== 'READY' || current.generation !== generation)
            throw new Error('Run admission denied');
        if (!run || run === 'bento:revoked') throw new Error('invalid Run');
        if (
            !Number.isSafeInteger(leaseMs) ||
            leaseMs <= 0 ||
            !Number.isSafeInteger(Date.now() + leaseMs)
        )
            throw new Error('invalid lease');
        // The same Run can retry this reservation if the process dies before admission.
        if (generation > 1) this.fence.grant(session, generation, run);
        const token = this.authority.admit(session, generation, run, leaseMs);
        return { token, session, generation, run };
    }

    async takeover(session: string, generation: number) {
        if (this.recovering.has(session))
            throw new Error('takeover in progress');
        this.recovering.add(session);
        try {
            return await this.reconcile(session, generation);
        } finally {
            this.recovering.delete(session);
        }
    }

    private async reconcile(session: string, generation: number) {
        let current = this.inspect(session);
        if (current.generation === generation + 1 && current.state === 'READY')
            return current;
        if (current.generation !== generation || !current.run)
            throw new Error('stale takeover');
        const run = current.run;
        if (current.state === 'RUNNING') {
            this.authority.beginDrain(session, generation);
            current = this.inspect(session);
        }
        if (current.state === 'DRAINING') {
            this.fence.revoke(session, generation, run);
            this.gate.revokeChannels(session, generation);
            this.history.releaseReaders(session, generation);
            const dispatch = this.management.prepareStop(
                session,
                generation,
                'stop',
            );
            this.authority.observeStop(session, {
                sandbox: current.sandbox,
                generation,
                stopped: false,
                channelsClosed: false,
                credentialsRevoked: true,
                writesRevoked: true,
            });
            current = this.inspect(session);
            if (dispatch) await this.sandbox.stop(current);
        }
        if (current.state === 'UNKNOWN') {
            if (!this.management.claimRecovery(session, generation))
                this.authority.requireRecoveryOwner(
                    session,
                    generation,
                    'single-host',
                );
            this.management.confirmStop(session, {
                sandbox: current.sandbox,
                generation,
                stopped: await this.sandbox.stopped(current),
                channelsClosed: this.gate.channelsClosed(session, generation),
                credentialsRevoked: !current.hasCapability,
                writesRevoked: this.fence.isRevoked(session, generation),
            });
            current = this.inspect(session);
            if (current.state !== 'STOPPED')
                throw new Error('old execution unconfirmed');
        }
        if (current.state === 'STOPPED') {
            if (!this.management.prepareStart(session, generation, 'start'))
                throw new Error('start reservation denied');
            current = this.inspect(session);
            await this.sandbox.start(current);
        }
        if (current.state !== 'START_UNKNOWN')
            throw new Error('unexpected takeover state');
        this.management.confirmStart(session, generation, {
            ...(await this.sandbox.running(current)),
            generation: generation + 1,
        });
        return this.inspect(session);
    }

    private grant(authorization: string | undefined, allow?: GrantFilter) {
        if (!authorization?.startsWith('Bearer '))
            throw new Error('worker credential required');
        const token = authorization.slice(7);
        const grant = { ...this.authority.authorize(token), token };
        if (allow && !allow(grant)) throw new Error('execution denied');
        return grant;
    }

    persistenceIngress(allow?: GrantFilter) {
        return createPersistenceIngress(
            this.gate,
            (authorization) => ({
                ...this.grant(authorization, allow),
                backendToken: '',
            }),
            async (body, _backendToken, grant) => {
                if (allow && !allow(grant)) throw new Error('execution denied');
                return this.history.dispatch(body, grant);
            },
        );
    }

    sdkIngress(options: SdkIngressOptions, allow?: GrantFilter) {
        return createSdkIngress(
            this.gate,
            (authorization) => this.grant(authorization, allow),
            options,
        );
    }

    operationIngress(
        allow?: GrantFilter,
        acceptTaskEvents?: (grant: WorkerGrant, body: unknown) => void,
    ) {
        const server = createServer(async (request, response) => {
            try {
                const projection =
                    request.url === '/task-events' &&
                    acceptTaskEvents !== undefined;
                if (
                    request.method !== 'POST' ||
                    (!projection && request.url !== '/operations')
                )
                    throw new Error('unexpected operation request');
                const grant = this.grant(request.headers.authorization, allow);
                const limit = projection ? maxTaskEventBatchBytes : 16384;
                const parts: Buffer[] = [];
                let bytes = 0;
                for await (const chunk of request) {
                    const part = Buffer.from(chunk);
                    bytes += part.length;
                    if (bytes > limit) throw new Error('oversize');
                    parts.push(part);
                }
                const body = new TextDecoder('utf-8', { fatal: true }).decode(
                    Buffer.concat(parts),
                );
                if (projection) {
                    const current = this.grant(
                        request.headers.authorization,
                        allow,
                    );
                    acceptTaskEvents(current, JSON.parse(body));
                    response.writeHead(200).end();
                    return;
                }
                const { id, input } = JSON.parse(body) as {
                    id: unknown;
                    input: unknown;
                };
                if (
                    typeof id !== 'string' ||
                    id.length === 0 ||
                    id.length > 256 ||
                    typeof input !== 'string'
                )
                    throw new Error('invalid operation');
                if (allow && !allow(grant)) throw new Error('execution denied');
                const reserved = this.authority.reserveOperation(
                    grant.token,
                    id,
                    input,
                );
                if (!reserved) this.gate.require(grant);
                response.writeHead(reserved ? 201 : 409).end();
            } catch {
                response.writeHead(403).end();
            }
        });
        server.requestTimeout = 10_000;
        server.headersTimeout = 10_000;
        return server;
    }

    /** Close the ingress listeners before disposing the controller. */
    close() {
        this.gate.close();
        this.fence.close();
        this.history.close();
        this.authority.close();
    }
}
