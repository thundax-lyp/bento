import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
    assertContiguous,
    assertVersion,
    materializeAppendBatch,
    materializeCreateHeader,
    validateStoredEvents,
} from '@deepseek-ai/dsh-session-persistence';
import type { WorkerGrant } from './worker-gate.ts';

type Header = Parameters<typeof materializeCreateHeader>[0];
type Event = Parameters<typeof materializeAppendBatch>[0][number];
type Grant = Pick<WorkerGrant, 'session' | 'run' | 'generation'>;
type Row = {
    header: string;
    inherited: number;
    epoch: number;
    owner: string;
    handle: string | null;
    next: number;
    revision: number;
    materialized: number;
};
type Receipt = {
    epoch: number;
    batch: string;
    digest: string;
    first: number;
    count: number;
};
type Intent = { epoch: number; batch: string; payload: string };

declare const verifiedStopProof: unique symbol;
export type VerifiedStopProof = Readonly<{
    attemptId: string;
    taskId: string;
    sourceRunId: string;
    newRunId: string;
    sessionId: string;
    oldGeneration: number;
    newGeneration: number;
    checkpointSha256: string;
}> & { readonly [verifiedStopProof]: true };

type HistorySnapshot =
    | { kind: 'absent' }
    | {
          kind: 'present';
          header: string;
          inherited: number;
          next: number;
          events: string[];
      };

const hash = (payload: string) =>
    createHash('sha256').update(payload).digest('hex');

function fail(name: string): never {
    throw Object.assign(new Error(name), { name });
}

function batchId(value: unknown) {
    if (
        typeof value !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
    )
        throw new Error('invalid batch ID');
    return value;
}

/** Durable transport for the version-locked DSH SessionPersistence contract. */
export class SessionHistory {
    private readonly db: DatabaseSync;
    private readonly readers = new Map<string, Grant>();

    constructor(path: string) {
        this.db = new DatabaseSync(path);
        this.db.exec(`
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY, header TEXT NOT NULL, inherited INTEGER NOT NULL,
                epoch INTEGER NOT NULL, owner TEXT NOT NULL, handle TEXT,
                next INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
                materialized INTEGER NOT NULL DEFAULT 1, created_by TEXT
            );
            CREATE TABLE IF NOT EXISTS events (
                id TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL,
                PRIMARY KEY(id,seq)
            );
            CREATE TABLE IF NOT EXISTS batch_receipts (
                id TEXT NOT NULL, epoch INTEGER NOT NULL, batch TEXT NOT NULL,
                digest TEXT NOT NULL, first INTEGER NOT NULL, count INTEGER NOT NULL,
                PRIMARY KEY(id,epoch,batch)
            );
            CREATE TABLE IF NOT EXISTS batch_intents (
                id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, batch TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS history_checkpoints (
                runId TEXT PRIMARY KEY, sessionId TEXT NOT NULL,
                authorityGeneration INTEGER NOT NULL, body TEXT NOT NULL, sha256 TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS history_restores (
                attemptId TEXT PRIMARY KEY, sessionId TEXT NOT NULL, sourceRunId TEXT NOT NULL,
                newRunId TEXT NOT NULL, newGeneration INTEGER NOT NULL, sha256 TEXT NOT NULL
            );
        `);
    }

    close() {
        this.readers.clear();
        this.db.close();
    }

    releaseReaders(session: string, generation: number) {
        for (const [key, grant] of this.readers) {
            if (grant.session === session && grant.generation === generation)
                this.readers.delete(key);
        }
    }

    purge(session: string) {
        for (const [key, grant] of this.readers) {
            if (grant.session === session) this.readers.delete(key);
        }
        this.transaction(() => {
            this.db
                .prepare('DELETE FROM history_checkpoints WHERE sessionId=?')
                .run(session);
            this.db
                .prepare('DELETE FROM history_restores WHERE sessionId=?')
                .run(session);
            for (const table of [
                'events',
                'batch_receipts',
                'batch_intents',
                'sessions',
            ])
                this.db
                    .prepare('DELETE FROM ' + table + ' WHERE id = ?')
                    .run(session);
        });
    }

