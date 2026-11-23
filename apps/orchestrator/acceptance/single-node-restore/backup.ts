import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

export type BackupMember = {
    owner: string;
    path: string;
    bytes: number;
    sha256: string;
};
const owners: Record<string, string> = {
    'business.sqlite': 'business',
    'authority.sqlite': 'authority',
    'history.sqlite': 'history',
    'temporal.sqlite': 'temporal',
};
const failure = () => new Error('backup_invalid');
const digest = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex');

async function regular(path: string) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw failure();
    return stat;
}
function healthy(path: string) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        if (
            db
                .prepare('PRAGMA integrity_check')
                .all()
                .some((row) => row.integrity_check !== 'ok') ||
            db.prepare('PRAGMA foreign_key_check').all().length
        )
            throw failure();
    } finally {
        db.close();
    }
}
async function sync(path: string) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

export async function backupSqlite(
    source: string,
    target: string,
): Promise<BackupMember> {
    let created = false;
    try {
        const name = basename(source);
        if (
            !isAbsolute(source) ||
            !isAbsolute(target) ||
            !Object.hasOwn(owners, name) ||
            basename(target) !== name
        )
            throw failure();
        await regular(source);
        const reservation = await open(target, 'wx', 0o600);
        created = true;
        await reservation.close();
        const db = new DatabaseSync(source, { readOnly: true });
        try {
            await backup(db, target);
        } finally {
            db.close();
        }
        healthy(target);
        await sync(target);
        const bytes = await readFile(target);
        return {
            owner: owners[name]!,
            path: name,
            bytes: bytes.length,
            sha256: digest(bytes),
        };
    } catch {
        if (created) await rm(target, { force: true });
        throw failure();
    }
}

export async function verifyBackup(
    root: string,
    members: readonly BackupMember[],
): Promise<void> {
    try {
        if (!isAbsolute(root) || members.length < 1 || members.length > 4)
            throw failure();
        const seen = new Set<string>();
        for (const member of members) {
            if (
                !Object.hasOwn(owners, member.path) ||
                owners[member.path] !== member.owner ||
                seen.has(member.path) ||
                !Number.isSafeInteger(member.bytes) ||
                member.bytes < 0 ||
                !/^[a-f0-9]{64}$/.test(member.sha256)
            )
                throw failure();
            seen.add(member.path);
            const path = join(root, member.path);
            const stat = await regular(path);
            const bytes = await readFile(path);
            if (
                stat.size !== member.bytes ||
                bytes.length !== member.bytes ||
                digest(bytes) !== member.sha256
            )
                throw failure();
            healthy(path);
        }
    } catch {
        throw failure();
    }
}

export async function restoreSqlite(
    backupRoot: string,
    target: string,
    members: readonly BackupMember[],
): Promise<void> {
    let created = false;
    try {
        if (!isAbsolute(target)) throw failure();
        await verifyBackup(backupRoot, members);
        await mkdir(target, { mode: 0o700 });
        created = true;
        for (const member of members) {
            const path = join(target, member.path);
            await copyFile(
                join(backupRoot, member.path),
                path,
                constants.COPYFILE_EXCL,
            );
            await sync(path);
        }
        await verifyBackup(target, members);
    } catch {
        if (created) await rm(target, { recursive: true, force: true });
        throw failure();
    }
}
