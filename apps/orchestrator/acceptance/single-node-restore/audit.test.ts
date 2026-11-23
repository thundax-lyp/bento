import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
    assertSameLedger,
    lostAcknowledgedRecords,
    readLedger,
    reportJson,
    type CaseReport,
} from './audit.ts';
const names = ['business.sqlite', 'authority.sqlite', 'history.sqlite'];
const canary = 'private-canary-never-in-errors';
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'bento-a7-audit-'));
    for (const name of names) {
        const db = new DatabaseSync(join(root, name));
        db.exec(
            'CREATE TABLE "odd""table"(integer_value INTEGER, real_value REAL, text_value TEXT, blob_value BLOB, null_value); CREATE TABLE empty(value TEXT);',
        );
        db.prepare('INSERT INTO "odd""table" VALUES(?,?,?,?,?)').run(
            9007199254740993n,
            1.25,
            canary,
            new Uint8Array([0, 255]),
            null,
        );
        db.exec(
            'CREATE TABLE events(seq INTEGER,event TEXT); CREATE TABLE batch_receipts(batch TEXT,digest TEXT);',
        );
        db.prepare('INSERT INTO events VALUES(?,?)').run(0, 'original-event');
        db.prepare('INSERT INTO batch_receipts VALUES(?,?)').run(
            'batch-1',
            'original-digest',
        );
        db.close();
    }
    return root;
}
async function hashes(root: string) {
    return Promise.all(
        names.map(async (name) =>
            createHash('sha256')
                .update(await readFile(join(root, name)))
                .digest('hex'),
        ),
    );
}
test('read-only ledger preserves all SQL types, empty tables and source bytes', async () => {
    const root = await fixture();
    try {
        const before = await hashes(root);
        const ledger = await readLedger(root);
        assertSameLedger(ledger, await readLedger(root));
        assert.deepEqual(ledger['business.sqlite/empty'], []);
        assert.deepEqual(ledger['business.sqlite/odd"table']?.[0], {
            blob_value: { type: 'blob', value: 'AP8=' },
            integer_value: { type: 'integer', value: '9007199254740993' },
            null_value: { type: 'null', value: null },
            real_value: { type: 'real', value: 1.25 },
            text_value: { type: 'text', value: canary },
        });
        assert.deepEqual(await hashes(root), before);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
for (const change of ['field', 'receipt', 'history', 'table'] as const) {
    test(
        'ledger rejects complete-state difference without leaking: ' + change,
        async () => {
            const root = await fixture();
            try {
                const before = await readLedger(root);
                const db = new DatabaseSync(join(root, 'history.sqlite'));
                if (change === 'field')
                    db.exec('UPDATE "odd""table" SET integer_value=2');
                if (change === 'receipt')
                    db.exec("UPDATE batch_receipts SET digest='changed'");
                if (change === 'history')
                    db.exec("UPDATE events SET event='changed'");
                if (change === 'table') db.exec('DROP TABLE empty');
                db.close();
                const after = await readLedger(root);
                assert.throws(
                    () => assertSameLedger(before, after),
                    (error) =>
                        error instanceof Error &&
                        error.message === 'ledger_mismatch' &&
                        !String(error).includes(canary),
                );
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        },
    );
}
test('report whitelists fields and counts actual missing acknowledgements', () => {
    const report: CaseReport = {
        schema: 1,
        case: 'A7-01',
        sourceCommit: 'a'.repeat(40),
        restoreCommit: 'b'.repeat(40),
        assertions: [{ name: 'ledger', passed: true }],
        rpo: {
            lastAcknowledgedAt: '2026-11-23T00:00:00Z',
            restoredThroughAt: '2026-11-23T00:00:00Z',
            lostAcknowledgedRecords: lostAcknowledgedRecords(
                ['one', 'two', 'two'],
                ['two'],
            ),
        },
        rto: {
            startedAt: '2026-11-23T00:00:00Z',
            readyAt: '2026-11-23T00:00:01Z',
            milliseconds: 1000,
        },
        cleanup: {
            sourceStopped: true,
            restoredStopped: true,
            ownedResourcesOnly: true,
        },
    };
    const output = reportJson(Object.assign(report, { privateLedger: canary }));
    assert(!output.includes(canary));
    assert.equal(JSON.parse(output).rpo.lostAcknowledgedRecords, 1);
    assert.equal(lostAcknowledgedRecords(['one'], ['one']), 0);
    assert.equal(JSON.parse(output).rto.milliseconds, 1000);
});

test('ledger includes similarly named user tables and ignores physical row ordering', async () => {
    const root = await fixture();
    try {
        let db = new DatabaseSync(join(root, 'business.sqlite'));
        db.exec(
            "CREATE TABLE sqliteXvisible(value TEXT); INSERT INTO sqliteXvisible VALUES('two'),('one');",
        );
        db.close();
        const before = await readLedger(root);
        assert.equal(before['business.sqlite/sqliteXvisible']?.length, 2);
        db = new DatabaseSync(join(root, 'business.sqlite'));
        db.exec(
            "DELETE FROM sqliteXvisible; INSERT INTO sqliteXvisible VALUES('one'),('two');",
        );
        db.close();
        assertSameLedger(before, await readLedger(root));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
