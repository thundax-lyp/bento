import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { notFound, RequestError, type Backend } from '../protocol.ts';
import { spaceObjectKey, type spaceStorage } from './storage.ts';
import type { spaceExecution } from './execution.ts';
import type { Upload } from './upload.ts';
import type { goSpaceUpload } from './index.ts';

type FileDeletion = {
    operationId: string;
    executionProjectId: string | null;
    phase: 'checking' | 'deleting' | 'releasing';
};

export function spaceFileDeletion({
    db,
    backend,
    storage,
    upload,
    requireWritableProject,
    setState,
    locked,
    active,
    execution,
    commitDeletionChange,
    goUpload,
}: {
    db: DatabaseSync;
    backend: Backend;
    storage: Pick<ReturnType<typeof spaceStorage>, 'size' | 'remove'>;
    upload: (owner: string, fileId: string) => Upload;
    requireWritableProject: (owner: string, project: string) => void;
    setState: (row: Upload, state: Upload['state']) => void;
    locked: <T>(fileId: string, action: () => Promise<T>) => Promise<T>;
    active: ReadonlySet<string>;
    commitDeletionChange: (change: () => void) => void;
    goUpload?: typeof goSpaceUpload;
    execution: Pick<
        ReturnType<typeof spaceExecution>,
        'hasTaskPin' | 'deletionProject'
    >;
}) {
    const key = (row: Upload) => spaceObjectKey(row.id);
    const deletionUnconfirmed = () =>
        new RequestError(
            503,
            'file_delete_unconfirmed',
            '暂未确认删除结果，请刷新后重试。',
        );
    function fileDeletion(fileId: string) {
        return db
            .prepare(
                'SELECT operationId,executionProjectId,phase FROM space_file_deletions WHERE fileId=?',
            )
            .get(fileId) as FileDeletion | undefined;
    }

    async function fileDeleteHold(
        row: Upload,
        intent: FileDeletion,
        kind: 'acquireTaskInputDeleteHold' | 'releaseTaskInputDeleteHold',
    ): Promise<'held' | 'denied' | 'released'> {
        const result = await backend(row.owner, {
            kind,
            spaceId: row.project,
            fileId: row.id,
            legacyProjectId: intent.executionProjectId,
            operationId: intent.operationId,
        });
        if (!('json' in result) || !('state' in result.json))
            throw new Error('Missing file deletion hold receipt');
        const { state } = result.json;
        if (state !== 'held' && state !== 'denied' && state !== 'released')
            throw new Error('Unexpected file deletion hold state');
        return state;
    }

    async function checkFileDeletion(row: Upload): Promise<'held' | 'denied'> {
        const intent = fileDeletion(row.id);
        if (intent?.phase !== 'checking')
            throw new Error('Missing checking phase');
        let state;
        try {
            state = await fileDeleteHold(
                row,
                intent,
                'acquireTaskInputDeleteHold',
            );
        } catch (error) {
            if (
                error instanceof RequestError &&
                (error.code === 'owner_closed' || error.code === 'not_found')
            )
                db.prepare(
                    'DELETE FROM space_file_deletions WHERE fileId=?',
                ).run(row.id);
            throw error;
        }
        if (state === 'denied') {
            db.prepare('DELETE FROM space_file_deletions WHERE fileId=?').run(
                row.id,
            );
            return state;
        }
        if (state !== 'held')
            throw new Error('Unexpected file deletion hold state');
        commitDeletionChange(() => {
            setState(row, 'deleting');
            db.prepare(
                "UPDATE space_file_deletions SET phase='deleting' WHERE fileId=?",
            ).run(row.id);
        });
        return state;
    }

    async function advanceFileDeletion(row: Upload): Promise<void> {
        if (goUpload) {
            await goUpload('advance-delete', { owner: row.owner, id: row.id });
            return;
        }
        const intent = fileDeletion(row.id);
        if (!intent) return;
        if (
            intent.phase === 'checking' &&
            (await checkFileDeletion(row)) === 'denied'
        )
            return;
        if (intent.phase !== 'releasing') {
            if ((await storage.size(key(row))) !== null)
                await storage.remove(key(row));
            db.prepare(
                "UPDATE space_file_deletions SET phase='releasing' WHERE fileId=?",
            ).run(row.id);
        }
        if (
            (await fileDeleteHold(
                row,
                intent,
                'releaseTaskInputDeleteHold',
            )) !== 'released'
        )
            throw new Error('File deletion hold release unconfirmed');
        commitDeletionChange(() => {
            setState(row, 'deleted');
            db.prepare('DELETE FROM space_file_deletions WHERE fileId=?').run(
                row.id,
            );
        });
    }

    async function deleteFile(owner: string, fileId: string) {
        const row = upload(owner, fileId);
        requireWritableProject(owner, row.project);
        if (row.state === 'deleted') return { deleteStatus: 204 } as const;
        if (row.state === 'deleting') return { deleteStatus: 202 } as const;
        if (row.state !== 'saved') throw notFound();
        if (active.has(fileId)) throw deletionUnconfirmed();
        return locked(fileId, async () => {
            if (goUpload)
                return goUpload<{ deleteStatus: 202 | 204 }>('delete', {
                    owner,
                    id: fileId,
                });
            if (!fileDeletion(fileId)) {
                commitDeletionChange(() => {
                    requireWritableProject(owner, row.project);
                    if (upload(owner, fileId).state !== 'saved')
                        throw notFound();
                    if (execution.hasTaskPin(fileId))
                        throw new RequestError(
                            409,
                            'project_busy',
                            '文件正在被未结束的任务使用。',
                        );
                    const projectId = execution.deletionProject(
                        owner,
                        row.project,
                        fileId,
                    );
                    db.prepare(
                        "INSERT INTO space_file_deletions VALUES (?,?,?,'checking')",
                    ).run(fileId, randomUUID(), projectId);
                });
            }
            const decision = await checkFileDeletion(row).catch(
                (error: unknown) => {
                    if (
                        error instanceof RequestError &&
                        (error.code === 'owner_closed' ||
                            error.code === 'not_found')
                    )
                        throw error;
                    throw deletionUnconfirmed();
                },
            );
            if (decision === 'denied')
                throw new RequestError(
                    409,
                    'project_busy',
                    '文件正在被未结束的任务使用。',
                );
            return { deleteStatus: 202 } as const;
        });
    }

    return { advanceFileDeletion, deleteFile };
}
