import { DatabaseSync } from 'node:sqlite';
import type { CompletedPart } from '@aws-sdk/client-s3';
import { notFound, object, RequestError } from './protocol.ts';
import type { Backend } from './protocol.ts';
import {
    partUrlSeconds,
    spaceObjectKey,
    spaceStorage,
} from './space-storage.ts';
import { spaceExecution } from './space-execution.ts';

const quota = 10_000_000_000;
const fileLimit = 4_000_000_000;
const previewLimit = 256 * 1024;
const partSize = 16 * 1024 * 1024;
const lifetime = 24 * 60 * 60 * 1000;
const statesWithSpace =
    "('preparing','uploading','completing','cleaning','saved')";
type Upload = {
    id: string;
    project: string;
    owner: string;
    path: string;
    size: number;
    manifest: string;
    state:
        | 'preparing'
        | 'uploading'
        | 'completing'
        | 'cleaning'
        | 'saved'
        | 'cancelled'
        | 'expired'
        | 'failed';
    storageId: string | null;
    expires: number;
    signedUntil: number;
    cleanup: 'cancelled' | 'expired' | 'failed' | null;
};

function id(value: unknown): string {
    if (
        typeof value !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
            value,
        )
    )
        throw notFound();
    return value;
}

function invalid(message: string) {
    return new RequestError(400, 'invalid_space_input', message);
}

function conflict(message: string) {
    return new RequestError(409, 'space_conflict', message);
}

const key = (row: Upload) => spaceObjectKey(row.id);
const partBytes = (row: Upload, n: number) =>
    Math.min(partSize, row.size - (n - 1) * partSize);
const manifest = (row: Upload) => JSON.parse(row.manifest) as string[];
function view(row: Upload) {
    const { id, project, path, size, state, expires } = row;
    return { id, project, path, size, state, expires };
}

