import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type { Authority } from './authority.ts';

const digest = (value: string) =>
    createHash('sha256').update(value).digest('hex');

export function authorityOperations(
    db: DatabaseSync,
    goEnabled: boolean,
    command: Authority['command'],
    authorize: Authority['authorize'],
    requireChange: (changes: number | bigint) => void,
) {
    function reserveOperation(token: string, id: string, input: string) {
        const fingerprint = digest(input);
        if (goEnabled) {
            const grant = authorize(token);
            return (
                command('reserve-operation', {
                    session: grant.session,
                    generation: grant.generation,
                    tokenDigest: digest(token),
                    operationId: id,
                    inputDigest: fingerprint,
                }) === 'reserved'
            );
        }
        const result = db
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

    function observeOperation(
        session: string,
        generation: number,
        id: string,
        outcome: 'SUCCEEDED' | 'FAILED',
    ) {
        if (
            command('observe-operation', {
                session,
                generation,
                operationId: id,
                outcome,
            }) !== undefined
        )
            return;
        requireChange(
            db
                .prepare(
                    `
            UPDATE operations SET state=? WHERE session=? AND generation=? AND id=? AND state='UNKNOWN'
        `,
                )
                .run(outcome, session, generation, id).changes,
        );
    }

    function hasUnknownOperations(
        session: string,
        generation: number,
    ): boolean {
        return (
            db
                .prepare(
                    "SELECT 1 FROM operations WHERE session=? AND generation=? AND state='UNKNOWN' LIMIT 1",
                )
                .get(session, generation) !== undefined
        );
    }

    function operation(session: string, generation: number, id: string) {
        return db
            .prepare(
                'SELECT state,digest FROM operations WHERE session=? AND generation=? AND id=?',
            )
            .get(session, generation, id);
    }
    return {
        reserveOperation,
        observeOperation,
        hasUnknownOperations,
        operation,
    };
}
