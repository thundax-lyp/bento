import type { goSpaceUpload } from './index.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { SnapshotIssue as Issue } from './execution.ts';
import type { DatabaseSync } from 'node:sqlite';
import {
    snapshotPathParts,
    maxSnapshotBytes,
    maxSnapshotFiles,
} from '@/shared/text-snapshot.ts';
import { notFound, projectInput, RequestError } from '../protocol.ts';
import type {
    Backend,
    FrozenTaskInput,
    ProjectInput,
    Result,
    TaskSource,
} from '../protocol.ts';
import { spaceObjectKey } from './storage.ts';

type Input = { fileId: string; path: string; size: number; manifest: string };
type TaskIntent = {
    id: string;
    owner: string;
    spaceId: string;
    key: string;
    hash: string;
    name: string;
    fileIds: string;
    state: 'pinned' | 'frozen' | 'submitted' | 'ready' | 'failed' | 'abandoned';
    canonicalBody: string | null;
    lastError: string | null;
};

export function spaceTaskInputs({
    db,
    backend,
    readFile,
    requireWritableProject,
    transaction,
    fileDeletionPending,
    project,
    files,
    draining,
    confirmedDraining,
    goUpload,
}: {
    db: DatabaseSync;
    backend: Backend;
    readFile: (key: string, size: number) => Promise<Buffer>;
    requireWritableProject: (owner: string, spaceId: string) => void;
    fileDeletionPending: (fileId: string) => boolean;
    transaction: <T>(change: () => T) => T;
    project: (owner: string, spaceId: string) => { id: string; name: string };
    files: (owner: string, spaceId: string) => Input[];
    draining: ReadonlySet<string>;
    confirmedDraining: ReadonlySet<string>;
    goUpload?: typeof goSpaceUpload;
}) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS space_tasks (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL, spaceId TEXT NOT NULL,
            key TEXT NOT NULL, hash TEXT NOT NULL, name TEXT NOT NULL, fileIds TEXT NOT NULL,
            state TEXT NOT NULL,canonicalBody TEXT,lastError TEXT,UNIQUE(owner,key)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS space_task_inputs (
            taskId TEXT NOT NULL,fileId TEXT NOT NULL,readPinned INTEGER NOT NULL CHECK(readPinned IN (0,1)),
            PRIMARY KEY(taskId,fileId)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS space_task_file_pins ON space_task_inputs(fileId,readPinned);
    `);
    function taskIntent(owner: string, key: string) {
        return db
            .prepare('SELECT * FROM space_tasks WHERE owner=? AND key=?')
            .get(owner, key) as TaskIntent | undefined;
    }

    function changeTaskState(
        row: TaskIntent,
        state: TaskIntent['state'],
        error: string | null = null,
    ) {
        transaction(() => {
            db.prepare(
                'UPDATE space_tasks SET state=?,lastError=? WHERE id=?',
            ).run(state, error, row.id);
            if (
                state === 'ready' ||
                state === 'abandoned' ||
                (state === 'failed' && row.canonicalBody === null)
            )
                db.prepare(
                    'UPDATE space_task_inputs SET readPinned=0 WHERE taskId=?',
                ).run(row.id);
        });
    }

    function hasTaskPin(fileId: string) {
        return !!db
            .prepare(
                'SELECT 1 FROM space_task_inputs WHERE fileId=? AND readPinned=1',
            )
            .get(fileId);
    }

    function taskFiles(owner: string, spaceId: string, fileIds: string[]) {
        const available = files(owner, spaceId);
        const selected = fileIds.map((id) =>
            available.find((file) => file.fileId === id),
        );
        if (selected.some((file) => !file || fileDeletionPending(file.fileId)))
            throw notFound();
        const input = selected as Input[];
        if (input.length > maxSnapshotFiles)
            throw new RequestError(
                413,
                'too_large',
                '任务快照最多 100 个文件。',
            );
        if (
            input.reduce((sum, file) => sum + file.size, 0) > maxSnapshotBytes
        ) {
            const oversized = input
                .filter(({ size }) => size > maxSnapshotBytes)
                .map(({ fileId, path }) => ({
                    fileId,
                    path,
                    code: 'too_large',
                }));
            throw new RequestError(
                413,
                'too_large',
                '任务快照的文本总量不能超过 1 MiB。',
                oversized.length ? oversized : undefined,
            );
        }
        return input;
    }

    async function enrollTask(
        owner: string,
        key: string,
        name: string,
        source: Extract<TaskSource, { kind: 'space_snapshot' }>,
    ) {
        if (goUpload) {
            await goUpload('enroll-snapshot', { owner, key, name, source });
            return taskIntent(owner, key)!;
        }
        const canonical = { name, source };
        const hash = createHash('sha256')
            .update(JSON.stringify(canonical))
            .digest('hex');
        return transaction(() => {
            const prior = taskIntent(owner, key);
            if (prior) {
                if (prior.hash !== hash)
                    throw new RequestError(
                        409,
                        'idempotency_conflict',
                        '提交键已用于其他输入。',
                    );
                return prior;
            }
            requireWritableProject(owner, source.spaceId);
            project(owner, source.spaceId);
            const input = taskFiles(owner, source.spaceId, source.fileIds);
            const id = randomUUID();
            db.prepare(
                "INSERT INTO space_tasks VALUES (?,?,?,?,?,?,?,'pinned',NULL,NULL)",
            ).run(
                id,
                owner,
                source.spaceId,
                key,
                hash,
                name,
                JSON.stringify(source.fileIds),
            );
            const pin = db.prepare(
                'INSERT INTO space_task_inputs VALUES (?,?,1)',
            );
            for (const file of input) pin.run(id, file.fileId);
            return taskIntent(owner, key)!;
        });
    }

    async function freezeTask(row: TaskIntent) {
        if (goUpload) {
            await goUpload('freeze-snapshot', { owner: row.owner, id: row.id });
            return;
        }
        const selected = taskFiles(
            row.owner,
            row.spaceId,
            JSON.parse(row.fileIds) as string[],
        );
        const issues: Issue[] = [];
        const inputFiles: ProjectInput['files'] = [];
        const inputManifest: FrozenTaskInput['inputManifest'] = [];
        for (const { fileId, path, size, manifest } of selected) {
            if (!snapshotPathParts(path)) {
                issues.push({ fileId, path, code: 'invalid_path' });
                continue;
            }
            const bytes = await readFile(spaceObjectKey(fileId), size);
            const digest = createHash('sha256').update(bytes);
            if (
                bytes.length !== size ||
                (size > 0 &&
                    digest.copy().digest('base64') !==
                        (JSON.parse(manifest) as string[])[0])
            )
                throw new Error('Saved file checksum mismatch');
            let text: string;
            try {
                text = new TextDecoder('utf-8', {
                    fatal: true,
                    ignoreBOM: true,
                }).decode(bytes);
            } catch {
                issues.push({ fileId, path, code: 'invalid_utf8' });
                continue;
            }
            inputFiles.push({ path, text });
            inputManifest.push({
                fileId,
                path,
                bytes: size,
                sha256: digest.digest('hex'),
            });
        }
        if (issues.length)
            throw new RequestError(
                400,
                'invalid_input',
                '请调整所选文件后重试。',
                issues,
            );
        const normalized = projectInput({ name: row.name, files: inputFiles });
        normalized.files.sort((a, b) =>
            a.path < b.path ? -1 : a.path === b.path ? 0 : 1,
        );
        const input: FrozenTaskInput = {
            id: row.id,
            name: row.name,
            sourceSpaceId: row.spaceId,
            inputFiles: normalized.files,
            inputManifest,
            inputDigest: createHash('sha256')
                .update(JSON.stringify(normalized.files))
                .digest('hex'),
        };
        db.prepare(
            "UPDATE space_tasks SET state='frozen',canonicalBody=? WHERE id=? AND state='pinned'",
        ).run(JSON.stringify(input), row.id);
    }

    function verifyTaskReceipt(
        row: TaskIntent,
        input: FrozenTaskInput,
        result: Result,
    ) {
        if (!('json' in result) || !('task' in result.json))
            throw new Error('Missing Task receipt');
        const task = result.json.task;
        if (
            task.id !== row.id ||
            task.sourceSpaceId !== row.spaceId ||
            task.inputDigest !== input.inputDigest
        )
            throw new Error('Task receipt does not match the input');
        if (task.status === 'ready') changeTaskState(row, 'ready');
        if (task.status === 'failed') changeTaskState(row, 'failed');
        return result;
    }

    async function advanceTask(row: TaskIntent): Promise<Result | undefined> {
        if (row.state === 'abandoned')
            throw new RequestError(
                409,
                row.lastError ?? 'owner_closed',
                '原任务提交无法继续。',
            );
        if (
            draining.has(row.owner) &&
            row.state !== 'ready' &&
            row.state !== 'failed'
        ) {
            if (row.state === 'pinned' || row.state === 'frozen') {
                changeTaskState(row, 'abandoned');
                return undefined;
            }
            if (!confirmedDraining.has(row.owner)) return undefined;
            const receipt = await backend(row.owner, {
                kind: 'taskCreationReceipt',
                key: row.key,
            });
            const original =
                'json' in receipt && 'items' in receipt.json
                    ? receipt.json.items[0]
                    : undefined;
            const input = JSON.parse(row.canonicalBody!) as FrozenTaskInput;
            if (original) {
                if (
                    !('inputDigest' in original) ||
                    original.id !== row.id ||
                    original.inputDigest !== input.inputDigest
                )
                    throw new Error('Task creation receipt changed');
                // Orchestrator already owns this input; owner purge now waits on its state.
                if (original.status === 'ready' || original.status === 'failed')
                    changeTaskState(row, original.status);
                else
                    db.prepare(
                        "UPDATE space_tasks SET lastError='owner_closed' WHERE id=?",
                    ).run(row.id);
                return undefined;
            }
        }
        if (row.state === 'pinned') {
            try {
                await freezeTask(row);
            } catch (error) {
                if (
                    error instanceof RequestError &&
                    (error.status === 400 ||
                        error.status === 404 ||
                        error.status === 413)
                )
                    changeTaskState(row, 'failed', error.code);
                throw error;
            }
            row = taskIntent(row.owner, row.key)!;
        }
        if (!row.canonicalBody)
            throw new RequestError(
                400,
                row.lastError ?? 'invalid_input',
                '所选文件无法用于任务。',
            );
        const input = JSON.parse(row.canonicalBody) as FrozenTaskInput;
        if (row.state === 'frozen' && draining.has(row.owner)) {
            changeTaskState(row, 'abandoned');
            return undefined;
        }
        if (!goUpload && row.state === 'frozen')
            db.prepare(
                "UPDATE space_tasks SET state='submitted' WHERE id=?",
            ).run(row.id);
        try {
            if (goUpload)
                return await goUpload<Result>('submit-snapshot', {
                    owner: row.owner,
                    id: row.id,
                });
            return verifyTaskReceipt(
                row,
                input,
                await backend(row.owner, {
                    kind: 'createTask',
                    key: row.key,
                    input,
                }),
            );
        } catch (error) {
            if (
                error instanceof RequestError &&
                (error.code === 'owner_closed' ||
                    error.code === 'idempotency_conflict')
            )
                changeTaskState(row, 'abandoned', error.code);
            throw error;
        }
    }

    const taskAdvances = new Map<string, Promise<Result | undefined>>();
    function reconcileTask(row: TaskIntent) {
        const prior = taskAdvances.get(row.id);
        if (prior) return prior;
        const task = advanceTask(row).finally(() =>
            taskAdvances.delete(row.id),
        );
        taskAdvances.set(row.id, task);
        return task;
    }

    async function createTask(
        owner: string,
        key: string,
        name: string,
        source: Extract<TaskSource, { kind: 'space_snapshot' }>,
    ) {
        const row = await enrollTask(owner, key, name, source);
        const result = await reconcileTask(row);
        if (!result)
            throw new RequestError(409, 'owner_closed', '账号已注销。');
        return result;
    }

    async function settleProjectTasks(owner: string, spaceId: string) {
        const rows = db
            .prepare(
                "SELECT * FROM space_tasks WHERE owner=? AND spaceId=? AND state IN ('pinned','frozen','submitted') AND lastError IS NOT 'owner_closed'",
            )
            .all(owner, spaceId) as TaskIntent[];
        for (const row of rows) {
            const result = await reconcileTask(row);
            if (
                !result &&
                taskIntent(row.owner, row.key)?.state !== 'abandoned'
            )
                return false;
        }
        return true;
    }

    function purgeTaskIntents(owner: string, spaceId?: string) {
        const filter =
            spaceId === undefined ? 'owner=?' : 'owner=? AND spaceId=?';
        const params = spaceId === undefined ? [owner] : [owner, spaceId];
        db.prepare(
            'DELETE FROM space_task_inputs WHERE taskId IN (SELECT id FROM space_tasks WHERE ' +
                filter +
                ')',
        ).run(...params);
        db.prepare('DELETE FROM space_tasks WHERE ' + filter).run(...params);
    }

    async function advancePendingTasks(isClosing: () => boolean) {
        const tasks = db
            .prepare(
                `SELECT * FROM space_tasks WHERE
                    (state IN ('pinned','frozen','submitted') AND lastError IS NOT 'owner_closed')
                    OR (state='failed' AND canonicalBody IS NOT NULL)`,
            )
            .all() as TaskIntent[];
        for (const row of tasks) {
            if (isClosing()) return;
            if (row.state === 'failed' && draining.has(row.owner)) continue;
            await reconcileTask(row).catch(() => undefined);
        }
    }

    return {
        createTask,
        hasTaskPin,
        settleProjectTasks,
        purgeTaskIntents,
        advancePendingTasks,
        async close() {
            await Promise.allSettled(taskAdvances.values());
        },
    };
}
