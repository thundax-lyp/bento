import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type { Binding } from '../../worker/protocol.ts';
type Session = Binding & {
    generation: number;
    state: string;
    run: string | null;
    capability: string | null;
    expires: number | null;
};
type StopEvidence = {
    sandbox: string;
    generation: number;
    stopped: boolean;
    channelsClosed: boolean;
    credentialsRevoked: boolean;
    writesRevoked: boolean;
};
type PolicyEvidence = {
    sandbox: string;
    generation: number;
    installed: boolean;
};

const digest = (value: string) =>
    createHash('sha256').update(value).digest('hex');

/** Trusted control-plane store. Only an authenticated controller may supply observations. */
export class Authority {
    private readonly db: DatabaseSync;

    constructor(path: string) {
        this.db = new DatabaseSync(path);
        this.db.exec(`
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS execution_sessions (
                session TEXT PRIMARY KEY, tenant TEXT NOT NULL, project TEXT NOT NULL,
                sandbox TEXT UNIQUE NOT NULL, volume TEXT NOT NULL,
                generation INTEGER NOT NULL, state TEXT NOT NULL,
                run TEXT, capability TEXT, expires INTEGER
            );
            CREATE TABLE IF NOT EXISTS management_stops (
                session TEXT NOT NULL, generation INTEGER NOT NULL, sandbox TEXT NOT NULL,
                operation TEXT NOT NULL, dispatcher TEXT NOT NULL, recovery_owner TEXT,
                PRIMARY KEY(session, generation)
            );
            CREATE TABLE IF NOT EXISTS management_starts (
                session TEXT NOT NULL, generation INTEGER NOT NULL, sandbox TEXT NOT NULL,
                operation TEXT NOT NULL, controller TEXT NOT NULL,
                PRIMARY KEY(session, generation)
            );
            CREATE TABLE IF NOT EXISTS operations (
                session TEXT NOT NULL, generation INTEGER NOT NULL, id TEXT NOT NULL,
                digest TEXT NOT NULL, state TEXT NOT NULL,
                PRIMARY KEY(session, id)
            );
        `);
    }

    close() {
        this.db.close();
    }

    checkPurge(binding: Binding) {
        const row = this.db
            .prepare('SELECT * FROM execution_sessions WHERE session = ?')
            .get(binding.session) as Session | undefined;
        if (
            row &&
            (row.state !== 'READY' ||
                row.capability !== null ||
                row.tenant !== binding.tenant ||
                row.project !== binding.project ||
                row.sandbox !== binding.sandbox ||
                row.volume !== binding.volume)
        )
            throw new Error('Session is not safe to purge');
        if (
            this.db
                .prepare(
                    'SELECT 1 FROM execution_sessions WHERE session <> ? AND (sandbox = ? OR volume = ?)',
                )
                .get(binding.session, binding.sandbox, binding.volume)
        )
            throw new Error('Workspace is shared');
        return row?.generation;
    }

    purge(session: string) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            for (const table of [
                'operations',
                'management_starts',
                'management_stops',
                'execution_sessions',
            ])
                this.db
                    .prepare('DELETE FROM ' + table + ' WHERE session = ?')
                    .run(session);
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    bind(binding: Binding, evidence: PolicyEvidence) {
        if (
            !evidence.installed ||
            evidence.sandbox !== binding.sandbox ||
            evidence.generation !== 1
        )
            throw new Error('initial policy unconfirmed');
        this.db
            .prepare(
                "INSERT INTO execution_sessions(session,tenant,project,sandbox,volume,generation,state) VALUES (?,?,?,?,?,1,'READY')",
            )
            .run(
                binding.session,
                binding.tenant,
                binding.project,
                binding.sandbox,
                binding.volume,
            );
    }

    private row(session: string): Session {
        const row = this.db
            .prepare('SELECT * FROM execution_sessions WHERE session=?')
            .get(session);
        if (!row) throw new Error('unknown session');
        return row as Session;
    }

    inspect(session: string) {
        const { capability, ...view } = this.row(session);
        return { ...view, hasCapability: capability !== null };
    }

    private requireChange(changes: number | bigint) {
        if (Number(changes) !== 1) throw new Error('admission or CAS denied');
    }

    admit(session: string, generation: number, run: string, leaseMs: number) {
        const expires = Date.now() + leaseMs;
        if (
            !Number.isSafeInteger(leaseMs) ||
            leaseMs <= 0 ||
            !Number.isSafeInteger(expires)
        )
            throw new Error('invalid lease');
        const token = randomBytes(32).toString('hex');
        this.requireChange(
            this.db
                .prepare(
                    `
            UPDATE execution_sessions SET state='RUNNING',run=?,capability=?,expires=?
            WHERE session=? AND generation=? AND state='READY'
        `,
                )
                .run(run, digest(token), expires, session, generation).changes,
        );
        return token;
    }

