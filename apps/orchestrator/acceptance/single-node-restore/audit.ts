import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Ledger = Record<string, readonly Record<string, unknown>[]>;
type Cell = {
    type: 'integer' | 'real' | 'text' | 'blob' | 'null';
    value: string | number | null;
};
const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
function cell(value: unknown): Cell {
    if (value === null) return { type: 'null', value: null };
    if (typeof value === 'bigint')
        return { type: 'integer', value: String(value) };
    if (typeof value === 'number') return { type: 'real', value };
    if (typeof value === 'string') return { type: 'text', value };
    if (value instanceof Uint8Array)
        return { type: 'blob', value: Buffer.from(value).toString('base64') };
    throw new Error('ledger_invalid');
}
export async function readLedger(state: string): Promise<Ledger> {
    try {
        const ledger: Ledger = Object.create(null) as Ledger;
        for (const name of [
            'business.sqlite',
            'authority.sqlite',
            'history.sqlite',
        ]) {
            const db = new DatabaseSync(join(state, name), { readOnly: true });
            try {
                const tables = db
                    .prepare(
                        "SELECT name FROM sqlite_schema WHERE type='table' AND substr(name,1,7) <> 'sqlite_' ORDER BY name",
                    )
                    .all();
                for (const table of tables) {
                    if (typeof table.name !== 'string')
                        throw new Error('ledger_invalid');
                    const statement = db.prepare(
                        'SELECT * FROM ' + identifier(table.name),
                    );
                    statement.setReadBigInts(true);
                    const rows = statement.all().map((row) =>
                        Object.fromEntries(
                            Object.keys(row)
                                .sort()
                                .map((key) => [key, cell(row[key])]),
                        ),
                    );
                    rows.sort((a, b) =>
                        JSON.stringify(a) < JSON.stringify(b)
                            ? -1
                            : JSON.stringify(a) > JSON.stringify(b)
                              ? 1
                              : 0,
                    );
                    ledger[name + '/' + table.name] = rows;
                }
            } finally {
                db.close();
            }
        }
        return ledger;
    } catch {
        throw new Error('ledger_invalid');
    }
}
export function assertSameLedger(before: Ledger, after: Ledger): void {
    const canonical = (value: Ledger) =>
        JSON.stringify(
            Object.keys(value)
                .sort()
                .map((key) => [key, value[key]]),
        );
    if (canonical(before) !== canonical(after))
        throw new Error('ledger_mismatch');
}
export function lostAcknowledgedRecords(
    before: readonly string[],
    after: readonly string[],
): number {
    const restored = new Set(after);
    return [...new Set(before)].filter((id) => !restored.has(id)).length;
}

export type CaseReport = {
    schema: 1;
    case: 'A7-01' | 'A7-02';
    sourceCommit: string;
    restoreCommit: string;
    assertions: { name: string; passed: boolean }[];
    rpo: {
        lastAcknowledgedAt: string;
        restoredThroughAt: string;
        lostAcknowledgedRecords: number;
    };
    rto: { startedAt: string; readyAt: string; milliseconds: number };
    cleanup: {
        sourceStopped: boolean;
        restoredStopped: boolean;
        ownedResourcesOnly: boolean;
    };
};
/** Explicit fields prevent private ledger/config attachments entering public evidence. */
export function reportJson(report: CaseReport): string {
    return (
        JSON.stringify({
            schema: report.schema,
            case: report.case,
            sourceCommit: report.sourceCommit,
            restoreCommit: report.restoreCommit,
            assertions: report.assertions.map(({ name, passed }) => ({
                name,
                passed,
            })),
            rpo: {
                lastAcknowledgedAt: report.rpo.lastAcknowledgedAt,
                restoredThroughAt: report.rpo.restoredThroughAt,
                lostAcknowledgedRecords: report.rpo.lostAcknowledgedRecords,
            },
            rto: {
                startedAt: report.rto.startedAt,
                readyAt: report.rto.readyAt,
                milliseconds: report.rto.milliseconds,
            },
            cleanup: {
                sourceStopped: report.cleanup.sourceStopped,
                restoredStopped: report.cleanup.restoredStopped,
                ownedResourcesOnly: report.cleanup.ownedResourcesOnly,
            },
        }) + '\n'
    );
}
