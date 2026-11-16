import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
    snapshotPathParts,
    maxSnapshotBytes,
    maxSnapshotFiles,
} from '@/shared/text-snapshot.ts';
import { notFound, object, projectInput, RequestError } from './protocol.ts';
import type {
    Backend,
    FrozenTaskInput,
    ProjectInput,
    Result,
    TaskSource,
} from './protocol.ts';
import { spaceObjectKey } from './space-storage.ts';

type Input = { fileId: string; path: string; size: number; manifest: string };
type Issue = {
    fileId: string;
    path: string;
    code: 'invalid_path' | 'invalid_utf8';
};
type Init = {
    spaceId: string;
    owner: string;
    key: string;
    state: 'validating' | 'importing' | 'ready' | 'failed';
    inputs: string;
    projectId: string | null;
    snapshot: string | null;
    issues: string | null;
};

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

export function spaceExecution(
    db: DatabaseSync,
    backend: Backend,
    readFile: (key: string, size: number) => Promise<Buffer>,
    requireWritableProject: (owner: string, spaceId: string) => void,
) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS space_execution (
            spaceId TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL,
            state TEXT NOT NULL, inputs TEXT NOT NULL, projectId TEXT, snapshot TEXT, issues TEXT,
            PRIMARY KEY(spaceId, key)
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS one_space_execution
            ON space_execution(spaceId) WHERE state <> 'failed' OR projectId IS NOT NULL;
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
    let advancing: Promise<void> | undefined;
    let closing = false;
    let activeOwner: string | undefined;
    const draining = new Set<string>();
    const confirmedDraining = new Set<string>();

    function project(owner: string, spaceId: string) {
        const row = db
            .prepare(
                'SELECT id,name FROM space_projects WHERE id = ? AND owner = ?',
            )
            .get(spaceId, owner) as { id: string; name: string } | undefined;
        if (!row) throw notFound();
        return row;
    }

    function files(owner: string, spaceId: string) {
        return db
            .prepare(
                `
            SELECT id AS fileId,path,size,manifest FROM space_uploads
            WHERE owner = ? AND project = ? AND state = 'saved' ORDER BY id
        `,
            )
            .all(owner, spaceId) as Input[];
    }

    function current(spaceId: string) {
        return db
            .prepare(
                'SELECT * FROM space_execution WHERE spaceId = ? ORDER BY rowid DESC LIMIT 1',
            )
            .get(spaceId) as Init | undefined;
    }

    const savedInput = db.prepare(
        "SELECT 1 FROM space_uploads WHERE owner=? AND project=? AND id=? AND state='saved'",
    );
    function view(row: Init | undefined) {
        if (!row) return { state: 'uninitialized' as const };
        const inputs = (JSON.parse(row.inputs) as Input[]).map(
            ({ fileId, path, size }) => ({
                fileId,
                path,
                size,
                available:
                    savedInput.get(row.owner, row.spaceId, fileId) !==
                    undefined,
            }),
        );
        return {
            state: row.state,
            inputs,
            ...(row.projectId ? { projectId: row.projectId } : {}),
            ...(row.issues
                ? { issues: JSON.parse(row.issues) as Issue[] }
                : {}),
        };
    }

    function deletionProject(
        owner: string,
        spaceId: string,
        fileId: string,
    ): string | null {
        const row = current(spaceId);
        if (!row) return null;
        if (row.owner !== owner) throw notFound();
        if (
            !(JSON.parse(row.inputs) as Input[]).some(
                (input) => input.fileId === fileId,
            )
        )
            return null;
        if (row.state === 'validating' || row.state === 'importing')
            throw new RequestError(
                409,
                'project_importing',
                '文件正在用于初始化工作区。',
            );
        return row.projectId;
    }

    function detail(owner: string, spaceId: string) {
        return {
            ...project(owner, spaceId),
            execution: view(current(spaceId)),
            files: files(owner, spaceId).map(({ fileId, path, size }) => ({
                id: fileId,
                path,
                size,
            })),
        };
    }

    function start(owner: string, spaceId: string, key: string, body: unknown) {
        project(owner, spaceId);
        requireWritableProject(owner, spaceId);
        const { fileIds } = object(body);
        if (
            !Array.isArray(fileIds) ||
            !fileIds.length ||
            fileIds.some((id) => typeof id !== 'string') ||
            new Set(fileIds).size !== fileIds.length
        )
            throw new RequestError(
                400,
                'invalid_execution_input',
                '请选择不重复的项目文件。',
            );
        if (fileIds.length > maxSnapshotFiles)
            throw new RequestError(
                413,
                'execution_input_too_large',
                '执行输入最多 100 个文件。',
            );
        const sorted = (fileIds as string[]).slice().sort();
        const prior = db
            .prepare(
                'SELECT * FROM space_execution WHERE spaceId = ? AND key = ?',
            )
            .get(spaceId, key) as Init | undefined;
        if (prior) {
            const previousIds = (JSON.parse(prior.inputs) as Input[]).map(
                (file) => file.fileId,
            );
            if (JSON.stringify(previousIds) !== JSON.stringify(sorted))
                throw new RequestError(
                    409,
                    'idempotency_conflict',
                    '此提交键已用于其他文件。',
                );
            return { executionStatus: 200, execution: view(prior) } as const;
        }
        const existing = current(spaceId);
        if (existing && (existing.state !== 'failed' || existing.projectId)) {
            throw new RequestError(
                409,
                'execution_already_bound',
                '项目已有工作区或正在初始化，请查看原记录。',
            );
        }
        const available = new Map(
            files(owner, spaceId).map((file) => [file.fileId, file]),
        );
        const selected = sorted.map((id) => {
            const file = available.get(id);
            if (!file) throw notFound();
            return file;
        });
        if (
            selected.reduce((sum, file) => sum + file.size, 0) >
            maxSnapshotBytes
        )
            throw new RequestError(
                413,
                'execution_input_too_large',
                '执行输入合计最多 1 MiB。',
                selected.map(({ fileId, path }) => ({
                    fileId,
                    path,
                    code: 'execution_input_too_large',
                })),
            );
        db.prepare(
            `
            INSERT INTO space_execution (spaceId,owner,key,state,inputs)
            VALUES (?,?,?,'validating',?)
        `,
        ).run(spaceId, owner, key, JSON.stringify(selected));
        const execution = view(current(spaceId));
        wake();
        return { executionStatus: 202, execution } as const;
    }

    async function validate(row: Init) {
        const issues: Issue[] = [];
        const sources: ProjectInput['files'] = [];
        for (const { fileId, path, size, manifest } of JSON.parse(
            row.inputs,
        ) as Input[]) {
            if (!snapshotPathParts(path)) {
                issues.push({ fileId, path, code: 'invalid_path' });
                continue;
            }
            const bytes = await readFile(spaceObjectKey(fileId), size);
            const digest = createHash('sha256').update(bytes).digest('base64');
            if (size && digest !== (JSON.parse(manifest) as string[])[0])
                throw new Error('Saved file checksum mismatch');
            try {
                sources.push({
                    path,
                    text: new TextDecoder('utf-8', {
                        fatal: true,
                        ignoreBOM: true,
                    }).decode(bytes),
                });
            } catch {
                issues.push({ fileId, path, code: 'invalid_utf8' });
            }
        }
        if (issues.length) {
            db.prepare(
                "UPDATE space_execution SET state = 'failed', issues = ? WHERE spaceId = ? AND key = ?",
            ).run(JSON.stringify(issues), row.spaceId, row.key);
            return;
        }
        const input = {
            name: project(row.owner, row.spaceId).name,
            files: sources,
        };
        db.prepare(
            "UPDATE space_execution SET state = 'importing', snapshot = ? WHERE spaceId = ? AND key = ?",
        ).run(JSON.stringify(input), row.spaceId, row.key);
    }

    async function reconcile(row: Init) {
        const key =
            'space-init-' +
            createHash('sha256')
                .update(JSON.stringify([row.spaceId, row.key]))
                .digest('hex');
        const result = await backend(
            row.owner,
            row.projectId
                ? { kind: 'project', projectId: row.projectId }
                : {
                      kind: 'createProject',
                      key,
                      input: JSON.parse(row.snapshot ?? '') as ProjectInput,
                  },
        );
        if (!('json' in result) || !('name' in result.json))
            throw new Error('Invalid project response');
        const { id, status } = result.json;
        db.prepare(
            'UPDATE space_execution SET projectId = ?, state = ?, snapshot = NULL WHERE spaceId = ? AND key = ?',
        ).run(id, status, row.spaceId, row.key);
    }

    function transaction<T>(change: () => T) {
        db.exec('BEGIN IMMEDIATE');
        try {
            const result = change();
            db.exec('COMMIT');
            return result;
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

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
        if (
            selected.some(
                (file) =>
                    !file ||
                    db
                        .prepare(
                            'SELECT 1 FROM space_file_deletions WHERE fileId=?',
                        )
                        .get(file.fileId),
            )
        )
            throw notFound();
        const input = selected as Input[];
        if (
            input.length > maxSnapshotFiles ||
            input.reduce((sum, file) => sum + file.size, 0) > maxSnapshotBytes
        )
            throw new RequestError(
                413,
                'too_large',
                '所选文件超出任务快照限制。',
            );
        return input;
    }

    function enrollTask(
        owner: string,
        key: string,
        name: string,
        source: Extract<TaskSource, { kind: 'space_snapshot' }>,
    ) {
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
        const selected = taskFiles(
            row.owner,
            row.spaceId,
            JSON.parse(row.fileIds) as string[],
        );
        const inputFiles: ProjectInput['files'] = [];
        const inputManifest: FrozenTaskInput['inputManifest'] = [];
        for (const { fileId, path, size, manifest } of selected) {
            if (!snapshotPathParts(path))
                throw new RequestError(
                    400,
                    'invalid_input',
                    '所选文件路径无法用于任务。',
                );
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
                throw new RequestError(
                    400,
                    'invalid_input',
                    '所选文件无法按 UTF-8 读取。',
                );
            }
            inputFiles.push({ path, text });
            inputManifest.push({
                fileId,
                path,
                bytes: size,
                sha256: digest.digest('hex'),
            });
        }
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
        if (row.state === 'frozen')
            db.prepare(
                "UPDATE space_tasks SET state='submitted' WHERE id=?",
            ).run(row.id);
        try {
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
        const row = enrollTask(owner, key, name, source);
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

    async function advance() {
        const tasks = db
            .prepare(
                `SELECT * FROM space_tasks WHERE
                    (state IN ('pinned','frozen','submitted') AND lastError IS NOT 'owner_closed')
                    OR (state='failed' AND canonicalBody IS NOT NULL)`,
            )
            .all() as TaskIntent[];
        for (const row of tasks) {
            if (closing) return;
            if (row.state === 'failed' && draining.has(row.owner)) continue;
            await reconcileTask(row).catch(() => undefined);
        }
        const rows = db
            .prepare(
                "SELECT * FROM space_execution WHERE state IN ('validating','importing')",
            )
            .all() as Init[];
        for (const row of rows) {
            if (closing) return;
            if (draining.has(row.owner)) continue;
            activeOwner = row.owner;
            try {
                if (row.state === 'validating') await validate(row);
                const next = current(row.spaceId);
                if (next?.state === 'importing') await reconcile(next);
            } catch {
                // Keep the intent and original key for the next pass.
            } finally {
                activeOwner = undefined;
            }
        }
    }
    function wake() {
        if (closing || advancing) return;
        advancing = advance()
            .catch(() => undefined)
            .finally(() => {
                advancing = undefined;
            });
    }
    const timer = setInterval(wake, 2000).unref();
    return {
        createTask,
        hasTaskPin,
        settleProjectTasks,
        purgeTaskIntents,
        detail,
        projectDeletionInput(owner: string, spaceId: string) {
            project(owner, spaceId);
            const row = current(spaceId);
            if (row && row.owner !== owner) throw notFound();
            return {
                importing:
                    row?.state === 'validating' || row?.state === 'importing',
                projectId: row?.projectId ?? null,
            };
        },
        start,
        deletionProject,
        drain(owner: string, confirmed = false) {
            draining.add(owner);
            if (confirmed) confirmedDraining.add(owner);
            return (
                activeOwner !== owner &&
                !db
                    .prepare(
                        "SELECT 1 FROM space_tasks WHERE owner=? AND state IN ('pinned','frozen','submitted') AND lastError IS NOT 'owner_closed'",
                    )
                    .get(owner)
            );
        },
        async close() {
            closing = true;
            clearInterval(timer);
            await advancing;
            await Promise.allSettled(taskAdvances.values());
        },
    };
}