    /** The worker presents only its opaque capability. The target comes from trusted storage. */
    authorize(token: string) {
        const row = this.db
            .prepare(
                `
            SELECT session,tenant,project,sandbox,volume,generation,run FROM execution_sessions
            WHERE capability=? AND state='RUNNING' AND expires>?
        `,
            )
            .get(digest(token), Date.now());
        if (!row) throw new Error('execution denied');
        return row as Binding & { generation: number; run: string };
    }

    beginDrain(session: string, generation: number) {
        this.requireChange(
            this.db
                .prepare(
                    `
            UPDATE execution_sessions SET state='DRAINING',capability=NULL
            WHERE session=? AND generation=? AND state IN ('RUNNING','READY')
        `,
                )
                .run(session, generation).changes,
        );
    }

    /** Reserve the only dispatch for this sandbox generation before invoking the host. */
    reserveStop(
        session: string,
        generation: number,
        operation: string,
        dispatcher: string,
    ) {
        const result = this.db
            .prepare(
                `
            INSERT INTO management_stops(session,generation,sandbox,operation,dispatcher)
            SELECT session,generation,sandbox,?,? FROM execution_sessions
            WHERE session=? AND generation=? AND state='DRAINING'
            ON CONFLICT(session,generation) DO NOTHING
        `,
            )
            .run(operation, dispatcher, session, generation);
        return Number(result.changes) === 1;
    }

    claimRecovery(session: string, generation: number, controller: string) {
        const result = this.db
            .prepare(
                `
            UPDATE management_stops SET recovery_owner=?
            WHERE session=? AND generation=? AND recovery_owner IS NULL
            AND EXISTS (
                SELECT 1 FROM execution_sessions AS s
                WHERE s.session=management_stops.session AND s.generation=management_stops.generation
                AND s.sandbox=management_stops.sandbox AND s.state='UNKNOWN'
            )
        `,
            )
            .run(controller, session, generation);
        return Number(result.changes) === 1;
    }

    reserveStart(
        session: string,
        previous: number,
        operation: string,
        controller: string,
    ) {
        let reserved = false;
        this.managementTransaction(() => {
            const result = this.db
                .prepare(
                    `
                INSERT INTO management_starts(session,generation,sandbox,operation,controller)
                SELECT s.session,s.generation+1,s.sandbox,?,?
                FROM execution_sessions AS s JOIN management_stops AS m
                  ON m.session=s.session AND m.generation=s.generation AND m.sandbox=s.sandbox
                WHERE s.session=? AND s.generation=? AND s.state='STOPPED' AND m.recovery_owner=?
                ON CONFLICT(session,generation) DO NOTHING
            `,
                )
                .run(operation, controller, session, previous, controller);
            reserved = Number(result.changes) === 1;
            if (reserved) {
                this.requireChange(
                    this.db
                        .prepare(
                            `
                    UPDATE execution_sessions SET state='START_UNKNOWN'
                    WHERE session=? AND generation=? AND state='STOPPED'
                `,
                        )
                        .run(session, previous).changes,
                );
            }
        });
        return reserved;
    }

    observeManagedStop(
        session: string,
        controller: string,
        evidence: StopEvidence,
    ) {
        this.managementTransaction(() => {
            const initialDispatcher = this.db
                .prepare(
                    `
            SELECT 1 FROM management_stops AS m JOIN execution_sessions AS s
              ON s.session=m.session AND s.generation=m.generation AND s.sandbox=m.sandbox
            WHERE m.session=? AND m.generation=? AND m.sandbox=? AND m.dispatcher=?
              AND m.recovery_owner IS NULL AND s.state='DRAINING'
        `,
                )
                .get(
                    session,
                    evidence.generation,
                    evidence.sandbox,
                    controller,
                );
            if (!initialDispatcher)
                this.requireRecoveryOwner(
                    session,
                    evidence.generation,
                    controller,
                );
            this.observeStop(session, evidence);
            if (initialDispatcher) {
                this.db
                    .prepare(
                        `
                UPDATE management_stops SET recovery_owner=dispatcher
                WHERE session=? AND generation=? AND EXISTS (
                    SELECT 1 FROM execution_sessions AS s
                    WHERE s.session=management_stops.session AND s.generation=management_stops.generation
                    AND s.state='STOPPED'
                )
            `,
                    )
                    .run(session, evidence.generation);
            }
        });
    }