    quiescence(sessionId: string) {
        const row = this.sessionRow(sessionId);
        return {
            handleOpen:
                !!row?.handle ||
                [...this.readers.values()].some(
                    (reader) => reader.session === sessionId,
                ),
            pendingBatches: this.db
                .prepare(
                    'SELECT count(*) AS count FROM batch_intents WHERE id=?',
                )
                .get(sessionId)?.count as number,
        };
    }

    private sessionRow(sessionId: string) {
        return this.db
            .prepare('SELECT * FROM sessions WHERE id=?')
            .get(sessionId) as Row | undefined;
    }

    private requireQuiescent(sessionId: string) {
        const { handleOpen, pendingBatches } = this.quiescence(sessionId);
        if (handleOpen || pendingBatches)
            throw new Error('Session history is not quiescent');
    }

    private snapshot(sessionId: string, row: Row | undefined): HistorySnapshot {
        const records = this.db
            .prepare('SELECT seq,event FROM events WHERE id=? ORDER BY seq')
            .all(sessionId);
        if (!row) {
            if (records.length) throw new Error('Orphaned history events');
            return { kind: 'absent' };
        }
        const header = JSON.parse(row.header) as Header;
        assertVersion(header);
        if (
            header.id !== sessionId ||
            records.length !== row.next ||
            records.some(({ seq }, index) => seq !== index) ||
            !row.materialized ||
            !Number.isSafeInteger(row.inherited) ||
            row.inherited < 0
        )
            throw new Error('Session history is incomplete');
        const events = records.map(({ event }) => event as string);
        const parsed = events.map((event) => JSON.parse(event) as Event);
        assertContiguous(header.id, parsed, 0);
        validateStoredEvents(header, parsed);
        return {
            kind: 'present',
            header: row.header,
            inherited: row.inherited,
            next: row.next,
            events,
        };
    }

    checkpoint(sessionId: string, runId: string, authorityGeneration: number) {
        return this.transaction(() => {
            if (
                !Number.isSafeInteger(authorityGeneration) ||
                authorityGeneration < 1
            )
                throw new Error('Invalid history generation');
            this.requireQuiescent(sessionId);
            const row = this.sessionRow(sessionId);
            const body = JSON.stringify(this.snapshot(sessionId, row));
            const sha256 = hash(body);
            if (
                row &&
                (row.epoch !== authorityGeneration - 1 ||
                    row.owner !== 'bento:revoked')
            )
                throw new Error('Session history generation changed');
            const previous = this.db
                .prepare('SELECT * FROM history_checkpoints WHERE runId=?')
                .get(runId);
            if (previous) {
                if (
                    previous.sessionId !== sessionId ||
                    previous.authorityGeneration !== authorityGeneration ||
                    previous.body !== body ||
                    previous.sha256 !== sha256
                )
                    throw new Error('Conflicting history checkpoint');
            } else {
                this.db
                    .prepare(
                        'INSERT INTO history_checkpoints VALUES (?,?,?,?,?)',
                    )
                    .run(runId, sessionId, authorityGeneration, body, sha256);
            }
            return { sha256 };
        });
    }

    private restoreReceipt(proof: VerifiedStopProof) {
        const receipt = this.db
            .prepare('SELECT * FROM history_restores WHERE attemptId=?')
            .get(proof.attemptId);
        if (
            receipt &&
            (receipt.sessionId !== proof.sessionId ||
                receipt.sourceRunId !== proof.sourceRunId ||
                receipt.newRunId !== proof.newRunId ||
                receipt.newGeneration !== proof.newGeneration ||
                receipt.sha256 !== proof.checkpointSha256)
        )
            throw new Error('Conflicting history restore receipt');
        return receipt;
    }

