import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { filePath } from '../../../apps/orchestrator/execution-service/input.ts';
import { notFound, object, RequestError } from './protocol.ts';
import type { Backend, ProjectInput } from './protocol.ts';
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
const maxBytes = 1024 * 1024;

function view(row: Init | undefined) {
    if (!row) return { state: 'uninitialized' as const };
    const inputs = (JSON.parse(row.inputs) as Input[]).map(
        ({ fileId, path, size }) => ({ fileId, path, size, available: true }),
    );
    return {
        state: row.state,
        inputs,
        ...(row.projectId ? { projectId: row.projectId } : {}),
        ...(row.issues ? { issues: JSON.parse(row.issues) as Issue[] } : {}),
    };
}

export function spaceExecution(
    db: DatabaseSync,
    backend: Backend,
    readFile: (key: string, size: number) => Promise<Buffer>,
) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS space_execution (
            spaceId TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL,
            state TEXT NOT NULL, inputs TEXT NOT NULL, projectId TEXT, snapshot TEXT, issues TEXT,
            PRIMARY KEY(spaceId, key)
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS one_space_execution
            ON space_execution(spaceId) WHERE state <> 'failed' OR projectId IS NOT NULL;
    `);
    let advancing: Promise<void> | undefined;
    let closing = false;
    let activeOwner: string | undefined;
    const draining = new Set<string>();

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
        if (fileIds.length > 100)
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
        if (selected.reduce((sum, file) => sum + file.size, 0) > maxBytes)
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
            try {
                filePath(path);
            } catch {
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

    async function advance() {
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
        detail,
        start,
        drain(owner: string) {
            draining.add(owner);
            return activeOwner !== owner;
        },
        async close() {
            closing = true;
            clearInterval(timer);
            await advancing;
        },
    };
}
