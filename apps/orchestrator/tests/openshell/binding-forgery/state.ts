import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Paths = { authority: string; history: string };
export const sha256 = (value: string | Uint8Array) =>
    createHash('sha256').update(value).digest('hex');

export function snapshot(paths: Paths, volumes: readonly string[]) {
    function tables(path: string, names: readonly string[]) {
        const db = new DatabaseSync(path, { readOnly: true });
        try {
            return Object.fromEntries(
                names.map((name) => {
                    const rows = db
                        .prepare('SELECT * FROM ' + name)
                        .all()
                        .map((row) =>
                            Object.fromEntries(
                                Object.entries(row).map(([key, value]) => [
                                    key,
                                    key === 'capability'
                                        ? {
                                              present: value !== null,
                                              sha256:
                                                  value === null
                                                      ? null
                                                      : sha256(String(value)),
                                          }
                                        : value instanceof Uint8Array
                                          ? Buffer.from(value).toString('hex')
                                          : value,
                                ]),
                            ),
                        );
                    rows.sort((a, b) =>
                        JSON.stringify(a).localeCompare(JSON.stringify(b)),
                    );
                    return [name, rows];
                }),
            );
        } finally {
            db.close();
        }
    }
    return {
        authority: tables(paths.authority, [
            'execution_sessions',
            'operations',
            'management_stops',
            'management_starts',
        ]),
        history: tables(paths.history, [
            'sessions',
            'events',
            'batch_receipts',
            'batch_intents',
            'history_checkpoints',
            'history_restores',
        ]),
        files: [...volumes].sort().map((volume) => {
            const path = join(volume, 'canary.txt');
            const bytes = existsSync(path) ? readFileSync(path) : null;
            return {
                volume,
                bytes: bytes?.toString('hex') ?? null,
                sha256: bytes === null ? null : sha256(bytes),
            };
        }),
    };
}
