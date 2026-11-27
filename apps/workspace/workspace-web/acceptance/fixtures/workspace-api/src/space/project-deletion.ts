import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
    notFound,
    RequestError,
    type Backend,
    type ProjectDeletionBlocker,
} from '../protocol.ts';
import { spaceObjectKey, type spaceStorage } from './storage.ts';
import type { spaceExecution } from './execution.ts';
import type { Upload } from './upload.ts';

const key = (row: Upload) => spaceObjectKey(row.id);
type DeletionBlocker = 'upload_pending' | ProjectDeletionBlocker;
export type ProjectDeletion = {
    spaceId: string;
    owner: string;
    operationId: string;
    executionProjectId: string | null;
    phase: 'holding' | 'committing' | 'releasing' | 'cleaning' | 'deleted';
    lastError: string | null;
};
const deletionBlockers: DeletionBlocker[] = [
    'upload_pending',
    'project_importing',
    'project_busy',
];
const uploadPending = "('preparing','uploading','completing','cleaning')";

export function projectBlocked(code: DeletionBlocker) {
    const messages = {
        upload_pending: '请先取消并清理未完成的上传。',
        project_importing: '请等待工作区初始化结束。',
        project_busy: '项目仍有未结束的任务或正在清理。',
    };
    return new RequestError(409, code, messages[code]);
}

function projectDeletionUnconfirmed() {
    return new RequestError(
        503,
        'project_delete_unconfirmed',
        '暂无法确认项目删除进度，请重试。',
    );
}

