import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { conflict, invalid, missing, textSnapshot } from '../input.ts';
import {
    type Project,
    type Run,
    type Task,
    type TaskInput,
    type TaskInputFile,
    type RetryAttempt,
    busyProject,
    hashJson,
    idempotencyConflict,
    now,
    sha256,
} from './model.ts';
import type { taskProjectionStore } from './task-projection.ts';
import type { taskSourceDeletionStore } from './task-source-deletion.ts';
import type { FileText } from '../types.ts';

export function taskStore({
    db,
    write,
    goControl,
    ownedProject,
    isProjectDeleting,
    requireOpenOwner,
    sourceDeletion,
    addProject,
    inputDeletionHeld,
    projectHasPendingRun,
    pendingTaskRetry,
    taskRetryReceipt,
    findRun,
    enqueueRun,
    appendTaskEvent,
}: {
    db: DatabaseSync;
    write: <T>(action: () => T) => T;
    goControl: string | undefined;
    ownedProject: (owner: string, id: string, allowTask?: boolean) => Project;
    isProjectDeleting: (id: string) => boolean;
    requireOpenOwner: (owner: string) => void;
    sourceDeletion: ReturnType<
        typeof taskSourceDeletionStore
    >['sourceDeletion'];
    addProject: (
        owner: string,
        name: string,
        files: FileText[],
        id?: string,
    ) => { id: string; createdAt: string };
    inputDeletionHeld: (id: string) => boolean;
    projectHasPendingRun: (id: string) => boolean;
    pendingTaskRetry: (id: string) => boolean;
    taskRetryReceipt: (id: string, key: string) => RetryAttempt | undefined;
    findRun: (id: string) => Run;
    enqueueRun: (
        owner: string,
        taskId: string,
        key: string,
        prompt: string,
        task: true,
    ) => { run: { id: string } };
    appendTaskEvent: ReturnType<typeof taskProjectionStore>['appendTaskEvent'];
}) {
    function taskRow(owner: string, taskId: string) {
        const row = db
            .prepare('SELECT * FROM tasks WHERE id=? AND owner=?')
            .get(taskId, owner) as Task | undefined;
        if (!row) throw missing();
        return row;
    }

    function readTask(owner: string, taskId: string) {
        const task = taskRow(owner, taskId);
        const project = ownedProject(owner, taskId, true);
        const deleting = isProjectDeleting(taskId);
        const attempt = db
            .prepare(
                "SELECT id FROM retry_attempts WHERE taskId=? AND phase='blocked'",
            )
            .get(taskId);
        return {
            id: task.id,
            name: task.name,
            sourceSpaceId: task.sourceSpaceId,
            inputDigest: task.inputDigest,
            environmentVersion: task.environmentVersion,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            prepareError: task.prepareError,
            closedReason: task.closedReason,
            status: deleting
                ? 'deleting'
                : project.status === 'importing'
                  ? 'preparing'
                  : project.status,
            inputs: JSON.parse(task.inputManifest) as TaskInputFile[],
            reconciliation: attempt
                ? {
                      attemptId: attempt.id as string,
                      state: 'blocked',
                      reason: 'restore_conflict',
                  }
                : null,
        };
    }

    function tasks(owner: string, creationKey?: string) {
        const ids =
            creationKey === undefined
                ? db
                      .prepare(
                          'SELECT id FROM tasks WHERE owner=? ORDER BY createdAt,id',
                      )
                      .all(owner)
                : db
                      .prepare(
                          'SELECT taskId AS id FROM task_creation_receipts WHERE owner=? AND key=?',
                      )
                      .all(owner, creationKey);
        return ids.map((row) => readTask(owner, row.id as string));
    }

    function createTask(
        owner: string,
        key: string,
        input: TaskInput,
        environmentVersion: string,
    ) {
        const files = textSnapshot(input.inputFiles);
        const manifest = [...input.inputManifest]
            .sort((a, b) =>
                a.fileId < b.fileId ? -1 : a.fileId === b.fileId ? 0 : 1,
            )
            .map(({ fileId, path, bytes, sha256 }) => ({
                fileId,
                path,
                bytes,
                sha256,
            }));
        const digest = hashJson(files);
        if (
            input.inputDigest !== digest ||
            manifest.length !== files.length ||
            new Set(manifest.map((file) => file.fileId)).size !==
                manifest.length ||
            new Set(manifest.map((file) => file.path)).size !==
                manifest.length ||
            (input.sourceSpaceId === null
                ? input.id !== null || files.length !== 0
                : input.id === null || files.length === 0)
        )
            throw invalid('Invalid frozen input.');
        for (const entry of manifest) {
            const file = files.find((item) => item.path === entry.path);
            if (
                !file ||
                Buffer.byteLength(file.text) !== entry.bytes ||
                sha256(file.text) !== entry.sha256
            )
                throw invalid('Invalid file manifest.');
        }
        const hash = hashJson({
            name: input.name,
            sourceSpaceId: input.sourceSpaceId,
            inputManifest: manifest,
            inputDigest: digest,
        });
        return write(() => {
            const prior = db
                .prepare(
                    'SELECT taskId,hash FROM task_creation_receipts WHERE owner=? AND key=?',
                )
                .get(owner, key);
            if (prior) {
                if (prior.hash !== hash) throw idempotencyConflict();
                return {
                    replay: true,
                    task: readTask(owner, prior.taskId as string),
                };
            }
            requireOpenOwner(owner);
            if (input.sourceSpaceId !== null) {
                const state = sourceDeletion(owner, input.sourceSpaceId);
                if (state === 'deleted') throw missing();
                if (state) throw busyProject();
                for (const entry of manifest)
                    if (
                        db
                            .prepare(
                                "SELECT 1 FROM task_input_delete_holds WHERE owner=? AND spaceId=? AND fileId=? AND state='held'",
                            )
                            .get(owner, input.sourceSpaceId, entry.fileId)
                    )
                        throw busyProject();
            }
            const project = addProject(
                owner,
                input.name,
                files,
                input.id ?? randomUUID(),
            );
            db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
                project.id,
                owner,
                input.name,
                input.sourceSpaceId,
                digest,
                environmentVersion,
                project.createdAt,
                project.createdAt,
                null,
                null,
                JSON.stringify(manifest),
            );
            db.prepare(
                'INSERT INTO task_creation_receipts VALUES (?,?,?,?)',
            ).run(owner, key, project.id, hash);
            for (const entry of manifest)
                db.prepare('INSERT INTO task_input_refs VALUES (?,?)').run(
                    project.id,
                    entry.fileId,
                );
            return { replay: false, task: readTask(owner, project.id) };
        });
    }

    function taskWriteGuard(owner: string, task: Task) {
        requireOpenOwner(owner);
        if (isProjectDeleting(task.id) || inputDeletionHeld(task.id))
            throw busyProject();
        if (
            task.closedReason !== null ||
            ownedProject(owner, task.id, true).status !== 'ready'
        )
            throw conflict('task_not_ready', 'Task is not ready.');
        if (projectHasPendingRun(task.id) || pendingTaskRetry(task.id))
            throw conflict('task_busy', 'Task already has an unfinished Run.');
    }

    function taskSequence(taskId: string) {
        return db
            .prepare(
                'SELECT COALESCE(MAX(taskSequence),0)+1 AS value FROM runs WHERE projectId=?',
            )
            .get(taskId)?.value as number;
    }

    function enqueueTaskRun(
        owner: string,
        taskId: string,
        key: string,
        prompt: string,
    ) {
        const enqueue = () => {
            const task = taskRow(owner, taskId);
            if (taskRetryReceipt(taskId, key)) throw idempotencyConflict();
            const prior = db
                .prepare('SELECT * FROM runs WHERE projectId=? AND key=?')
                .get(taskId, key) as Run | undefined;
            if (prior) {
                if (prior.prompt !== prompt || prior.retryOf !== null)
                    throw idempotencyConflict();
                return { replay: true, run: prior };
            }
            taskWriteGuard(owner, task);
            const latest = db
                .prepare(
                    'SELECT * FROM runs WHERE projectId=? ORDER BY taskSequence DESC LIMIT 1',
                )
                .get(taskId) as Run | undefined;
            if (
                latest &&
                latest.status !== 'succeeded' &&
                !(
                    latest.status === 'cancelled' &&
                    latest.admittedGeneration === null
                )
            )
                throw conflict(
                    'task_not_ready',
                    'The last Run cannot be continued.',
                );
            const created = enqueueRun(owner, taskId, key, prompt, true);
            const id = created.run.id;
            if (goControl) return { replay: false, run: findRun(id) };
            db.prepare('UPDATE runs SET taskSequence=? WHERE id=?').run(
                taskSequence(taskId),
                id,
            );
            appendTaskEvent(taskId, id, id + ':user', {
                kind: 'user_message',
                text: prompt,
                check: null,
            });
            return { replay: false, run: findRun(id) };
        };
        return goControl ? enqueue() : write(enqueue);
    }

    function taskConfig(taskId: string) {
        return db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as
            Task | undefined;
    }

    function prepareTask(owner: string, id: string) {
        return write(() => {
            const task = taskRow(owner, id);
            requireOpenOwner(owner);
            if (
                task.closedReason ||
                isProjectDeleting(id) ||
                inputDeletionHeld(id)
            )
                throw conflict('task_not_ready', 'Task cannot be prepared.');
            const changed = db
                .prepare(
                    "UPDATE projects SET status='importing' WHERE id=? AND status='failed'",
                )
                .run(id).changes;
            if (changed)
                db.prepare(
                    'UPDATE tasks SET prepareError=NULL,updatedAt=? WHERE id=?',
                ).run(now(), id);
            return readTask(owner, id);
        });
    }

    function taskInitialFiles(taskId: string) {
        const row = db
            .prepare('SELECT source FROM projects WHERE id=?')
            .get(taskId);
        return textSnapshot(
            JSON.parse((row?.source as string | null) ?? 'null'),
        );
    }

    function taskRunRows(owner: string, id: string) {
        taskRow(owner, id);
        return db
            .prepare(
                'SELECT * FROM runs WHERE projectId=? ORDER BY taskSequence',
            )
            .all(id) as Run[];
    }

    function taskRunRow(owner: string, id: string, runId: string) {
        taskRow(owner, id);
        const run = findRun(runId);
        if (run.projectId !== id) throw missing();
        return run;
    }

    return {
        taskRow,
        task: readTask,
        tasks,
        createTask,
        taskWriteGuard,
        taskSequence,
        enqueueTaskRun,
        taskConfig,
        prepareTask,
        taskInitialFiles,
        taskRunRows,
        taskRunRow,
    };
}