    publishManagedReady(
        session: string,
        previous: number,
        controller: string,
        evidence: PolicyEvidence & { volume: string; running: boolean },
    ) {
        this.managementTransaction(() => {
            this.requireRecoveryOwner(session, previous, controller);
            const intent = this.db
                .prepare(
                    `
                SELECT 1 FROM management_starts
                WHERE session=? AND generation=? AND sandbox=? AND controller=?
            `,
                )
                .get(session, previous + 1, evidence.sandbox, controller);
            if (!intent) throw new Error('start dispatch unconfirmed');
            if (
                !evidence.installed ||
                !evidence.running ||
                evidence.generation !== previous + 1
            )
                throw new Error('next execution unconfirmed');
            this.requireChange(
                this.db
                    .prepare(
                        `
                UPDATE execution_sessions SET generation=generation+1,state='READY',run=NULL,expires=NULL
                WHERE session=? AND generation=? AND sandbox=? AND volume=? AND state='START_UNKNOWN'
            `,
                    )
                    .run(session, previous, evidence.sandbox, evidence.volume)
                    .changes,
            );
        });
    }

    private managementTransaction(action: () => void) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            action();
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    /** The trusted control plane must establish that the expected claimant has exited. */
    replaceStoppedRecoveryOwner(
        session: string,
        generation: number,
        expectedOwner: string,
        nextOwner: string,
    ) {
        if (expectedOwner === nextOwner)
            throw new Error('replacement owner must differ');
        this.managementTransaction(() => {
            this.requireChange(
                this.db
                    .prepare(
                        `
                UPDATE management_stops SET recovery_owner=?
                WHERE session=? AND generation=? AND recovery_owner=?
                AND EXISTS (
                    SELECT 1 FROM execution_sessions AS s
                    WHERE s.session=management_stops.session
                    AND s.generation=management_stops.generation
                    AND s.sandbox=management_stops.sandbox AND s.state='STOPPED'
                )
            `,
                    )
                    .run(nextOwner, session, generation, expectedOwner).changes,
            );
            this.requireChange(
                this.db
                    .prepare(
                        `
                UPDATE execution_sessions SET state='UNKNOWN'
                WHERE session=? AND generation=? AND state='STOPPED'
            `,
                    )
                    .run(session, generation).changes,
            );
        });
    }

    requireRecoveryOwner(
        session: string,
        generation: number,
        controller: string,
    ) {
        const row = this.db
            .prepare(
                `
            SELECT 1 FROM management_stops
            WHERE session=? AND generation=? AND recovery_owner=?
        `,
            )
            .get(session, generation, controller);
        if (!row) throw new Error('controller recovery denied');
    }

    observeStop(session: string, evidence: StopEvidence) {
        const stopped =
            evidence.stopped &&
            evidence.channelsClosed &&
            evidence.credentialsRevoked &&
            evidence.writesRevoked;
        this.requireChange(
            this.db
                .prepare(
                    `
            UPDATE execution_sessions SET state=?
            WHERE session=? AND generation=? AND sandbox=? AND state IN ('DRAINING','UNKNOWN')
        `,
                )
                .run(
                    stopped ? 'STOPPED' : 'UNKNOWN',
                    session,
                    evidence.generation,
                    evidence.sandbox,
                ).changes,
        );
    }

    publishReady(session: string, previous: number, evidence: PolicyEvidence) {
        if (!evidence.installed || evidence.generation !== previous + 1)
            throw new Error('next policy unconfirmed');
        this.requireChange(
            this.db
                .prepare(
                    `
            UPDATE execution_sessions SET generation=generation+1,state='READY',run=NULL,expires=NULL
            WHERE session=? AND generation=? AND sandbox=? AND state='STOPPED'
        `,
                )
                .run(session, previous, evidence.sandbox).changes,
        );
    }

    /** An UNKNOWN operation remains queryable and cannot be submitted again. */
    reserveOperation(token: string, id: string, input: string) {
        const fingerprint = digest(input);
        const result = this.db
            .prepare(
                `
            INSERT INTO operations(session,generation,id,digest,state)
            SELECT session,generation,?,?,'UNKNOWN' FROM execution_sessions
            WHERE capability=? AND state='RUNNING' AND expires>?
            ON CONFLICT(session,id) DO NOTHING
        `,
            )
            .run(id, fingerprint, digest(token), Date.now());
        return Number(result.changes) === 1;
    }

    observeOperation(
        session: string,
        generation: number,
        id: string,
        outcome: 'SUCCEEDED' | 'FAILED',
    ) {
        this.requireChange(
            this.db
                .prepare(
                    `
            UPDATE operations SET state=? WHERE session=? AND generation=? AND id=? AND state='UNKNOWN'
        `,
                )
                .run(outcome, session, generation, id).changes,
        );
    }

    hasUnknownOperations(session: string, generation: number): boolean {
        return (
            this.db
                .prepare(
                    "SELECT 1 FROM operations WHERE session=? AND generation=? AND state='UNKNOWN' LIMIT 1",
                )
                .get(session, generation) !== undefined
        );
    }

    operation(session: string, generation: number, id: string) {
        return this.db
            .prepare(
                'SELECT state,digest FROM operations WHERE session=? AND generation=? AND id=?',
            )
            .get(session, generation, id);
    }
}