export function mySpace(
    dbPath: string,
    storage: ReturnType<typeof spaceStorage>,
    backend: Backend,
) {
    const db = new DatabaseSync(dbPath);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS space_projects (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS space_uploads (
            id TEXT PRIMARY KEY, project TEXT NOT NULL, owner TEXT NOT NULL,
            path TEXT NOT NULL, size INTEGER NOT NULL, manifest TEXT NOT NULL,
            state TEXT NOT NULL, storageId TEXT, expires INTEGER NOT NULL,
            signedUntil INTEGER NOT NULL DEFAULT 0, cleanup TEXT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS space_owner ON space_uploads(owner, state);
        CREATE INDEX IF NOT EXISTS space_project ON space_uploads(project, state);
    `);
    const execution = spaceExecution(db, backend, storage.read);
    const active = new Set<string>();
    let sweeping: Promise<void> | undefined;
    let closing = false;

    function upload(owner: string, uploadId: string): Upload {
        const row = db
            .prepare('SELECT * FROM space_uploads WHERE id = ? AND owner = ?')
            .get(uploadId, owner) as Upload | undefined;
        if (!row) throw notFound();
        return row;
    }

    function setState(row: Upload, state: Upload['state']) {
        db.prepare('UPDATE space_uploads SET state = ? WHERE id = ?').run(
            state,
            row.id,
        );
    }

    async function locked<T>(uploadId: string, action: () => Promise<T>) {
        if (active.has(uploadId))
            throw conflict('操作处理中，请稍后查看状态。');
        active.add(uploadId);
        try {
            return await action();
        } finally {
            active.delete(uploadId);
        }
    }

    function reserve(owner: string, project: string, data: unknown) {
        const input = object(data);
        const uploadId = id(input.id);
        const path = input.path;
        const size = input.size;
        const checksums = input.checksums;
        if (
            typeof path !== 'string' ||
            path.length > 1024 ||
            /[\\\p{Cc}\p{Surrogate}]/u.test(path) ||
            path.split('/').some((segment) => ['', '.', '..'].includes(segment))
        )
            throw invalid('文件路径无效。');
        if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
            throw invalid('文件大小无效。');
        if (size > fileLimit)
            throw new RequestError(413, 'file_limit', '单文件最多 4 GB。');
        if (
            !Array.isArray(checksums) ||
            checksums.length !== Math.ceil(size / partSize) ||
            checksums.some(
                (value) =>
                    typeof value !== 'string' ||
                    !/^[A-Za-z0-9+/]{43}=$/.test(value) ||
                    Buffer.from(value, 'base64').toString('base64') !== value,
            )
        )
            throw invalid('分块摘要清单无效。');
        const encoded = JSON.stringify(checksums);

        db.exec('BEGIN IMMEDIATE');
        try {
            if (
                !db
                    .prepare(
                        'SELECT id FROM space_projects WHERE id = ? AND owner = ?',
                    )
                    .get(project, owner)
            )
                throw notFound();
            const existing = db
                .prepare('SELECT * FROM space_uploads WHERE id = ?')
                .get(uploadId) as Upload | undefined;
            if (existing) {
                if (existing.owner !== owner) throw notFound();
                if (
                    existing.project !== project ||
                    existing.path !== path ||
                    existing.size !== size ||
                    existing.manifest !== encoded
                )
                    throw conflict('同一上传编号对应不同文件。');
            } else {
                const collision = db
                    .prepare(
                        `
                    SELECT id FROM space_uploads WHERE project = ? AND state IN ${statesWithSpace}
                    AND (path = ? OR instr(path, ? || '/') = 1 OR instr(?, path || '/') = 1)
                    LIMIT 1
                `,
                    )
                    .get(project, path, path, path);
                if (collision) throw conflict('目标路径已有文件或上传。');
                const used = Number(
                    db
                        .prepare(
                            `
                    SELECT coalesce(sum(size), 0) AS bytes FROM space_uploads
                    WHERE owner = ? AND state IN ${statesWithSpace}
                `,
                        )
                        .get(owner)?.bytes,
                );
                if (used + size > quota)
                    throw new RequestError(
                        409,
                        'space_quota',
                        '账号空间不足，已保存和上传预占合计最多 10 GB。',
                    );
                db.prepare(
                    `
                    INSERT INTO space_uploads (id, project, owner, path, size, manifest, state, expires)
                    VALUES (?, ?, ?, ?, ?, ?, 'preparing', ?)
                `,
                ).run(
                    uploadId,
                    project,
                    owner,
                    path,
                    size,
                    encoded,
                    Date.now() + lifetime,
                );
            }
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
        return uploadId;
    }

    async function prepare(row: Upload) {
        if (row.state !== 'preparing') return row;
        if (row.expires <= Date.now()) throw conflict('上传已过期。');
        // Remove any orphan from a prior initiation whose response was lost.
        if (row.size > 0) await storage.abort(key(row));
        const storageId = row.size > 0 ? await storage.create(key(row)) : null;
        db.prepare(
            "UPDATE space_uploads SET state = 'uploading', storageId = ? WHERE id = ?",
        ).run(storageId, row.id);
        return upload(row.owner, row.id);
    }

    async function parts(row: Upload): Promise<CompletedPart[] | null> {
        if (!row.storageId) return [];
        const checksums = manifest(row);
        const existing = await storage.parts(key(row), row.storageId);
        return (
            existing
                ?.flatMap((part) => {
                    const n = part.PartNumber;
                    if (
                        !n ||
                        !part.ETag ||
                        part.Size !== partBytes(row, n) ||
                        !checksums[n - 1] ||
                        part.ChecksumSHA256 !== checksums[n - 1]
                    )
                        return [];
                    return [
                        {
                            PartNumber: n,
                            ETag: part.ETag,
                            ChecksumSHA256: checksums[n - 1],
                        },
                    ];
                })
                .sort((a, b) => a.PartNumber - b.PartNumber) ?? null
        );
    }

    async function finish(row: Upload) {
        if (row.state === 'saved') return row;
        if (!['uploading', 'completing'].includes(row.state))
            throw conflict('此上传无法完成。');
        if (row.state === 'uploading') {
            if (row.expires <= Date.now()) throw conflict('上传已过期。');
            setState(row, 'completing');
        }
        let actual = await storage.size(key(row));
        if (actual === null) {
            if (row.storageId) {
                const completed = await parts(row);
                if (
                    !completed ||
                    completed.length !== manifest(row).length ||
                    completed.some(
                        (part, index) => part.PartNumber !== index + 1,
                    )
                ) {
                    // A prior Complete can finish between HEAD and ListParts.
                    actual = await storage.size(key(row));
                    if (actual === null) {
                        setState(row, 'uploading');
                        throw conflict('分块未齐，请补传后重试。');
                    }
                } else {
                    await storage.complete(key(row), row.storageId, completed);
                }
            } else {
                await storage.empty(key(row));
            }
            actual ??= await storage.size(key(row));
        }
        if (actual === null) throw new Error('Stored object not visible');
        if (actual !== row.size) {
            await clean(row, 'failed');
            throw conflict('存储文件大小不符，上传已停止。');
        }
        setState(row, 'saved');
        return upload(row.owner, row.id);
    }

    async function clean(row: Upload, outcome: NonNullable<Upload['cleanup']>) {
        if (row.state !== 'cleaning') {
            db.prepare(
                "UPDATE space_uploads SET state = 'cleaning', cleanup = ? WHERE id = ?",
            ).run(outcome, row.id);
        }
        if (row.signedUntil > Date.now()) return;
        if (row.size > 0)
            await storage.abort(key(row), row.storageId ?? undefined);
        if ((await storage.size(key(row))) !== null)
            await storage.remove(key(row));
        setState(row, row.cleanup ?? outcome);
    }

    async function sweep() {
        const rows = db
            .prepare(
                `
                SELECT * FROM space_uploads WHERE state = 'completing'
                OR (state = 'cleaning' AND signedUntil <= ?)
                OR (state IN ('preparing','uploading') AND expires <= ?)
            `,
            )
            .all(Date.now(), Date.now()) as Upload[];
        for (const row of rows) {
            if (closing) return;
            if (active.has(row.id)) continue;
            await locked(row.id, async () => {
                const current = upload(row.owner, row.id);
                if (current.state === 'completing') await finish(current);
                else if (
                    current.state === 'cleaning' ||
                    (['preparing', 'uploading'].includes(current.state) &&
                        current.expires <= Date.now())
                )
                    await clean(current, 'expired');
            }).catch(() => {
                // Keep the durable state for the next reconciliation attempt.
            });
        }
    }
    const timer = setInterval(() => {
        if (closing || sweeping) return;
        sweeping = sweep()
            .catch(() => undefined)
            .finally(() => {
                sweeping = undefined;
            });
    }, 30_000).unref();

    async function route(
        owner: string,
        method: string | undefined,
        path: string,
        read: () => Promise<unknown>,
        idempotencyKeys?: string[],
    ) {
        if (path === '/api/space' && method === 'GET') {
            const projects = db
                .prepare(
                    'SELECT id, name FROM space_projects WHERE owner = ? ORDER BY rowid DESC',
                )
                .all(owner);
            const uploads = db
                .prepare(
                    'SELECT * FROM space_uploads WHERE owner = ? ORDER BY rowid DESC',
                )
                .all(owner) as Upload[];
            let saved = 0;
            let reserved = 0;
            for (const row of uploads) {
                if (row.state === 'saved') saved += row.size;
                else if (
                    !['cancelled', 'expired', 'failed'].includes(row.state)
                )
                    reserved += row.size;
            }
            return {
                projects,
                uploads: uploads.map(view),
                quota,
                fileLimit,
                partSize,
                saved,
                reserved,
            };
        }
        if (path === '/api/space/projects' && method === 'POST') {
            const input = object(await read());
            const projectId = id(input.id);
            const name =
                typeof input.name === 'string' ? input.name.trim() : '';
            if (!name || name.length > 120 || /\p{Cc}/u.test(name))
                throw invalid('项目名称无效。');
            db.prepare(
                'INSERT OR IGNORE INTO space_projects VALUES (?, ?, ?)',
            ).run(projectId, owner, name);
            const existing = db
                .prepare(
                    'SELECT name FROM space_projects WHERE id = ? AND owner = ?',
                )
                .get(projectId, owner);
            if (!existing) throw notFound();
            if (existing.name !== name)
                throw conflict('同一项目编号对应不同名称。');
            return { id: projectId };
        }

        const [, , , group, rawId, action, ...rest] = path.split('/');
        if (rest.length) throw notFound();
        const resource = id(rawId);
        if (group === 'projects' && action === undefined && method === 'GET')
            return execution.detail(owner, resource);
        if (
            group === 'projects' &&
            action === 'execution' &&
            method === 'POST'
        ) {
            const key = idempotencyKeys?.[0];
            if (
                idempotencyKeys?.length !== 1 ||
                !key ||
                !/^[!-~]{1,128}$/.test(key)
            )
                throw new RequestError(
                    400,
                    'invalid_key',
                    '请提供有效的 Idempotency-Key。',
                );
            return execution.start(owner, resource, key, await read());
        }
        if (group === 'projects' && action === 'uploads' && method === 'POST') {
            const uploadId = reserve(owner, resource, await read());
            return locked(uploadId, async () =>
                view(await prepare(upload(owner, uploadId))),
            );
        }
        if (group === 'files' && action === 'preview' && method === 'GET') {
            const row = upload(owner, resource);
            if (row.state !== 'saved') throw notFound();
            if (row.size > previewLimit)
                throw new RequestError(
                    413,
                    'preview_too_large',
                    '文件超过 256 KiB，无法预览。',
                );
            return { redirect: await storage.preview(key(row)) };
        }
        if (group === 'files' && action === 'download' && method === 'GET') {
            const row = upload(owner, resource);
            if (row.state !== 'saved') throw notFound();
            return {
                redirect: await storage.download(
                    key(row),
                    row.path.split('/').at(-1)!,
                ),
            };
        }
        if (group !== 'uploads') throw notFound();
        if (!action && method === 'GET') {
            const row = upload(owner, resource);
            return {
                ...view(row),
                parts:
                    row.state === 'uploading'
                        ? ((await parts(row)) ?? []).map(
                              (part) => part.PartNumber,
                          )
                        : [],
            };
        }
        if (method !== 'POST') throw notFound();
        return locked(resource, async () => {
            let row = upload(owner, resource);
            if (action === 'complete') return view(await finish(row));
            if (action === 'cancel') {
                if (['saved', 'completing'].includes(row.state))
                    throw conflict('文件已保存或正在确认结果。');
                if (['preparing', 'uploading', 'cleaning'].includes(row.state))
                    await clean(row, 'cancelled');
                return view(upload(owner, resource));
            }
            if (action === 'part') {
                row = await prepare(row);
                if (
                    row.state !== 'uploading' ||
                    !row.storageId ||
                    row.expires <= Date.now()
                )
                    throw conflict('上传不可继续。');
                const n = object(await read()).number;
                const checksums = manifest(row);
                if (
                    typeof n !== 'number' ||
                    !Number.isInteger(n) ||
                    n < 1 ||
                    n > checksums.length
                )
                    throw invalid('分块编号无效。');
                const checksum = checksums[n - 1];
                if (!checksum) throw invalid('分块摘要无效。');
                const url = await storage.signPart(
                    key(row),
                    row.storageId,
                    n,
                    partBytes(row, n),
                    checksum,
                );
                // Record the capability horizon before exposing the URL.
                db.prepare(
                    'UPDATE space_uploads SET signedUntil = ? WHERE id = ?',
                ).run(Date.now() + partUrlSeconds * 1000 + 5000, row.id);
                return { url, checksum };
            }
            throw notFound();
        });
    }

    return {
        origin: storage.origin,
        route,
        drain: execution.drain,
        async purge(owner: string) {
            const rows = db
                .prepare('SELECT * FROM space_uploads WHERE owner = ?')
                .all(owner) as Upload[];
            for (const row of rows) {
                if (
                    active.has(row.id) ||
                    (row.state !== 'saved' && row.signedUntil > Date.now())
                )
                    return false;
                await locked(row.id, async () => {
                    if (row.size > 0)
                        await storage.abort(
                            key(row),
                            row.storageId ?? undefined,
                        );
                    if ((await storage.size(key(row))) !== null)
                        await storage.remove(key(row));
                    db.prepare(
                        'DELETE FROM space_uploads WHERE id = ? AND owner = ?',
                    ).run(row.id, owner);
                });
            }
            db.exec('BEGIN IMMEDIATE');
            try {
                db.prepare('DELETE FROM space_execution WHERE owner = ?').run(
                    owner,
                );
                db.prepare('DELETE FROM space_projects WHERE owner = ?').run(
                    owner,
                );
                db.exec('COMMIT');
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
            return true;
        },
        async close() {
            closing = true;
            clearInterval(timer);
            await Promise.all([sweeping, execution.close()]);
            db.close();
        },
    };
}