    restore(proof: VerifiedStopProof) {
        return this.transaction(() => {
            if (
                proof.sourceRunId === proof.newRunId ||
                !Number.isSafeInteger(proof.oldGeneration) ||
                !Number.isSafeInteger(proof.newGeneration) ||
                proof.oldGeneration < 1 ||
                proof.newGeneration !== proof.oldGeneration + 1
            )
                throw new Error('Invalid restore generation');
            const {
                attemptId,
                sessionId,
                sourceRunId,
                newRunId,
                oldGeneration,
                newGeneration,
                checkpointSha256,
            } = proof;
            this.requireQuiescent(sessionId);
            if (this.restoreReceipt(proof))
                return { sha256: this.readRestoredDigest(proof) };
            const checkpoint = this.db
                .prepare('SELECT * FROM history_checkpoints WHERE runId=?')
                .get(sourceRunId);
            if (
                !checkpoint ||
                checkpoint.sessionId !== sessionId ||
                checkpoint.authorityGeneration !== oldGeneration ||
                checkpoint.sha256 !== checkpointSha256 ||
                hash(checkpoint.body as string) !== checkpointSha256
            )
                throw new Error('Invalid history checkpoint');

            const row = this.sessionRow(sessionId);
            if (
                row &&
                (row.owner !== 'bento:revoked' || row.epoch !== oldGeneration)
            )
                throw new Error('Prior history owner is not revoked');
            const before = JSON.parse(
                checkpoint.body as string,
            ) as HistorySnapshot;
            const current = this.snapshot(sessionId, row);
            if (
                before.kind === 'present' &&
                (!row ||
                    current.kind !== 'present' ||
                    current.header !== before.header ||
                    current.inherited !== before.inherited ||
                    before.next !== before.events.length ||
                    before.events.some(
                        (event, index) => current.events[index] !== event,
                    ))
            )
                throw new Error(
                    'Checkpoint does not match current history prefix',
                );
            if (before.kind === 'absent') {
                this.db.prepare('DELETE FROM events WHERE id=?').run(sessionId);
                this.db
                    .prepare('DELETE FROM sessions WHERE id=?')
                    .run(sessionId);
            } else {
                this.db
                    .prepare('DELETE FROM events WHERE id=? AND seq>=?')
                    .run(sessionId, before.next);
                this.db
                    .prepare(
                        // Admission advances the revoked writer fence. A queued retry may never execute.
                        'UPDATE sessions SET header=?, inherited=?, next=?, revision=revision+1 WHERE id=?',
                    )
                    .run(
                        before.header,
                        before.inherited,
                        before.next,
                        sessionId,
                    );
            }
            this.db
                .prepare('INSERT INTO history_restores VALUES (?,?,?,?,?,?)')
                .run(
                    attemptId,
                    sessionId,
                    sourceRunId,
                    newRunId,
                    newGeneration,
                    checkpointSha256,
                );
            return { sha256: this.readRestoredDigest(proof) };
        });
    }

    restoredDigest(proof: VerifiedStopProof) {
        return this.transaction(() => this.readRestoredDigest(proof));
    }

    private readRestoredDigest(proof: VerifiedStopProof) {
        if (!this.restoreReceipt(proof))
            throw new Error('Missing history restore receipt');
        this.requireQuiescent(proof.sessionId);
        const row = this.sessionRow(proof.sessionId);
        if (
            row &&
            (row.epoch !== proof.oldGeneration || row.owner !== 'bento:revoked')
        )
            throw new Error('Restored history owner changed');
        const sha256 = hash(
            JSON.stringify(this.snapshot(proof.sessionId, row)),
        );
        if (sha256 !== proof.checkpointSha256)
            throw new Error('Restored history digest changed');
        return sha256;
    }

    dispatch(body: string, grant: Grant) {
        try {
            const query = JSON.parse(body) as Record<string, unknown>;
            const value = this.transaction(() => this.request(query, grant));
            return { status: 200, body: JSON.stringify({ ok: true, value }) };
        } catch (error) {
            return {
                status: 400,
                body: JSON.stringify({
                    ok: false,
                    error: {
                        name: error instanceof Error ? error.name : 'Error',
                    },
                }),
            };
        }
    }

