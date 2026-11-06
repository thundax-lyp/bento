import { DatabaseSync } from 'node:sqlite';

const revoked = 'bento:revoked';

/** Control-plane adapter for the version-locked EXP-025 SQLite persistence schema. */
export class PersistenceFence {
    private readonly db: DatabaseSync;

    constructor(path: string) {
        this.db = new DatabaseSync(path);
        this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    }

    revoke(session: string, generation: number, owner: string) {
        if (owner === revoked) throw new Error('reserved owner');
        const result = this.db
            .prepare(
                `
            UPDATE sessions SET owner=?,handle=NULL
            WHERE id=? AND epoch=? AND (owner=? OR owner=?)
        `,
            )
            .run(revoked, session, generation, owner, revoked);
        if (Number(result.changes) !== 1)
            throw new Error('write revocation CAS denied');
    }

    isRevoked(session: string, generation: number) {
        return (
            this.db
                .prepare(
                    `
            SELECT 1 FROM sessions WHERE id=? AND epoch=? AND owner=? AND handle IS NULL
        `,
                )
                .get(session, generation, revoked) !== undefined
        );
    }

    /** Called by the trusted launcher after Run admission and before handing its credential to the worker. */
    grant(session: string, generation: number, owner: string) {
        if (!owner || owner === revoked) throw new Error('invalid owner');
        const result = this.db
            .prepare(
                `
            UPDATE sessions SET epoch=?,owner=?
            WHERE id=? AND epoch=? AND owner=? AND handle IS NULL
        `,
            )
            .run(generation, owner, session, generation - 1, revoked);
        if (Number(result.changes) !== 1)
            throw new Error('new writer CAS denied');
    }

    close() {
        this.db.close();
    }
}
