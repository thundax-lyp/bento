import { authorityOperations } from './authority-operations.ts';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import type { Binding } from '@/apps/worker/src/protocol.ts';
type Session = Binding & {
    generation: number;
    retiring: number;
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

export class VolumeWriteConflict extends Error {
    readonly code = 'volume_busy';

    constructor() {
        super('Another Session holds the workspace volume write authority.');
    }
}

const digest = (value: string) =>
    createHash('sha256').update(value).digest('hex');

/** Trusted control-plane store. Only an authenticated controller may supply observations. */
export class Authority {
    private readonly db: DatabaseSync;
    private readonly operations: ReturnType<typeof authorityOperations>;
    private readonly path: string;
    private readonly goControl: string | undefined;

    constructor(path: string, goControl?: string) {
        this.path = path;
        this.goControl = goControl;
        this.db = new DatabaseSync(path);
        this.operations = authorityOperations(
            this.db,
            !!goControl,
            (action, input) => this.command(action, input),
            (token) => this.authorize(token),
            (changes) => this.requireChange(changes),
        );
        this.db.exec(`
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS execution_sessions (
                session TEXT PRIMARY KEY, tenant TEXT NOT NULL, project TEXT NOT NULL,
                sandbox TEXT UNIQUE NOT NULL, volume TEXT NOT NULL,
                generation INTEGER NOT NULL, state TEXT NOT NULL,
                run TEXT, capability TEXT, expires INTEGER,
                retiring INTEGER NOT NULL DEFAULT 0
            );
            CREATE UNIQUE INDEX IF NOT EXISTS volume_writer
                ON execution_sessions(volume) WHERE run IS NOT NULL;
            CREATE INDEX IF NOT EXISTS volume_references ON execution_sessions(volume);
            CREATE TABLE IF NOT EXISTS released_session_references (
                session TEXT PRIMARY KEY, tenant TEXT NOT NULL, project TEXT NOT NULL,
                sandbox TEXT NOT NULL, volume TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS volume_reclaims (
                volume TEXT PRIMARY KEY, tenant TEXT NOT NULL, project TEXT NOT NULL,
                session TEXT NOT NULL, sandbox TEXT NOT NULL, reclaimed INTEGER NOT NULL DEFAULT 0
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
        if (
            !this.db
                .prepare(
                    "SELECT 1 FROM pragma_table_info('execution_sessions') WHERE name='retiring'",
                )
                .get()
        )
            this.db.exec(
                'ALTER TABLE execution_sessions ADD COLUMN retiring INTEGER NOT NULL DEFAULT 0',
            );
    }

    close() {
        this.db.close();
    }

    command(action: string, input: object): string | undefined {
        if (!this.goControl) return undefined;
        try {
            const result: unknown = JSON.parse(
                execFileSync(this.goControl, ['authority', this.path, action], {
                    input: JSON.stringify(input),
                    encoding: 'utf8',
                    timeout: 7000,
                    maxBuffer: 4096,
                    stdio: ['pipe', 'pipe', 'pipe'],
                }),
            );
            if (typeof result !== 'string') throw new Error('invalid result');
            return result;
        } catch {
            throw new Error('Go execution authority denied or unavailable');
        }
    }

    isReclaimed(binding: Binding) {
        return (
            this.releaseReceipt(binding) !== undefined &&
            !!this.db
                .prepare(
                    'SELECT 1 FROM volume_reclaims WHERE volume=? AND reclaimed=1',
                )
                .get(binding.volume)
        );
    }

    checkPurge(binding: Binding) {
        const row = this.db
            .prepare('SELECT * FROM execution_sessions WHERE session = ?')
            .get(binding.session) as Session | undefined;
        if (
            !row &&
            this.db
                .prepare(
                    'SELECT 1 FROM released_session_references WHERE session=? OR volume=?',
                )
                .get(binding.session, binding.volume)
        )
            throw new Error('Workspace requires reference-aware cleanup');
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
        if (row)
            this.db
                .prepare(
                    'UPDATE execution_sessions SET retiring=1 WHERE session=?',
                )
                .run(binding.session);
        return row?.generation;
    }

    purge(session: string) {
        this.managementTransaction(() => this.deleteSession(session));
    }

    private deleteSession(session: string) {
        for (const table of [
            'operations',
            'management_starts',
            'management_stops',
            'execution_sessions',
        ])
            this.db
                .prepare('DELETE FROM ' + table + ' WHERE session = ?')
                .run(session);
    }

    bind(binding: Binding, evidence: PolicyEvidence) {
        if (
            !evidence.installed ||
            evidence.sandbox !== binding.sandbox ||
            evidence.generation !== 1
        )
            throw new Error('initial policy unconfirmed');
        if (this.goControl) this.checkVolumeOwner(binding);
        if (
            this.command('bind', {
                ...binding,
                generation: evidence.generation,
                installed: evidence.installed,
            }) !== undefined
        )
            return;
        this.managementTransaction(() => {
            this.checkVolumeOwner(binding);
            if (
                this.db
                    .prepare('SELECT 1 FROM execution_sessions WHERE volume=?')
                    .get(binding.volume)
            )
                throw new Error('Existing volume requires explicit attachment');
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
        });
    }

    private checkVolumeOwner(binding: Binding) {
        if (
            this.db
                .prepare(
                    'SELECT 1 FROM released_session_references WHERE session=?',
                )
                .get(binding.session) ||
            this.db
                .prepare('SELECT 1 FROM volume_reclaims WHERE volume=?')
                .get(binding.volume) ||
            this.db
                .prepare(
                    'SELECT 1 FROM execution_sessions WHERE volume=? AND (tenant<>? OR project<>?)',
                )
                .get(binding.volume, binding.tenant, binding.project)
        )
            throw new Error('Workspace volume binding denied');
    }

    reserveAttachment(source: Binding, binding: Binding) {
        this.managementTransaction(() => {
            const original = this.row(source.session);
            if (
                original.state !== 'READY' ||
                original.retiring ||
                Object.entries(source).some(
                    ([key, value]) => original[key as keyof Binding] !== value,
                ) ||
                source.tenant !== binding.tenant ||
                source.project !== binding.project ||
                source.volume !== binding.volume ||
                source.session === binding.session
            )
                throw new Error('Workspace source binding denied');
            this.checkVolumeOwner(binding);
            const existing = this.db
                .prepare('SELECT * FROM execution_sessions WHERE session=?')
                .get(binding.session) as Session | undefined;
            if (existing) {
                if (
                    existing.retiring ||
                    !['ATTACHING', 'READY'].includes(existing.state) ||
                    Object.entries(binding).some(
                        ([key, value]) =>
                            existing[key as keyof Binding] !== value,
                    )
                )
                    throw new Error('Session attachment conflict');
                return;
            }
            this.db
                .prepare(
                    "INSERT INTO execution_sessions(session,tenant,project,sandbox,volume,generation,state) VALUES (?,?,?,?,?,1,'ATTACHING')",
                )
                .run(
                    binding.session,
                    binding.tenant,
                    binding.project,
                    binding.sandbox,
                    binding.volume,
                );
        });
        return this.inspect(binding.session);
    }

    reserveRebuild(binding: Binding) {
        this.managementTransaction(() => {
            const current = this.row(binding.session);
            if (
                current.retiring ||
                !['READY', 'ATTACHING'].includes(current.state) ||
                Object.entries(binding).some(
                    ([key, value]) => current[key as keyof Binding] !== value,
                )
            )
                throw new Error('Session is not available for rebuild');
            if (current.state === 'READY')
                this.db
                    .prepare(
                        "UPDATE execution_sessions SET state='ATTACHING' WHERE session=?",
                    )
                    .run(binding.session);
        });
    }

    confirmAttachment(binding: Binding) {
        this.requireChange(
            this.db
                .prepare(
                    "UPDATE execution_sessions SET state='READY' WHERE session=? AND sandbox=? AND volume=? AND state='ATTACHING' AND retiring=0",
                )
                .run(binding.session, binding.sandbox, binding.volume).changes,
        );
    }

    retire(binding: Binding) {
        const row = this.row(binding.session);
        if (
            Object.entries(binding).some(
                ([key, value]) => row[key as keyof Binding] !== value,
            )
        )
            throw new Error('Session binding mismatch');
        this.db
            .prepare(
                'UPDATE execution_sessions SET retiring=1,capability=NULL WHERE session=?',
            )
            .run(binding.session);
    }

    confirmRetired(session: string, generation: number) {
        this.requireChange(
            this.db
                .prepare(
                    "UPDATE execution_sessions SET state='REVOKED',run=NULL,expires=NULL WHERE session=? AND generation=? AND retiring=1",
                )
                .run(session, generation).changes,
        );
    }

    releaseReceipt(binding: Binding) {
        const prior = this.db
            .prepare(
                'SELECT tenant,project,session,sandbox,volume FROM released_session_references WHERE session=?',
            )
            .get(binding.session);
        if (!prior) return undefined;
        if (
            Object.entries(binding).some(([key, value]) => prior[key] !== value)
        )
            throw new Error('Released Session binding mismatch');
        const reclaim = this.db
            .prepare(
                'SELECT reclaimed FROM volume_reclaims WHERE volume=? AND session=?',
            )
            .get(binding.volume, binding.session);
        return reclaim
            ? reclaim.reclaimed === 1
                ? 'reclaimed'
                : 'pending'
            : 'released';
    }

    releaseReference(binding: Binding) {
        let reclaim = false;
        this.managementTransaction(() => {
            const current = this.row(binding.session);
            if (
                current.state !== 'REVOKED' ||
                Object.entries(binding).some(
                    ([key, value]) => current[key as keyof Binding] !== value,
                )
            )
                throw new Error('Session must be revoked before release');
            const remaining = this.db
                .prepare(
                    'SELECT 1 FROM execution_sessions WHERE volume=? AND session<>? LIMIT 1',
                )
                .get(binding.volume, binding.session);
            if (
                remaining &&
                this.db
                    .prepare(
                        "SELECT 1 FROM operations WHERE session=? AND state='UNKNOWN' LIMIT 1",
                    )
                    .get(binding.session)
            )
                throw new Error('Workspace operation outcome is unresolved');
            if (!remaining) {
                this.db
                    .prepare(
                        'INSERT INTO volume_reclaims(volume,tenant,project,session,sandbox) VALUES (?,?,?,?,?)',
                    )
                    .run(
                        binding.volume,
                        binding.tenant,
                        binding.project,
                        binding.session,
                        binding.sandbox,
                    );
                reclaim = true;
            }
            this.db
                .prepare(
                    'INSERT INTO released_session_references VALUES (?,?,?,?,?)',
                )
                .run(
                    binding.session,
                    binding.tenant,
                    binding.project,
                    binding.sandbox,
                    binding.volume,
                );
            this.deleteSession(binding.session);
        });
        return reclaim;
    }

    pendingReclaims() {
        return this.db
            .prepare(
                'SELECT tenant,project,session,sandbox,volume FROM volume_reclaims WHERE reclaimed=0',
            )
            .all() as Binding[];
    }

    confirmReclaimed(binding: Binding) {
        this.requireChange(
            this.db
                .prepare(
                    'UPDATE volume_reclaims SET reclaimed=1 WHERE volume=? AND session=?',
                )
                .run(binding.volume, binding.session).changes,
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
        const { capability, retiring, ...view } = this.row(session);
        return {
            ...view,
            hasCapability: capability !== null && retiring === 0,
        };
    }

    private requireChange(changes: number | bigint) {
        if (Number(changes) !== 1) throw new Error('admission or CAS denied');
    }

    sessionAvailable(session: string) {
        const row = this.row(session);
        return row.state === 'READY' && row.retiring === 0;
    }

    hasVolumeWriter(volume: string) {
        return !!this.db
            .prepare(
                `SELECT 1 FROM execution_sessions AS s
                 WHERE s.volume=? AND (s.run IS NOT NULL OR EXISTS (
                    SELECT 1 FROM operations WHERE session=s.session AND state='UNKNOWN'
                 ))`,
            )
            .get(volume);
    }

    admit(
        session: string,
        generation: number,
        run: string,
        leaseMs: number,
        prepare?: () => void,
    ) {
        const expires = Date.now() + leaseMs;
        if (
            !Number.isSafeInteger(leaseMs) ||
            leaseMs <= 0 ||
            !Number.isSafeInteger(expires)
        )
            throw new Error('invalid lease');
        const tokenFromGo = this.command('admit', {
            session,
            generation,
            run,
            leaseMs,
        });
        if (tokenFromGo === 'volume_busy') throw new VolumeWriteConflict();
        if (tokenFromGo !== undefined) return tokenFromGo;
        const token = randomBytes(32).toString('hex');
        this.managementTransaction(() => {
            if (
                this.db
                    .prepare(
                        `SELECT 1 FROM execution_sessions AS other
                 WHERE other.volume=(SELECT volume FROM execution_sessions WHERE session=?)
                   AND other.session<>? AND (other.run IS NOT NULL OR EXISTS (
                     SELECT 1 FROM operations WHERE session=other.session AND state='UNKNOWN'
                   ))`,
                    )
                    .get(session, session)
            )
                throw new VolumeWriteConflict();
            this.requireChange(
                this.db
                    .prepare(
                        `UPDATE execution_sessions SET state='RUNNING',run=?,capability=?,expires=?
                 WHERE session=? AND generation=? AND state='READY' AND retiring=0`,
                    )
                    .run(run, digest(token), expires, session, generation)
                    .changes,
            );
            prepare?.();
        });
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
        if (this.command('revoke', { session, generation }) !== undefined)
            return;
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
        const go = this.command('reserve-stop', {
            session,
            generation,
            operation,
            controller: dispatcher,
        });
        if (go !== undefined) return go === 'reserved';
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
        const go = this.command('claim-recovery', {
            session,
            generation,
            controller,
        });
        if (go !== undefined) return go === 'reserved';
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
        const go = this.command('reserve-start', {
            session,
            generation: previous,
            operation,
            controller,
        });
        if (go !== undefined) return go === 'reserved';
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
        if (
            this.command('stop-observation', {
                session,
                controller,
                ...evidence,
            }) !== undefined
        )
            return;
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
        if (evidence.generation !== previous + 1)
            throw new Error('next execution unconfirmed');
        if (
            this.command('publish-ready', {
                session,
                controller,
                sandbox: evidence.sandbox,
                volume: evidence.volume,
                generation: previous,
                installed: evidence.installed,
                running: evidence.running,
            }) !== undefined
        )
            return;
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
        if (
            this.command('stop-observation', { session, ...evidence }) !==
            undefined
        )
            return;
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
        if (
            this.command('publish-ready', {
                session,
                generation: previous,
                sandbox: evidence.sandbox,
                installed: evidence.installed,
            }) !== undefined
        )
            return;
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
        return this.operations.reserveOperation(token, id, input);
    }

    observeOperation(
        session: string,
        generation: number,
        id: string,
        outcome: 'SUCCEEDED' | 'FAILED',
    ) {
        this.operations.observeOperation(session, generation, id, outcome);
    }

    hasUnknownOperations(session: string, generation: number) {
        return this.operations.hasUnknownOperations(session, generation);
    }

    operation(session: string, generation: number, id: string) {
        return this.operations.operation(session, generation, id);
    }
}
