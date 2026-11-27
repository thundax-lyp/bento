import type { DatabaseSync } from 'node:sqlite';
import { conflict, missing } from '../input.ts';
import {
    type Project,
    type InputHoldState,
    type SourceDeletionState,
    idempotencyConflict,
    projectBinding,
} from './model.ts';
import type { ProjectDeletionBlocker } from './index.ts';

export function taskSourceDeletionStore({
    db,
    write,
    requireOpenOwner,
    ownedProject,
    isProjectDeleting,
    pendingTaskRetry,
    projectDeletionBlockers,
    projectHasPendingRun,
}: {
    db: DatabaseSync;
    write: <T>(action: () => T) => T;
    requireOpenOwner: (owner: string) => void;
    ownedProject: (owner: string, id: string, allowTask?: boolean) => Project;
    isProjectDeleting: (id: string) => boolean;
    pendingTaskRetry: (id: string) => boolean;
    projectDeletionBlockers: (project: Project) => ProjectDeletionBlocker[];
    projectHasPendingRun: (id: string) => boolean;
}) {
    function sourceDeletion(owner: string, spaceId: string) {
        return db
            .prepare(
                "SELECT state FROM task_source_deletions WHERE owner=? AND spaceId=? AND state IN ('held','committing','deleted')",
            )
            .get(owner, spaceId)?.state;
    }

    function acquireTaskInputDeleteHold(
        owner: string,
        spaceId: string,
        fileId: string,
        operationId: string,
        legacyProjectId: string | null,
    ) {
        return write(() =>
            changeInputDeleteHold(
                owner,
                spaceId,
                fileId,
                operationId,
                legacyProjectId,
                false,
            ),
        );
    }

    function releaseTaskInputDeleteHold(
        owner: string,
        spaceId: string,
        fileId: string,
        operationId: string,
        legacyProjectId: string | null,
    ) {
        return write(() =>
            changeInputDeleteHold(
                owner,
                spaceId,
                fileId,
                operationId,
                legacyProjectId,
                true,
            ),
        );
    }

    function changeInputDeleteHold(
        owner: string,
        spaceId: string,
        fileId: string,
        operationId: string,
        legacyProjectId: string | null,
        release: boolean,
    ) {
        const prior = db
            .prepare(
                'SELECT legacyProjectId,state FROM task_input_delete_holds WHERE owner=? AND spaceId=? AND fileId=? AND operationId=?',
            )
            .get(owner, spaceId, fileId, operationId) as
            | { legacyProjectId: string | null; state: InputHoldState }
            | undefined;
        if (prior) {
            if (prior.legacyProjectId !== legacyProjectId)
                throw idempotencyConflict();
            if (!release) return { state: prior.state };
            if (prior.state === 'held')
                db.prepare(
                    "UPDATE task_input_delete_holds SET state='released' WHERE owner=? AND spaceId=? AND fileId=? AND operationId=?",
                ).run(owner, spaceId, fileId, operationId);
            return { state: 'released' as const };
        }
        const sourceState = sourceDeletion(owner, spaceId);
        if (sourceState === 'deleted') throw missing();
        let state: InputHoldState = 'released';
        if (!release) {
            if (sourceState) state = 'denied';
            else {
                requireOpenOwner(owner);
                const legacy =
                    legacyProjectId === null
                        ? undefined
                        : ownedProject(owner, legacyProjectId);
                const tasks = db
                    .prepare(
                        'SELECT p.* FROM projects p JOIN tasks t ON t.id=p.id JOIN task_input_refs r ON r.taskId=t.id WHERE t.owner=? AND t.sourceSpaceId=? AND r.fileId=?',
                    )
                    .all(owner, spaceId, fileId) as Project[];
                if (legacy) tasks.push(legacy);
                state = tasks.some(
                    (project) =>
                        project.status === 'importing' ||
                        projectHasPendingRun(project.id) ||
                        pendingTaskRetry(project.id) ||
                        isProjectDeleting(project.id) ||
                        (legacy?.id === project.id &&
                            projectDeletionBlockers(project).length > 0),
                )
                    ? 'denied'
                    : 'held';
            }
        }
        db.prepare(
            'INSERT INTO task_input_delete_holds VALUES (?,?,?,?,?,?)',
        ).run(owner, spaceId, fileId, operationId, legacyProjectId, state);
        return { state };
    }

    function changeTaskSourceDeletion(
        owner: string,
        spaceId: string,
        operationId: string,
        legacyProjectId: string | null,
        phase: 'hold' | 'commit' | 'release',
    ) {
        return write(() => {
            const prior = db
                .prepare(
                    'SELECT legacyProjectId,state,code FROM task_source_deletions WHERE owner=? AND spaceId=? AND operationId=?',
                )
                .get(owner, spaceId, operationId) as
                | {
                      legacyProjectId: string | null;
                      state: SourceDeletionState;
                      code: string | null;
                  }
                | undefined;
            if (prior && prior.legacyProjectId !== legacyProjectId)
                throw idempotencyConflict();
            if (phase === 'release') {
                if (prior?.state === 'committing' || prior?.state === 'deleted')
                    throw conflict(
                        'deletion_committed',
                        'Deletion already committed.',
                    );
                if (!prior)
                    db.prepare(
                        "INSERT INTO task_source_deletions VALUES (?,?,?,?,'released',NULL)",
                    ).run(owner, spaceId, operationId, legacyProjectId);
                if (prior?.state === 'held')
                    db.prepare(
                        "UPDATE task_source_deletions SET state='released' WHERE owner=? AND spaceId=? AND operationId=?",
                    ).run(owner, spaceId, operationId);
                return { state: 'released' as const, code: null };
            }
            if (phase === 'commit') {
                if (!prior || prior.state === 'released')
                    throw conflict(
                        'deletion_not_held',
                        'Deletion is not held.',
                    );
                if (prior.state !== 'held') return prior;
                db.prepare(
                    "UPDATE task_source_deletions SET state='committing' WHERE owner=? AND spaceId=? AND operationId=?",
                ).run(owner, spaceId, operationId);
                return { state: 'committing' as const, code: null };
            }
            if (prior?.state === 'released')
                throw conflict('deletion_released', 'Deletion was released.');
            if (prior) return prior;
            if (sourceDeletion(owner, spaceId)) throw idempotencyConflict();
            const projects = db
                .prepare(
                    'SELECT p.* FROM projects p JOIN tasks t ON t.id=p.id WHERE t.owner=? AND t.sourceSpaceId=?',
                )
                .all(owner, spaceId) as Project[];
            if (legacyProjectId !== null)
                projects.push(ownedProject(owner, legacyProjectId));
            const blocked = projects.flatMap((project) =>
                projectDeletionBlockers(project),
            );
            const code = blocked.includes('project_importing')
                ? 'project_importing'
                : blocked.length ||
                    projects.some((project) => isProjectDeleting(project.id)) ||
                    db
                        .prepare(
                            "SELECT 1 FROM task_input_delete_holds WHERE owner=? AND spaceId=? AND state='held'",
                        )
                        .get(owner, spaceId)
                  ? 'project_busy'
                  : db
                          .prepare(
                              'SELECT 1 FROM draining_owners WHERE owner=?',
                          )
                          .get(owner)
                    ? 'owner_closed'
                    : null;
            const state = code ? 'denied' : 'held';
            db.prepare(
                'INSERT INTO task_source_deletions VALUES (?,?,?,?,?,?)',
            ).run(owner, spaceId, operationId, legacyProjectId, state, code);
            if (!code)
                for (const project of projects)
                    db.prepare(
                        'INSERT INTO task_source_deletion_items VALUES (?,?,?,?,0)',
                    ).run(owner, spaceId, operationId, project.id);
            return { state, code };
        });
    }

    function taskSourceDeletionBindings(
        owner: string,
        spaceId: string,
        operationId: string,
    ) {
        return (
            db
                .prepare(
                    `SELECT p.* FROM task_source_deletion_items i
            JOIN task_source_deletions d USING(owner,spaceId,operationId)
            JOIN projects p ON p.id=i.projectId
            WHERE i.owner=? AND i.spaceId=? AND i.operationId=? AND d.state='committing' AND i.cleaned=0
            ORDER BY p.id`,
                )
                .all(owner, spaceId, operationId) as Project[]
        ).map(projectBinding);
    }

    function finishTaskSourceDeletion(
        owner: string,
        spaceId: string,
        operationId: string,
    ) {
        db.prepare(
            `UPDATE task_source_deletions SET state='deleted'
            WHERE owner=? AND spaceId=? AND operationId=? AND state='committing'
              AND NOT EXISTS(SELECT 1 FROM task_source_deletion_items i
                WHERE i.owner=? AND i.spaceId=? AND i.operationId=? AND i.cleaned=0)`,
        ).run(owner, spaceId, operationId, owner, spaceId, operationId);
        return (
            db
                .prepare(
                    'SELECT state FROM task_source_deletions WHERE owner=? AND spaceId=? AND operationId=?',
                )
                .get(owner, spaceId, operationId)?.state === 'deleted'
        );
    }

    function taskSourceImpact(
        owner: string,
        spaceId: string,
        legacyProjectId: string | null,
    ) {
        const projects = db
            .prepare(
                'SELECT p.* FROM projects p JOIN tasks t ON p.id=t.id WHERE t.owner=? AND t.sourceSpaceId=?',
            )
            .all(owner, spaceId) as Project[];
        if (legacyProjectId !== null)
            projects.push(ownedProject(owner, legacyProjectId));
        let runCount = 0;
        let diffCount = 0;
        const blockers = new Set<ProjectDeletionBlocker>();
        for (const project of projects) {
            const impact = db
                .prepare(
                    "SELECT count(*) AS runCount,count(CASE WHEN status='succeeded' AND diff IS NOT NULL THEN 1 END) AS diffCount FROM runs WHERE projectId=?",
                )
                .get(project.id) as { runCount: number; diffCount: number };
            runCount += impact.runCount;
            diffCount += impact.diffCount;
            for (const blocker of projectDeletionBlockers(project))
                blockers.add(blocker);
        }
        if (
            db
                .prepare(
                    "SELECT 1 FROM task_input_delete_holds WHERE owner=? AND spaceId=? AND state='held'",
                )
                .get(owner, spaceId)
        )
            blockers.add('project_busy');
        return { runCount, diffCount, blockers: [...blockers] };
    }

    return {
        sourceDeletion,
        acquireTaskInputDeleteHold,
        releaseTaskInputDeleteHold,
        changeTaskSourceDeletion,
        taskSourceDeletionBindings,
        finishTaskSourceDeletion,
        taskSourceImpact,
    };
}
