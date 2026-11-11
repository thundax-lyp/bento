import { createServer } from 'node:http';
import { Authority } from './authority.ts';
import { SandboxManagement } from './management.ts';
import { PersistenceFence } from './persistence-fence.ts';
import { createPersistenceIngress } from './persistence-ingress.ts';
import { SessionHistory } from './session-history.ts';
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

    operation(session: string, generation: number, id: string) {
        return this.authority.operation(session, generation, id);
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

    operationIngress(allow?: GrantFilter) {
        const server = createServer(async (request, response) => {
            try {
                if (request.method !== 'POST' || request.url !== '/operations')
                    throw new Error('unexpected operation request');
                const grant = this.grant(request.headers.authorization, allow);
                let body = '';
                for await (const chunk of request) {
                    body += chunk;
                    if (Buffer.byteLength(body) > 16384)
                        throw new Error('oversize');
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