    private transaction<T>(action: () => T) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const value = action();
            this.db.exec('COMMIT');
            return value;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    private request(query: Record<string, unknown>, grant: Grant): unknown {
        const { session, generation, run } = grant;
        if (query.id !== undefined && query.id !== session)
            return fail('GrantDenied');
        const row = this.db
            .prepare('SELECT * FROM sessions WHERE id=?')
            .get(session) as Row | undefined;

        if (query.method === 'create') {
            if (row) return fail('SessionAlreadyExistsError');
            // The ingress has already checked the active execution grant. A
            // previous worker may have died before creating any history.
            const header = materializeCreateHeader(query.header as Header);
            assertVersion(header);
            if (header.id !== session) return fail('GrantDenied');
            const options = query.options as { inheritedEventCount?: number };
            const inherited = options?.inheritedEventCount ?? 0;
            if (
                !Number.isSafeInteger(inherited) ||
                inherited < 0 ||
                (header.isSeeded
                    ? options?.inheritedEventCount === undefined
                    : inherited !== 0)
            )
                throw new Error('invalid inherited event count');
            const key = randomUUID();
            this.db
                .prepare(
                    `INSERT INTO sessions(id,header,inherited,epoch,owner,handle,materialized)
                     VALUES (?,?,?,?,?,?,0)`,
                )
                .run(
                    session,
                    JSON.stringify(header),
                    inherited,
                    generation,
                    run,
                    key,
                );
            return {
                key,
                id: session,
                header,
                inheritedEventCount: inherited,
                access: 'write',
            };
        }
        if (query.method === 'list' && !row) return [];
        if (!row) {
            if (query.method === 'stat') return undefined;
            return fail('SessionPersistenceNotFoundError');
        }
        if (row.epoch !== generation || row.owner !== run)
            return fail('SessionOwnershipLostError');
        const header = JSON.parse(row.header) as Header;
        const snapshot = {
            header,
            eventCount: row.next,
            revision: String(row.revision),
            formatStatus: 'current',
        };
        if (query.method === 'stat') return snapshot;
        if (query.method === 'list') return [snapshot];
        if (query.method === 'open') {
            if (query.access !== 'write' && query.access !== 'read')
                throw new Error('invalid access');
            const key = randomUUID();
            if (query.access === 'write') {
                if (row.handle) return fail('SessionAlreadyOwnedError');
                this.db
                    .prepare('UPDATE sessions SET handle=? WHERE id=?')
                    .run(key, session);
            } else {
                this.readers.set(key, grant);
            }
            return {
                key,
                id: session,
                header,
                inheritedEventCount: row.inherited,
                access: query.access,
            };
        }

        const key = query.key;
        if (typeof key !== 'string') return fail('SessionHandleClosedError');
        const writer = row.handle === key;
        const reader = this.readers.get(key);
        if (
            !writer &&
            (reader?.session !== session ||
                reader?.run !== run ||
                reader.generation !== generation)
        )
            return fail('SessionHandleClosedError');
        if (query.method === 'read') {
            const offset = query.offset ?? 0;
            const length = query.length ?? Number.MAX_SAFE_INTEGER;
            if (
                typeof offset !== 'number' ||
                !Number.isSafeInteger(offset) ||
                offset < 0 ||
                typeof length !== 'number' ||
                !Number.isSafeInteger(length) ||
                length < 0
            )
                throw new Error('invalid event range');
            const events = this.events(header, row);
            return {
                eventState: 'detached',
                events: events.slice(offset, offset + length),
            };
        }
        if (!writer) {
            if (query.method === 'close') {
                this.readers.delete(key);
                return;
            }
            return fail('SessionReadOnlyError');
        }
        const intent = this.db
            .prepare('SELECT epoch,batch,payload FROM batch_intents WHERE id=?')
            .get(session) as Intent | undefined;

        switch (query.method) {
            case 'stage':
            case 'append': {
                const id = batchId(query.batch);
                const events = materializeAppendBatch(query.events as Event[]);
                if (!events.length) throw new Error('empty event batch');
                const payload = JSON.stringify(events);
                const prior = this.receipt(session, generation, id);
                if (prior && prior.digest !== hash(payload))
                    return fail('BatchConflict');
                if (
                    intent &&
                    (intent.epoch !== generation ||
                        intent.batch !== id ||
                        intent.payload !== payload)
                )
                    return fail('IntentConflict');
                if (prior) return query.method === 'append' ? prior : undefined;
                if (query.method === 'append') {
                    if (!intent) return fail('IntentConflict');
                    return this.commit(
                        header,
                        row,
                        generation,
                        id,
                        events,
                        payload,
                    );
                }
                if (!intent) {
                    assertContiguous(header.id, events, row.next);
                    this.db
                        .prepare('INSERT INTO batch_intents VALUES(?,?,?,?)')
                        .run(session, generation, id, payload);
                }
                return;
            }
            case 'reconcile': {
                const id =
                    query.batch === undefined
                        ? undefined
                        : batchId(query.batch);
                if (id !== undefined && intent?.batch !== id) {
                    const prior = this.receipt(session, generation, id);
                    if (!prior) return fail('IntentConflict');
                    return { outcome: 'already-committed', receipt: prior };
                }
                if (!intent) return null;
                const prior = this.receipt(session, intent.epoch, intent.batch);
                if (prior && prior.digest !== hash(intent.payload))
                    return fail('BatchConflict');
                const receipt =
                    prior ??
                    this.commit(
                        header,
                        row,
                        generation,
                        intent.batch,
                        materializeAppendBatch(
                            JSON.parse(intent.payload) as Event[],
                        ),
                        intent.payload,
                    );
                this.db
                    .prepare('DELETE FROM batch_intents WHERE id=?')
                    .run(session);
                return {
                    outcome: prior ? 'already-committed' : 'committed',
                    receipt,
                };
            }
            case 'flush':
            case 'close':
                if (intent) return fail('IntentConflict');
                if (query.method === 'flush')
                    this.db
                        .prepare(
                            'UPDATE sessions SET materialized=1 WHERE id=?',
                        )
                        .run(session);
                else if (!row.materialized)
                    this.db
                        .prepare('DELETE FROM sessions WHERE id=?')
                        .run(session);
                else
                    this.db
                        .prepare('UPDATE sessions SET handle=NULL WHERE id=?')
                        .run(session);
                return;
            default:
                return fail('GrantDenied');
        }
    }

