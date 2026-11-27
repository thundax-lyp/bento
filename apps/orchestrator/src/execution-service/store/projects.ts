import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { conflict, missing } from '../input.ts';
import {
    type Project,
    projectView,
    now,
    pending,
    projectBinding,
} from './model.ts';
import type {
    FileDeleteHold,
    ProjectDeletionBlocker,
    ProjectDeletionReceipt,
} from './index.ts';
import type { Binding, FileText } from '../types.ts';

export function projectStore({
    db,
    requireOpenOwner,
    pendingTaskRetry,
    inputDeletionHeld,
    taskSourceDeletionBindings,
    write,
}: {
    db: DatabaseSync;
    requireOpenOwner: (owner: string) => void;
    pendingTaskRetry: (id: string) => boolean;
    inputDeletionHeld: (projectId: string) => boolean;
    taskSourceDeletionBindings: (
        owner: string,
        spaceId: string,
        operationId: string,
    ) => Binding[];
    write: <T>(action: () => T) => T;
}) {
    function projectRunIds(project: string) {
        return db
            .prepare('SELECT id FROM runs WHERE projectId = ?')
            .all(project)
            .map((row) => row.id as string);
    }

    function purgeProject(
        binding: Binding,
        operationId?: string,
        sourceSpaceId?: string,
    ) {
        db.exec('BEGIN IMMEDIATE');
        try {
            const sourceDeletion =
                sourceSpaceId !== undefined && operationId !== undefined;
            const sourceBinding = sourceDeletion
                ? taskSourceDeletionBindings(
                      binding.tenant,
                      sourceSpaceId,
                      operationId,
                  ).find((item) => item.project === binding.project)
                : undefined;
            if (sourceDeletion && !sourceBinding) throw missing();
            const actual =
                sourceBinding ??
                (operationId
                    ? projectDeletionBinding(
                          binding.tenant,
                          binding.project,
                          operationId,
                      )
                    : projectBinding(
                          ownedProject(binding.tenant, binding.project, true),
                      ));
            if (
                actual.session !== binding.session ||
                actual.sandbox !== binding.sandbox ||
                actual.volume !== binding.volume
            )
                throw missing();
            if (!operationId && isProjectDeleting(binding.project))
                throw conflict(
                    'project_busy',
                    'Project deletion is in progress.',
                );
            for (const table of [
                'run_dispatches',
                'run_reviews',
                'run_recoveries',
            ])
                db.prepare(
                    'DELETE FROM ' +
                        table +
                        ' WHERE runId IN (SELECT id FROM runs WHERE projectId = ?)',
                ).run(binding.project);
            db.prepare('DELETE FROM runs WHERE projectId = ?').run(
                binding.project,
            );
            db.prepare('DELETE FROM project_requests WHERE projectId = ?').run(
                binding.project,
            );
            db.prepare('DELETE FROM projects WHERE id = ? AND owner = ?').run(
                binding.project,
                binding.tenant,
            );
            if (sourceDeletion)
                db.prepare(
                    'UPDATE task_source_deletion_items SET cleaned=1 WHERE owner=? AND spaceId=? AND operationId=? AND projectId=?',
                ).run(
                    binding.tenant,
                    sourceSpaceId,
                    operationId,
                    binding.project,
                );
            else if (operationId)
                db.prepare(
                    "UPDATE project_deletions SET state='deleted' WHERE projectId=? AND operationId=?",
                ).run(binding.project, operationId);
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    function isProjectDeleting(projectId: string): boolean {
        return !!db
            .prepare(
                "SELECT 1 FROM project_deletions WHERE projectId=?1 AND state='deleting' UNION ALL SELECT 1 FROM task_source_deletion_items i JOIN task_source_deletions d USING(owner,spaceId,operationId) WHERE i.projectId=?1 AND d.state IN ('held','committing')",
            )
            .get(projectId);
    }

    function projectDeletionBlockers(
        project: Project,
    ): ProjectDeletionBlocker[] {
        const blockers: ProjectDeletionBlocker[] = [];
        if (project.status === 'importing') blockers.push('project_importing');
        if (
            inputDeletionHeld(project.id) ||
            pendingTaskRetry(project.id) ||
            db
                .prepare(
                    `SELECT 1 FROM runs WHERE projectId=? AND status IN ${pending}`,
                )
                .get(project.id) ||
            db
                .prepare(
                    "SELECT 1 FROM file_delete_holds WHERE projectId=? AND state='held'",
                )
                .get(project.id)
        )
            blockers.push('project_busy');
        return blockers;
    }

    function projectDeletionImpact(owner: string, projectId: string) {
        const project = ownedProject(owner, projectId);
        const { runCount, diffCount } = db
            .prepare(
                "SELECT count(*) AS runCount, count(CASE WHEN status='succeeded' AND diff IS NOT NULL THEN 1 END) AS diffCount FROM runs WHERE projectId=?",
            )
            .get(projectId) as { runCount: number; diffCount: number };
        return {
            runCount,
            diffCount,
            blockers: projectDeletionBlockers(project),
        };
    }

    function beginProjectDeletion(
        owner: string,
        projectId: string,
        operationId: string,
    ): ProjectDeletionReceipt {
        return write(() => {
            const prior = db
                .prepare(
                    'SELECT owner,state,code FROM project_deletions WHERE projectId=? AND operationId=?',
                )
                .get(projectId, operationId) as
                (ProjectDeletionReceipt & { owner: string }) | undefined;
            if (prior) {
                if (prior.owner !== owner) throw missing();
                return prior.state === 'denied'
                    ? { state: prior.state, code: prior.code }
                    : { state: prior.state };
            }
            const accepted = db
                .prepare(
                    "SELECT owner FROM project_deletions WHERE projectId=? AND state IN ('deleting','deleted')",
                )
                .get(projectId);
            if (accepted) {
                if (accepted.owner !== owner) throw missing();
                throw conflict(
                    'idempotency_conflict',
                    'Project already has a different deletion operation.',
                );
            }
            const project = ownedProject(owner, projectId);
            requireOpenOwner(owner);
            const [code] = isProjectDeleting(projectId)
                ? ['project_busy' as const]
                : projectDeletionBlockers(project);
            const state = code ? 'denied' : 'deleting';
            db.prepare('INSERT INTO project_deletions VALUES (?,?,?,?,?)').run(
                projectId,
                operationId,
                owner,
                state,
                code ?? null,
            );
            return code ? { state: 'denied', code } : { state: 'deleting' };
        });
    }

    function projectDeletionBinding(
        owner: string,
        projectId: string,
        operationId: string,
    ): Binding {
        if (
            !db
                .prepare(
                    "SELECT 1 FROM project_deletions WHERE owner=? AND projectId=? AND operationId=? AND state='deleting'",
                )
                .get(owner, projectId, operationId)
        )
            throw missing();
        return projectBinding(ownedProject(owner, projectId));
    }

    function hasProjectDeletionInProgress(owner: string): boolean {
        return !!db
            .prepare(
                "SELECT 1 FROM project_deletions WHERE owner=? AND state='deleting'",
            )
            .get(owner);
    }

    function clearProjectDeletionReceipts(owner: string): void {
        db.prepare('DELETE FROM project_deletions WHERE owner=?').run(owner);
    }

    function createProject(
        owner: string,
        name: string,
        files: FileText[],
        key?: string,
    ) {
        if (!key)
            return {
                replay: false,
                project: addProject(owner, name, files),
            };
        const digest = createHash('sha256')
            .update(JSON.stringify({ name, files }))
            .digest('hex');
        db.exec('BEGIN IMMEDIATE');
        try {
            const prior = db
                .prepare(
                    'SELECT digest, projectId FROM project_requests WHERE owner = ? AND key = ?',
                )
                .get(owner, key) as
                { digest: string; projectId: string } | undefined;
            if (prior && isProjectDeleting(prior.projectId)) throw missing();
            if (prior && prior.digest !== digest)
                throw conflict(
                    'idempotency_conflict',
                    'Idempotency-Key already belongs to a different input.',
                );
            const project = prior
                ? readProject(owner, prior.projectId)
                : addProject(owner, name, files);
            if (!prior)
                db.prepare('INSERT INTO project_requests VALUES (?,?,?,?)').run(
                    owner,
                    key,
                    digest,
                    project.id,
                );
            db.exec('COMMIT');
            return { replay: !!prior, project };
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    function addProject(
        owner: string,
        name: string,
        files: FileText[],
        id: string = randomUUID(),
    ) {
        requireOpenOwner(owner);
        const row: Project = {
            id,
            owner,
            name,
            status: 'importing',
            createdAt: now(),
            sessionId: randomUUID(),
            sandbox: 'b-' + randomBytes(8).toString('hex'),
            volume: 'bento-workspace-' + id,
            source: JSON.stringify(files),
        };
        db.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?)').run(
            row.id,
            row.owner,
            row.name,
            row.status,
            row.createdAt,
            row.sessionId,
            row.sandbox,
            row.volume,
            row.source,
        );
        return projectView(row);
    }

    function ownedProject(owner: string, id: string, allowTask = false) {
        const row = db
            .prepare('SELECT * FROM projects WHERE id=? AND owner=?')
            .get(id, owner);
        if (
            !row ||
            (!allowTask && db.prepare('SELECT 1 FROM tasks WHERE id=?').get(id))
        )
            throw missing();
        return row as Project;
    }

    function readProject(owner: string, id: string) {
        const project = ownedProject(owner, id);
        if (isProjectDeleting(id)) throw missing();
        return projectView(project);
    }

    function sharedProjectBinding(owner: string, id: string) {
        requireOpenOwner(owner);
        const project = ownedProject(owner, id);
        if (project.status !== 'ready' || isProjectDeleting(id))
            throw conflict('project_not_ready', 'Project is not ready.');
        return projectBinding(project);
    }

    function projects(owner: string) {
        return (
            db
                .prepare(
                    "SELECT p.* FROM projects p WHERE owner=? AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id=p.id) AND NOT EXISTS (SELECT 1 FROM project_deletions d WHERE d.projectId=p.id AND d.state='deleting') ORDER BY p.rowid",
                )
                .all(owner) as Project[]
        ).map(projectView);
    }

    function importing() {
        return db
            .prepare(
                "SELECT * FROM projects WHERE status='importing' ORDER BY rowid LIMIT 1",
            )
            .get() as Project | undefined;
    }

    function importResult(
        id: string,
        status: 'ready' | 'failed',
        reason: string | null = null,
    ) {
        write(() => {
            db.prepare(
                "UPDATE projects SET status=?, source=CASE WHEN EXISTS(SELECT 1 FROM tasks WHERE id=projects.id) THEN source ELSE NULL END WHERE id=? AND status='importing'",
            ).run(status, id);
            db.prepare(
                'UPDATE tasks SET prepareError=?,updatedAt=? WHERE id=?',
            ).run(reason, now(), id);
        });
    }

    function acquireFileDeleteHold(
        owner: string,
        projectId: string,
        operationId: string,
    ): FileDeleteHold {
        return write(() => {
            const project = ownedProject(owner, projectId);
            const prior = db
                .prepare(
                    'SELECT state FROM file_delete_holds WHERE projectId=? AND operationId=?',
                )
                .get(projectId, operationId) as FileDeleteHold | undefined;
            if (isProjectDeleting(projectId)) throw missing();
            if (prior) return prior;
            requireOpenOwner(owner);
            const busy = db
                .prepare(
                    `SELECT 1 FROM runs WHERE projectId=? AND status IN ${pending}`,
                )
                .get(projectId);
            const state =
                project.status === 'importing' || busy ? 'denied' : 'held';
            db.prepare(
                'INSERT INTO file_delete_holds (projectId,operationId,state) VALUES (?,?,?)',
            ).run(projectId, operationId, state);
            return { state };
        });
    }

    function releaseFileDeleteHold(
        owner: string,
        projectId: string,
        operationId: string,
    ): FileDeleteHold {
        return write(() => {
            ownedProject(owner, projectId);
            db.prepare(
                `
                INSERT INTO file_delete_holds (projectId,operationId,state) VALUES (?,?,'released')
                ON CONFLICT(projectId,operationId) DO UPDATE SET state='released'
            `,
            ).run(projectId, operationId);
            return { state: 'released' };
        });
    }

    return {
        projectRunIds,
        purgeProject,
        isProjectDeleting,
        projectDeletionBlockers,
        projectDeletionImpact,
        beginProjectDeletion,
        projectDeletionBinding,
        hasProjectDeletionInProgress,
        clearProjectDeletionReceipts,
        createProject,
        addProject,
        ownedProject,
        project: readProject,
        sharedProjectBinding,
        projects,
        importing,
        importResult,
        acquireFileDeleteHold,
        releaseFileDeleteHold,
    };
}