type Options = {
    db: DatabaseSync;
    storage: ReturnType<typeof spaceStorage>;
    backend: Backend;
    execution: ReturnType<typeof spaceExecution>;
    projectDeletion(
        owner: string,
        spaceId: string,
    ): ProjectDeletion | undefined;
    requireWritableProject(owner: string, spaceId: string): void;
    setState(row: Upload, state: Upload['state']): void;
    commitDeletionChange(change: () => void): void;
};
export function spaceProjectDeletion({
    db,
    storage,
    backend,
    execution,
    projectDeletion,
    requireWritableProject,
    setState,
    commitDeletionChange,
}: Options) {
    const projectAdvances = new Map<
        string,
        Promise<{ deleteStatus: 202 | 204 }>
    >();
    function spaceImpact(owner: string, spaceId: string) {
        const binding = execution.projectDeletionInput(owner, spaceId);
        const counts = db
            .prepare(
                `
            SELECT count(CASE WHEN state IN ('saved','deleting') THEN 1 END) AS fileCount,
                   count(CASE WHEN state IN ${uploadPending} THEN 1 END) AS uploadCount
            FROM space_uploads WHERE owner=? AND project=?
        `,
            )
            .get(owner, spaceId) as { fileCount: number; uploadCount: number };
        return { ...binding, ...counts };
    }

    async function projectDeletionImpact(owner: string, spaceId: string) {
        const { importing, projectId, fileCount, uploadCount } = spaceImpact(
            owner,
            spaceId,
        );
        const blockers = new Set<DeletionBlocker>();
        if (uploadCount) blockers.add('upload_pending');
        if (importing) blockers.add('project_importing');
        let runCount = 0;
        let diffCount = 0;
        if (projectDeletion(owner, spaceId)?.phase !== 'cleaning') {
            try {
                const result = await backend(owner, {
                    kind: 'taskSourceImpact',
                    spaceId,
                    legacyProjectId: projectId,
                });
                if (!('json' in result) || !('blockers' in result.json))
                    throw new Error('Missing execution impact');
                ({ runCount, diffCount } = result.json);
                for (const code of result.json.blockers) blockers.add(code);
            } catch {
                const phase = projectDeletion(owner, spaceId)?.phase;
                if (phase === 'deleted') throw notFound();
                if (phase !== 'cleaning') throw projectDeletionUnconfirmed();
            }
        }
        if (projectDeletion(owner, spaceId)?.phase === 'deleted')
            throw notFound();
        return {
            fileCount,
            uploadCount,
            runCount,
            diffCount,
            blockers: deletionBlockers.filter((code) => blockers.has(code)),
        };
    }

    function beginProjectCleaning(owner: string, spaceId: string) {
        db.prepare(
            "UPDATE space_project_deletions SET phase='cleaning', lastError=NULL WHERE owner=? AND spaceId=?",
        ).run(owner, spaceId);
        db.prepare(
            "UPDATE space_uploads SET state='deleting' WHERE owner=? AND project=? AND state='saved'",
        ).run(owner, spaceId);
    }

    async function cleanProject(owner: string, spaceId: string) {
        const rows = db
            .prepare(
                "SELECT * FROM space_uploads WHERE owner=? AND project=? AND state='deleting' ORDER BY rowid",
            )
            .all(owner, spaceId) as Upload[];
        for (const row of rows) {
            if ((await storage.size(key(row))) !== null)
                await storage.remove(key(row));
            if ((await storage.size(key(row))) !== null)
                throw new Error('Object cleanup pending');
            setState(row, 'deleted');
        }
        commitDeletionChange(() => {
            db.prepare(
                'INSERT OR IGNORE INTO space_retired_upload_ids SELECT id FROM space_uploads WHERE owner=? AND project=?',
            ).run(owner, spaceId);
            db.prepare(
                'DELETE FROM space_uploads WHERE owner=? AND project=?',
            ).run(owner, spaceId);
            db.prepare(
                'DELETE FROM space_execution WHERE owner=? AND spaceId=?',
            ).run(owner, spaceId);
            execution.purgeTaskIntents(owner, spaceId);
            db.prepare('DELETE FROM space_projects WHERE owner=? AND id=?').run(
                owner,
                spaceId,
            );
            db.prepare(
                "UPDATE space_project_deletions SET phase='deleted',lastError=NULL WHERE owner=? AND spaceId=?",
            ).run(owner, spaceId);
        });
    }

    function advanceProjectDeletion(
        owner: string,
        spaceId: string,
    ): Promise<{ deleteStatus: 202 | 204 }> {
        const intent = projectDeletion(owner, spaceId);
        if (!intent) throw notFound();
        if (intent.phase === 'deleted')
            return Promise.resolve({ deleteStatus: 204 });
        const prior = projectAdvances.get(spaceId);
        if (prior) return prior;
        const task = (async (): Promise<{ deleteStatus: 202 | 204 }> => {
            let phase = intent.phase;
            const forward = (phase: 'hold' | 'commit' | 'release') =>
                backend(owner, {
                    kind: 'taskSourceDeletion',
                    spaceId,
                    operationId: intent.operationId,
                    legacyProjectId: intent.executionProjectId,
                    phase,
                });
            const record = (
                state: ProjectDeletion['phase'],
                error: string | null = null,
            ) => {
                db.prepare(
                    'UPDATE space_project_deletions SET phase=?,lastError=? WHERE owner=? AND spaceId=?',
                ).run(state, error, owner, spaceId);
            };
            if (phase === 'holding') {
                try {
                    if (!(await execution.settleProjectTasks(owner, spaceId)))
                        return { deleteStatus: 202 };
                    const received = await forward('hold');
                    if (received.status === 204) {
                        commitDeletionChange(() =>
                            beginProjectCleaning(owner, spaceId),
                        );
                        phase = 'cleaning';
                    } else if (
                        received.status === 202 &&
                        'json' in received &&
                        'state' in received.json
                    ) {
                        if (received.json.state === 'deleting')
                            return (
                                record('committing'),
                                { deleteStatus: 202 }
                            );
                        if (received.json.state !== 'held')
                            throw new Error('Invalid source hold receipt');
                        record('committing');
                        phase = 'committing';
                    } else throw new Error('Invalid source hold receipt');
                } catch (error) {
                    if (
                        !(error instanceof RequestError) ||
                        error.status !== 409 ||
                        ![
                            'project_busy',
                            'project_importing',
                            'owner_closed',
                        ].includes(error.code)
                    ) {
                        record('holding', 'execution_unconfirmed');
                        throw projectDeletionUnconfirmed();
                    }
                    record('releasing', error.code);
                    phase = 'releasing';
                }
            }
            if (phase === 'releasing') {
                try {
                    const result = await forward('release');
                    if (result.status !== 204)
                        throw new Error('Invalid source release receipt');
                } catch (error) {
                    if (
                        error instanceof RequestError &&
                        error.code === 'deletion_committed'
                    ) {
                        record('committing');
                        return { deleteStatus: 202 };
                    }
                    throw projectDeletionUnconfirmed();
                }
                const code = projectDeletion(owner, spaceId)?.lastError;
                commitDeletionChange(() => {
                    db.prepare(
                        'DELETE FROM space_project_deletions WHERE owner=? AND spaceId=?',
                    ).run(owner, spaceId);
                });
                throw projectBlocked(
                    code === 'project_importing'
                        ? 'project_importing'
                        : 'project_busy',
                );
            }
            if (phase === 'committing') {
                try {
                    const result = await forward('commit');
                    if (
                        result.status === 202 &&
                        'json' in result &&
                        'state' in result.json &&
                        result.json.state === 'deleting'
                    )
                        return { deleteStatus: 202 };
                    if (result.status !== 204)
                        throw new Error('Invalid source commit receipt');
                } catch {
                    record('committing', 'execution_unconfirmed');
                    throw projectDeletionUnconfirmed();
                }
                commitDeletionChange(() =>
                    beginProjectCleaning(owner, spaceId),
                );
            }
            try {
                await cleanProject(owner, spaceId);
                return { deleteStatus: 204 };
            } catch {
                record('cleaning', 'storage_unconfirmed');
                return { deleteStatus: 202 };
            }
        })().finally(() => projectAdvances.delete(spaceId));
        projectAdvances.set(spaceId, task);
        return task;
    }

    function deleteProject(owner: string, spaceId: string) {
        commitDeletionChange(() => {
            if (projectDeletion(owner, spaceId)) return;
            const { importing, projectId, uploadCount } = spaceImpact(
                owner,
                spaceId,
            );
            requireWritableProject(owner, spaceId);
            if (uploadCount) throw projectBlocked('upload_pending');
            if (importing) throw projectBlocked('project_importing');
            if (
                db
                    .prepare(
                        `
                SELECT 1 FROM space_file_deletions d JOIN space_uploads u ON u.id=d.fileId
                WHERE u.owner=? AND u.project=?
            `,
                    )
                    .get(owner, spaceId)
            )
                throw projectDeletionUnconfirmed();
            db.prepare(
                'INSERT INTO space_project_deletions VALUES (?,?,?,?,?,NULL)',
            ).run(spaceId, owner, randomUUID(), projectId, 'holding');
        });
        return advanceProjectDeletion(owner, spaceId);
    }

    return {
        projectDeletionImpact,
        advanceProjectDeletion,
        deleteProject,
        pending: () => projectAdvances.values(),
    };
}