    private events(header: Header, row: Row) {
        const events = this.db
            .prepare('SELECT event FROM events WHERE id=? ORDER BY seq')
            .all(header.id)
            .map(({ event }) => JSON.parse(event as string) as Event);
        if (events.length !== row.next) throw new Error('event count mismatch');
        assertContiguous(header.id, events, 0);
        return validateStoredEvents(header, events);
    }

    private receipt(session: string, epoch: number, batch: string) {
        return this.db
            .prepare(
                'SELECT epoch,batch,digest,first,count FROM batch_receipts WHERE id=? AND epoch=? AND batch=?',
            )
            .get(session, epoch, batch) as Receipt | undefined;
    }

    private commit(
        header: Header,
        row: Row,
        epoch: number,
        batch: string,
        events: readonly Event[],
        payload: string,
    ): Receipt {
        assertContiguous(header.id, events, row.next);
        const insert = this.db.prepare('INSERT INTO events VALUES (?,?,?)');
        for (const event of events)
            insert.run(header.id, event.seq, JSON.stringify(event));
        const receipt = {
            epoch,
            batch,
            digest: hash(payload),
            first: row.next,
            count: events.length,
        };
        this.db
            .prepare('INSERT INTO batch_receipts VALUES (?,?,?,?,?,?)')
            .run(
                header.id,
                epoch,
                batch,
                receipt.digest,
                receipt.first,
                receipt.count,
            );
        this.db
            .prepare(
                'UPDATE sessions SET next=?,revision=revision+1,materialized=1 WHERE id=?',
            )
            .run(row.next + events.length, header.id);
        return receipt;
    }
}
