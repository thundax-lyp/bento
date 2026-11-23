import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { backupSqlite, restoreSqlite, verifyBackup } from './backup.ts';

const names = [
    'business.sqlite',
    'authority.sqlite',
    'history.sqlite',
    'temporal.sqlite',
];
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'bento-a7-backup-'));
    const source = join(root, 'source');
    const archive = join(root, 'archive');
    await mkdir(source);
    await mkdir(archive);
    for (const name of names) {
        const db = new DatabaseSync(join(source, name));
        db.exec(
            'PRAGMA journal_mode=WAL; CREATE TABLE proof(id INTEGER PRIMARY KEY, value TEXT NOT NULL);',
        );
        db.prepare('INSERT INTO proof VALUES (?,?)').run(1, name);
        db.close();
    }
    const members = await Promise.all(
        names.map((name) =>
            backupSqlite(join(source, name), join(archive, name)),
        ),
    );
    const hash = async (path: string) =>
        createHash('sha256')
            .update(await readFile(path))
            .digest('hex');
    return {
        root,
        source,
        archive,
        members,
        hash,
        target: join(root, 'restored'),
    };
}
for (const mode of [
    'roundtrip',
    'missing',
    'corrupt',
    'occupied',
    'symlink',
    'duplicate',
] as const) {
    test('offline backup protects source and target: ' + mode, async () => {
        const f = await fixture();
        try {
            const before = await Promise.all(
                names.map((name) => f.hash(join(f.source, name))),
            );
            if (mode === 'roundtrip') {
                await verifyBackup(f.archive, f.members);
                await restoreSqlite(f.archive, f.target, f.members);
                for (const member of f.members)
                    assert.equal(
                        await f.hash(join(f.target, member.path)),
                        member.sha256,
                    );
            } else {
                if (mode === 'missing') await rm(join(f.archive, names[0]!));
                if (mode === 'corrupt')
                    await writeFile(join(f.archive, names[0]!), 'corrupted');
                if (mode === 'symlink') {
                    await rm(join(f.archive, names[0]!));
                    await symlink(
                        join(f.source, names[0]!),
                        join(f.archive, names[0]!),
                    );
                }
                if (mode === 'occupied') {
                    await mkdir(f.target);
                    await writeFile(join(f.target, 'canary'), 'keep');
                }
                await assert.rejects(
                    restoreSqlite(
                        f.archive,
                        f.target,
                        mode === 'duplicate'
                            ? [f.members[0]!, f.members[0]!]
                            : f.members,
                    ),
                    /^Error: backup_invalid$/,
                );
                if (mode === 'occupied')
                    assert.equal(
                        await readFile(join(f.target, 'canary'), 'utf8'),
                        'keep',
                    );
                else
                    await assert.rejects(readFile(join(f.target, names[0]!)), {
                        code: 'ENOENT',
                    });
            }
            assert.deepEqual(
                await Promise.all(
                    names.map((name) => f.hash(join(f.source, name))),
                ),
                before,
            );
        } finally {
            await rm(f.root, { recursive: true, force: true });
        }
    });
}

test('manifest omission rejects before touching source or an occupied restore target', async () => {
    const f = await fixture();
    try {
        const sourceBefore = await Promise.all(
            names.map((name) => f.hash(join(f.source, name))),
        );
        const archiveBefore = await Promise.all(
            names.map((name) => f.hash(join(f.archive, name))),
        );
        await mkdir(f.target);
        await writeFile(join(f.target, 'canary'), 'keep-target');
        const targetBefore = await f.hash(join(f.target, 'canary'));
        await assert.rejects(
            verifyBackup(f.archive, f.members.slice(1)),
            /^Error: backup_invalid$/,
        );
        await assert.rejects(
            restoreSqlite(f.archive, f.target, f.members.slice(1)),
            /^Error: backup_invalid$/,
        );
        assert.deepEqual(
            await Promise.all(
                names.map((name) => f.hash(join(f.source, name))),
            ),
            sourceBefore,
        );
        assert.deepEqual(
            await Promise.all(
                names.map((name) => f.hash(join(f.archive, name))),
            ),
            archiveBefore,
        );
        assert.equal(await f.hash(join(f.target, 'canary')), targetBefore);
        const subset = join(f.root, 'subset');
        await mkdir(subset);
        await writeFile(
            join(subset, names[0]!),
            await readFile(join(f.archive, names[0]!)),
        );
        await verifyBackup(subset, [f.members[0]!]);
    } finally {
        await rm(f.root, { recursive: true, force: true });
    }
});

test('committed WAL outside the manifest cannot authorize restore', async () => {
    const f = await fixture();
    const path = join(f.archive, names[0]!);
    const db = new DatabaseSync(path);
    try {
        db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
        const member = f.members[0]!;
        member.sha256 = await f.hash(path);
        member.bytes = (await readFile(path)).length;
        db.prepare('INSERT INTO proof VALUES (?,?)').run(2, 'wal-only');
        assert.equal(db.prepare('SELECT count(*) AS n FROM proof').get()!.n, 2);
        assert((await readFile(path + '-wal')).length > 0);
        const before = await f.hash(path);
        await assert.rejects(
            verifyBackup(f.archive, f.members),
            /backup_invalid/,
        );
        await assert.rejects(
            restoreSqlite(f.archive, f.target, f.members),
            /backup_invalid/,
        );
        await assert.rejects(readdir(f.target), { code: 'ENOENT' });
        assert.equal(await f.hash(path), before);
    } finally {
        db.close();
        await rm(f.root, { recursive: true, force: true });
    }
});

for (const suffix of ['-wal', '-shm', '-journal'])
    test('standalone backup rejects SQLite sidecar ' + suffix, async () => {
        const f = await fixture();
        try {
            await writeFile(join(f.archive, names[0]! + suffix), '');
            await assert.rejects(
                verifyBackup(f.archive, f.members),
                /backup_invalid/,
            );
            await assert.rejects(
                restoreSqlite(f.archive, f.target, f.members),
                /backup_invalid/,
            );
            await assert.rejects(readdir(f.target), { code: 'ENOENT' });
        } finally {
            await rm(f.root, { recursive: true, force: true });
        }
    });
