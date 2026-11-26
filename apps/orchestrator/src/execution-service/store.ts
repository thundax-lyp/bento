import { TaskEvidenceStore } from './task-evidence-store.ts';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
    conflict,
    invalid,
    missing,
    RequestError,
    textSnapshot,
} from './input.ts';
import type { Binding, FileText, ProjectStatus, RunStatus } from './types.ts';

type Project = {
    id: string;
    name: string;
    status: ProjectStatus;
    createdAt: string;
    owner: string;
    sessionId: string;
    sandbox: string;
    volume: string;
    source: string | null;
};
type Run = {
    id: string;
    projectId: string;
    sessionId: string;
    status: RunStatus;
    createdAt: string;
    updatedAt: string;
    summary: string | null;
    prompt: string;
    baseline: string | null;
    receipt: number;
    reconciled: number;
    diff: string | null;
    cancelGeneration: number | null;
    cancelWorkerClosed: 0 | 1;
    taskSequence: number | null;
    retryOf: string | null;
    expectedGeneration: number | null;
    admittedGeneration: number | null;
    admittedBindingDigest: string | null;
};

type Task = {
    id: string;
    owner: string;
    name: string;
    sourceSpaceId: string | null;
    inputDigest: string;
    environmentVersion: string;
    createdAt: string;
    updatedAt: string;
    prepareError: string | null;
    closedReason: 'unconfirmed' | null;
    inputManifest: string;
};
type TaskInputFile = {
    fileId: string;
    path: string;
    bytes: number;
    sha256: string;
};
export type TaskInput = {
    id: string | null;
    name: string;
    sourceSpaceId: string | null;
    inputFiles: FileText[];
    inputManifest: TaskInputFile[];
    inputDigest: string;
};
type ConfirmedRetryPhase =
    'preparing' | 'workspace_restored' | 'history_restored';
type RetryEvidence = {
    oldGeneration: number;
    newGeneration: number;
    workspaceSha256: string;
    historySha256: string;
};
type RetryAttempt = RetryEvidence & {
    id: string;
    taskId: string;
    sourceRunId: string;
    newRunId: string;
    key: string;
    hash: string;
    phase: ConfirmedRetryPhase | 'queued' | 'closed' | 'blocked';
    lastConfirmedPhase: ConfirmedRetryPhase;
};
type InputHoldState = 'held' | 'denied' | 'released';
type SourceDeletionState = InputHoldState | 'committing' | 'deleted';
type TaskEventPayload = {
    kind: 'user_message' | 'agent_reply' | 'step' | 'command' | 'check';
    text: string;
    check: {
        name: string;
        status: 'passed' | 'failed' | 'not_run' | 'unavailable';
        output: string | null;
    } | null;
};
type TaskResultInput = {
    baselineSha256: string;
    initialSha256: string;
    afterSha256: string;
    incremental: string;
    cumulative: string;
};
const sha256 = (value: string) =>
    createHash('sha256').update(value).digest('hex');
const hashJson = (value: unknown) => sha256(JSON.stringify(value));
const idempotencyConflict = () =>
    conflict(
        'idempotency_conflict',
        'Idempotency-Key already belongs to a different input.',
    );
const busyProject = () =>
    conflict('project_busy', 'A source resource is being deleted.');
const queueFull = () =>
    new RequestError(
        429,
        'tenant_queue_full',
        'Tenant queue is full. Retry after a Run is claimed.',
    );
const pendingRetries =
    "('preparing','workspace_restored','history_restored','blocked')";

const projectView = ({ id, name, status, createdAt }: Project) => ({
    id,
    name,
    status,
    createdAt,
});
const runView = ({
    id,
    projectId,
    sessionId,
    status,
    createdAt,
    updatedAt,
    summary,
}: Run) => ({
    id,
    projectId,
    sessionId,
    status,
    createdAt,
    updatedAt,
    ...(summary === null ? {} : { summary }),
});
const now = () => new Date().toISOString();
type FileDeleteHold = { state: 'held' | 'denied' | 'released' };

export type ProjectDeletionBlocker = 'project_importing' | 'project_busy';
export type ProjectDeletionReceipt =
    | { state: 'denied'; code: ProjectDeletionBlocker }
    | { state: 'deleting' | 'deleted' };

const pending =
    "('pending_approval','queued','running','recovering','cancelling','needs_review')";

export function projectBinding(project: Project): Binding {
    return {
        tenant: project.owner,
        project: project.id,
        session: project.sessionId,
        sandbox: project.sandbox,
        volume: project.volume,
    };
}

export class Store {
    private readonly db: DatabaseSync;
    private readonly evidence: TaskEvidenceStore;

    private readonly tenantQueueLimit: number;
    private readonly requireTaskRunApproval: boolean;
    private readonly path: string;
    private readonly goControl: string | undefined;

    constructor(
        path: string,
        tenantQueueLimit = 16,
        goControl?: string,
        requireTaskRunApproval = false,
    ) {
        this.path = path;
        this.goControl = goControl;
        this.tenantQueueLimit = tenantQueueLimit;
        this.requireTaskRunApproval = requireTaskRunApproval;
        this.db = new DatabaseSync(path);
        this.evidence = new TaskEvidenceStore(
            this.db,
            (action) => this.write(action),
            (id) => this.findRun(id),
        );
        this.db.exec(`
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
                status TEXT NOT NULL, createdAt TEXT NOT NULL, sessionId TEXT NOT NULL UNIQUE,
                sandbox TEXT NOT NULL UNIQUE, volume TEXT NOT NULL UNIQUE, source TEXT
            );
            CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner);
            CREATE TABLE IF NOT EXISTS draining_owners (owner TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS project_deletions (
                projectId TEXT NOT NULL, operationId TEXT NOT NULL,
                owner TEXT NOT NULL, state TEXT NOT NULL, code TEXT,
                PRIMARY KEY(projectId, operationId),
                CHECK ((state='denied' AND code IS NOT NULL AND code IN ('project_importing','project_busy'))
                    OR (state IN ('deleting','deleted') AND code IS NULL))
            ) STRICT;
            CREATE UNIQUE INDEX IF NOT EXISTS project_deletion_accepted
                ON project_deletions(projectId) WHERE state IN ('deleting','deleted');
            CREATE TABLE IF NOT EXISTS project_requests (
                owner TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL,
                projectId TEXT NOT NULL REFERENCES projects(id), PRIMARY KEY(owner,key)
            );
            CREATE TABLE IF NOT EXISTS file_delete_holds (
                projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                operationId TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('held','denied','released')),
                PRIMARY KEY(projectId,operationId)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), sessionId TEXT NOT NULL,
                key TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL,
                createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, summary TEXT,
                baseline TEXT, receipt INTEGER NOT NULL DEFAULT 0, reconciled INTEGER NOT NULL DEFAULT 0, diff TEXT,
                cancelGeneration INTEGER, cancelWorkerClosed INTEGER NOT NULL DEFAULT 0,
                taskSequence INTEGER, retryOf TEXT, expectedGeneration INTEGER,
                admittedGeneration INTEGER, admittedBindingDigest TEXT,
                UNIQUE(projectId,key)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS one_pending_run_per_project
                ON runs(projectId) WHERE status IN ${pending};
            DROP INDEX IF EXISTS one_active_host_run;
            CREATE TABLE IF NOT EXISTS run_approval_decisions (
                runId TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
                action TEXT NOT NULL CHECK(action IN ('approve-run','reject-run')),
                decidedAt TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS run_dispatches (
                runId TEXT PRIMARY KEY REFERENCES runs(id)
            );
            CREATE TABLE IF NOT EXISTS run_slot_leases (
                slot INTEGER PRIMARY KEY CHECK(slot IN (0,1)),
                runId TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS run_admission_drain (
                active INTEGER PRIMARY KEY CHECK(active=1)
            );
            CREATE TABLE IF NOT EXISTS run_reviews (
                runId TEXT PRIMARY KEY REFERENCES runs(id), proof TEXT NOT NULL, reviewedAt TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS run_recoveries (
                runId TEXT PRIMARY KEY REFERENCES runs(id), generation INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, owner TEXT NOT NULL, name TEXT NOT NULL,
                sourceSpaceId TEXT, inputDigest TEXT NOT NULL, environmentVersion TEXT NOT NULL,
                createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, prepareError TEXT, closedReason TEXT,
                inputManifest TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE IF NOT EXISTS task_creation_receipts (
                owner TEXT NOT NULL, key TEXT NOT NULL, taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                hash TEXT NOT NULL, PRIMARY KEY(owner,key)
            );
            CREATE TABLE IF NOT EXISTS task_input_refs (
                taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, fileId TEXT NOT NULL, PRIMARY KEY(taskId,fileId)
            );
            CREATE TABLE IF NOT EXISTS task_events (
                taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, sequence INTEGER NOT NULL,
                eventId TEXT NOT NULL, runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, at TEXT NOT NULL, body TEXT NOT NULL,
                PRIMARY KEY(taskId,sequence), UNIQUE(taskId,eventId)
            );
            CREATE TABLE IF NOT EXISTS task_projection_ends (
                runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, generation INTEGER NOT NULL, PRIMARY KEY(runId,generation)
            );
            CREATE TABLE IF NOT EXISTS task_run_results (
                runId TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, body TEXT NOT NULL, createdAt TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS task_run_checkpoints (
                runId TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, workspace TEXT NOT NULL,
                workspaceSha256 TEXT NOT NULL, historySha256 TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS physical_stop_proofs (
                runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                generation INTEGER NOT NULL,
                canonicalJson TEXT NOT NULL,
                sha256 TEXT NOT NULL,
                PRIMARY KEY(runId,generation)
            );
            CREATE TABLE IF NOT EXISTS physical_stop_consumption (
                runId TEXT NOT NULL,
                generation INTEGER NOT NULL,
                consumer TEXT NOT NULL CHECK(consumer IN ('slot','upgrade')),
                sha256 TEXT NOT NULL,
                PRIMARY KEY(runId,generation,consumer),
                FOREIGN KEY(runId,generation)
                    REFERENCES physical_stop_proofs(runId,generation)
                    ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS stop_proofs (
                runId TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, canonicalJson TEXT NOT NULL,
                sha256 TEXT NOT NULL, createdAt TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS worker_exit (
                runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, generation INTEGER NOT NULL,
                bindingDigest TEXT NOT NULL, exitedAt TEXT NOT NULL, PRIMARY KEY(runId,generation)
            );
            CREATE TABLE IF NOT EXISTS retry_attempts (
                id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, sourceRunId TEXT NOT NULL UNIQUE,
                newRunId TEXT NOT NULL UNIQUE, key TEXT NOT NULL, hash TEXT NOT NULL,
                phase TEXT NOT NULL CHECK(phase IN ('preparing','workspace_restored','history_restored','blocked','queued','closed')),
                lastConfirmedPhase TEXT NOT NULL CHECK(lastConfirmedPhase IN ('preparing','workspace_restored','history_restored')),
                oldGeneration INTEGER NOT NULL, newGeneration INTEGER NOT NULL,
                workspaceSha256 TEXT NOT NULL, historySha256 TEXT NOT NULL, error TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
                UNIQUE(taskId,key)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS one_pending_retry_per_task ON retry_attempts(taskId) WHERE phase IN ${pendingRetries};
            CREATE TABLE IF NOT EXISTS task_input_delete_holds (
                owner TEXT NOT NULL, spaceId TEXT NOT NULL, fileId TEXT NOT NULL, operationId TEXT NOT NULL, legacyProjectId TEXT,
                state TEXT NOT NULL, PRIMARY KEY(owner,spaceId,fileId,operationId)
            );
            CREATE TABLE IF NOT EXISTS task_source_deletions (
                owner TEXT NOT NULL, spaceId TEXT NOT NULL, operationId TEXT NOT NULL, legacyProjectId TEXT,
                state TEXT NOT NULL, code TEXT, PRIMARY KEY(owner,spaceId,operationId)
            );
            CREATE TABLE IF NOT EXISTS task_source_deletion_items (
                owner TEXT NOT NULL, spaceId TEXT NOT NULL, operationId TEXT NOT NULL, projectId TEXT NOT NULL,
                cleaned INTEGER NOT NULL, PRIMARY KEY(owner,spaceId,operationId,projectId)
            );
            CREATE TABLE IF NOT EXISTS task_closure_audit (
                runId TEXT PRIMARY KEY, decision TEXT NOT NULL, authorityGeneration INTEGER NOT NULL, stopDigest TEXT NOT NULL,
                closedAt TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS task_retry_closure_audit (
                attemptId TEXT PRIMARY KEY, authorityGeneration INTEGER NOT NULL, evidenceDigest TEXT NOT NULL, closedAt TEXT NOT NULL
            );
        `);
    }

    close() {
        this.db.close();
    }

    drainOwner(owner: string) {
        if (this.goControl) {
            if (this.business('drain-owner', { owner }) !== true)
                throw new Error('Go owner drain unavailable');
            return;
        }
        this.db
            .prepare('INSERT OR IGNORE INTO draining_owners VALUES (?)')
            .run(owner);
    }

    private requireOpenOwner(owner: string) {
        if (
            this.db
                .prepare('SELECT 1 FROM draining_owners WHERE owner = ?')
                .get(owner)
        )
            throw conflict('owner_closed', 'Account is closed.');
    }

    ownerDrained(owner: string) {
        return !this.db
            .prepare(
                `SELECT 1 FROM projects p WHERE p.owner=? AND (
            p.status='importing' OR EXISTS (SELECT 1 FROM runs r WHERE r.projectId=p.id AND r.status IN ${pending})
        ) UNION ALL SELECT 1 FROM tasks t JOIN retry_attempts a ON t.id=a.taskId WHERE t.owner=? AND a.phase IN ${pendingRetries}
        UNION ALL SELECT 1 FROM task_source_deletions WHERE owner=? AND state IN ('held','committing')
        UNION ALL SELECT 1 FROM task_input_delete_holds WHERE owner=? AND state='held'`,
            )
            .get(owner, owner, owner, owner);
    }

    ownerBindings(owner: string) {
        return (
            this.db
                .prepare('SELECT * FROM projects WHERE owner = ?')
                .all(owner) as Project[]
        ).map(projectBinding);
    }

    projectRunIds(project: string) {
        return this.db
            .prepare('SELECT id FROM runs WHERE projectId = ?')
            .all(project)
            .map((row) => row.id as string);
    }

    purgeProject(
        binding: Binding,
        operationId?: string,
        sourceSpaceId?: string,
    ) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const sourceDeletion =
                sourceSpaceId !== undefined && operationId !== undefined;
            const sourceBinding = sourceDeletion
                ? this.taskSourceDeletionBindings(
                      binding.tenant,
                      sourceSpaceId,
                      operationId,
                  ).find((item) => item.project === binding.project)
                : undefined;
            if (sourceDeletion && !sourceBinding) throw missing();
            const actual =
                sourceBinding ??
                (operationId
                    ? this.projectDeletionBinding(
                          binding.tenant,
                          binding.project,
                          operationId,
                      )
                    : projectBinding(
                          this.ownedProject(
                              binding.tenant,
                              binding.project,
                              true,
                          ),
                      ));
            if (
                actual.session !== binding.session ||
                actual.sandbox !== binding.sandbox ||
                actual.volume !== binding.volume
            )
                throw missing();
            if (!operationId && this.isProjectDeleting(binding.project))
                throw conflict(
                    'project_busy',
                    'Project deletion is in progress.',
                );
            for (const table of [
                'run_dispatches',
                'run_reviews',
                'run_recoveries',
            ])
                this.db
                    .prepare(
                        'DELETE FROM ' +
                            table +
                            ' WHERE runId IN (SELECT id FROM runs WHERE projectId = ?)',
                    )
                    .run(binding.project);
            this.db
                .prepare('DELETE FROM runs WHERE projectId = ?')
                .run(binding.project);
            this.db
                .prepare('DELETE FROM project_requests WHERE projectId = ?')
                .run(binding.project);
            this.db
                .prepare('DELETE FROM projects WHERE id = ? AND owner = ?')
                .run(binding.project, binding.tenant);
            if (sourceDeletion)
                this.db
                    .prepare(
                        'UPDATE task_source_deletion_items SET cleaned=1 WHERE owner=? AND spaceId=? AND operationId=? AND projectId=?',
                    )
                    .run(
                        binding.tenant,
                        sourceSpaceId,
                        operationId,
                        binding.project,
                    );
            else if (operationId)
                this.db
                    .prepare(
                        "UPDATE project_deletions SET state='deleted' WHERE projectId=? AND operationId=?",
                    )
                    .run(binding.project, operationId);
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    isProjectDeleting(projectId: string): boolean {
        return !!this.db
            .prepare(
                "SELECT 1 FROM project_deletions WHERE projectId=?1 AND state='deleting' UNION ALL SELECT 1 FROM task_source_deletion_items i JOIN task_source_deletions d USING(owner,spaceId,operationId) WHERE i.projectId=?1 AND d.state IN ('held','committing')",
            )
            .get(projectId);
    }

    private projectDeletionBlockers(
        project: Project,
    ): ProjectDeletionBlocker[] {
        const blockers: ProjectDeletionBlocker[] = [];
        if (project.status === 'importing') blockers.push('project_importing');
        if (
            this.inputDeletionHeld(project.id) ||
            this.pendingTaskRetry(project.id) ||
            this.db
                .prepare(
                    `SELECT 1 FROM runs WHERE projectId=? AND status IN ${pending}`,
                )
                .get(project.id) ||
            this.db
                .prepare(
                    "SELECT 1 FROM file_delete_holds WHERE projectId=? AND state='held'",
                )
                .get(project.id)
        )
            blockers.push('project_busy');
        return blockers;
    }

    projectDeletionImpact(owner: string, projectId: string) {
        const project = this.ownedProject(owner, projectId);
        const { runCount, diffCount } = this.db
            .prepare(
                "SELECT count(*) AS runCount, count(CASE WHEN status='succeeded' AND diff IS NOT NULL THEN 1 END) AS diffCount FROM runs WHERE projectId=?",
            )
            .get(projectId) as { runCount: number; diffCount: number };
        return {
            runCount,
            diffCount,
            blockers: this.projectDeletionBlockers(project),
        };
    }

    beginProjectDeletion(
        owner: string,
        projectId: string,
        operationId: string,
    ): ProjectDeletionReceipt {
        return this.write(() => {
            const prior = this.db
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
            const accepted = this.db
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
            const project = this.ownedProject(owner, projectId);
            this.requireOpenOwner(owner);
            const [code] = this.isProjectDeleting(projectId)
                ? ['project_busy' as const]
                : this.projectDeletionBlockers(project);
            const state = code ? 'denied' : 'deleting';
            this.db
                .prepare('INSERT INTO project_deletions VALUES (?,?,?,?,?)')
                .run(projectId, operationId, owner, state, code ?? null);
            return code ? { state: 'denied', code } : { state: 'deleting' };
        });
    }

    projectDeletionBinding(
        owner: string,
        projectId: string,
        operationId: string,
    ): Binding {
        if (
            !this.db
                .prepare(
                    "SELECT 1 FROM project_deletions WHERE owner=? AND projectId=? AND operationId=? AND state='deleting'",
                )
                .get(owner, projectId, operationId)
        )
            throw missing();
        return projectBinding(this.ownedProject(owner, projectId));
    }

    hasProjectDeletionInProgress(owner: string): boolean {
        return !!this.db
            .prepare(
                "SELECT 1 FROM project_deletions WHERE owner=? AND state='deleting'",
            )
            .get(owner);
    }

    clearProjectDeletionReceipts(owner: string): void {
        this.db
            .prepare('DELETE FROM project_deletions WHERE owner=?')
            .run(owner);
    }

    createProject(
        owner: string,
        name: string,
        files: FileText[],
        key?: string,
    ) {
        if (!key)
            return {
                replay: false,
                project: this.addProject(owner, name, files),
            };
        const digest = createHash('sha256')
            .update(JSON.stringify({ name, files }))
            .digest('hex');
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const prior = this.db
                .prepare(
                    'SELECT digest, projectId FROM project_requests WHERE owner = ? AND key = ?',
                )
                .get(owner, key) as
                { digest: string; projectId: string } | undefined;
            if (prior && this.isProjectDeleting(prior.projectId))
                throw missing();
            if (prior && prior.digest !== digest)
                throw conflict(
                    'idempotency_conflict',
                    'Idempotency-Key already belongs to a different input.',
                );
            const project = prior
                ? this.project(owner, prior.projectId)
                : this.addProject(owner, name, files);
            if (!prior)
                this.db
                    .prepare('INSERT INTO project_requests VALUES (?,?,?,?)')
                    .run(owner, key, digest, project.id);
            this.db.exec('COMMIT');
            return { replay: !!prior, project };
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    addProject(
        owner: string,
        name: string,
        files: FileText[],
        id: string = randomUUID(),
    ) {
        this.requireOpenOwner(owner);
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
        this.db
            .prepare('INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?)')
            .run(
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

    private ownedProject(owner: string, id: string, allowTask = false) {
        const row = this.db
            .prepare('SELECT * FROM projects WHERE id=? AND owner=?')
            .get(id, owner);
        if (
            !row ||
            (!allowTask &&
                this.db.prepare('SELECT 1 FROM tasks WHERE id=?').get(id))
        )
            throw missing();
        return row as Project;
    }

    project(owner: string, id: string) {
        const project = this.ownedProject(owner, id);
        if (this.isProjectDeleting(id)) throw missing();
        return projectView(project);
    }

    sharedProjectBinding(owner: string, id: string) {
        this.requireOpenOwner(owner);
        const project = this.ownedProject(owner, id);
        if (project.status !== 'ready' || this.isProjectDeleting(id))
            throw conflict('project_not_ready', 'Project is not ready.');
        return projectBinding(project);
    }

    projects(owner: string) {
        return (
            this.db
                .prepare(
                    "SELECT p.* FROM projects p WHERE owner=? AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id=p.id) AND NOT EXISTS (SELECT 1 FROM project_deletions d WHERE d.projectId=p.id AND d.state='deleting') ORDER BY p.rowid",
                )
                .all(owner) as Project[]
        ).map(projectView);
    }

    private write<T>(action: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = action();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    private sourceDeletion(owner: string, spaceId: string) {
        return this.db
            .prepare(
                "SELECT state FROM task_source_deletions WHERE owner=? AND spaceId=? AND state IN ('held','committing','deleted')",
            )
            .get(owner, spaceId)?.state;
    }

    private taskRow(owner: string, taskId: string) {
        const row = this.db
            .prepare('SELECT * FROM tasks WHERE id=? AND owner=?')
            .get(taskId, owner) as Task | undefined;
        if (!row) throw missing();
        return row;
    }

    task(owner: string, taskId: string) {
        const task = this.taskRow(owner, taskId);
        const project = this.ownedProject(owner, taskId, true);
        const deleting = this.isProjectDeleting(taskId);
        const attempt = this.db
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

    tasks(owner: string, creationKey?: string) {
        const ids =
            creationKey === undefined
                ? this.db
                      .prepare(
                          'SELECT id FROM tasks WHERE owner=? ORDER BY createdAt,id',
                      )
                      .all(owner)
                : this.db
                      .prepare(
                          'SELECT taskId AS id FROM task_creation_receipts WHERE owner=? AND key=?',
                      )
                      .all(owner, creationKey);
        return ids.map((row) => this.task(owner, row.id as string));
    }

    createTask(
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
        return this.write(() => {
            const prior = this.db
                .prepare(
                    'SELECT taskId,hash FROM task_creation_receipts WHERE owner=? AND key=?',
                )
                .get(owner, key);
            if (prior) {
                if (prior.hash !== hash) throw idempotencyConflict();
                return {
                    replay: true,
                    task: this.task(owner, prior.taskId as string),
                };
            }
            this.requireOpenOwner(owner);
            if (input.sourceSpaceId !== null) {
                const state = this.sourceDeletion(owner, input.sourceSpaceId);
                if (state === 'deleted') throw missing();
                if (state) throw busyProject();
                for (const entry of manifest)
                    if (
                        this.db
                            .prepare(
                                "SELECT 1 FROM task_input_delete_holds WHERE owner=? AND spaceId=? AND fileId=? AND state='held'",
                            )
                            .get(owner, input.sourceSpaceId, entry.fileId)
                    )
                        throw busyProject();
            }
            const project = this.addProject(
                owner,
                input.name,
                files,
                input.id ?? randomUUID(),
            );
            this.db
                .prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?)')
                .run(
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
            this.db
                .prepare('INSERT INTO task_creation_receipts VALUES (?,?,?,?)')
                .run(owner, key, project.id, hash);
            for (const entry of manifest)
                this.db
                    .prepare('INSERT INTO task_input_refs VALUES (?,?)')
                    .run(project.id, entry.fileId);
            return { replay: false, task: this.task(owner, project.id) };
        });
    }

    private taskWriteGuard(owner: string, task: Task) {
        this.requireOpenOwner(owner);
        if (this.isProjectDeleting(task.id) || this.inputDeletionHeld(task.id))
            throw busyProject();
        if (
            task.closedReason !== null ||
            this.ownedProject(owner, task.id, true).status !== 'ready'
        )
            throw conflict('task_not_ready', 'Task is not ready.');
        if (
            this.projectHasPendingRun(task.id) ||
            this.pendingTaskRetry(task.id)
        )
            throw conflict('task_busy', 'Task already has an unfinished Run.');
    }

    private pendingTaskRetry(taskId: string) {
        return (
            this.db
                .prepare(
                    `SELECT 1 FROM retry_attempts WHERE taskId=? AND phase IN ${pendingRetries}`,
                )
                .get(taskId) !== undefined
        );
    }

    private projectHasPendingRun(projectId: string) {
        return (
            this.db
                .prepare(
                    `SELECT 1 FROM runs WHERE projectId=? AND status IN ${pending}`,
                )
                .get(projectId) !== undefined
        );
    }

    private inputDeletionHeld(projectId: string) {
        return (
            this.db
                .prepare(
                    `SELECT 1 FROM task_input_delete_holds h WHERE h.state='held' AND
                (h.legacyProjectId=? OR EXISTS (
                    SELECT 1 FROM tasks t JOIN task_input_refs ref ON ref.taskId=t.id
                    WHERE t.id=? AND t.owner=h.owner AND t.sourceSpaceId=h.spaceId AND ref.fileId=h.fileId
                ))`,
                )
                .get(projectId, projectId) !== undefined
        );
    }

    private taskSequence(taskId: string) {
        return this.db
            .prepare(
                'SELECT COALESCE(MAX(taskSequence),0)+1 AS value FROM runs WHERE projectId=?',
            )
            .get(taskId)?.value as number;
    }

    enqueueTaskRun(owner: string, taskId: string, key: string, prompt: string) {
        const enqueue = () => {
            const task = this.taskRow(owner, taskId);
            if (this.retryByKey(taskId, key)) throw idempotencyConflict();
            const prior = this.db
                .prepare('SELECT * FROM runs WHERE projectId=? AND key=?')
                .get(taskId, key) as Run | undefined;
            if (prior) {
                if (prior.prompt !== prompt || prior.retryOf !== null)
                    throw idempotencyConflict();
                return { replay: true, run: prior };
            }
            this.taskWriteGuard(owner, task);
            const latest = this.db
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
            const created = this.enqueueRun(owner, taskId, key, prompt, true);
            const id = created.run.id;
            if (this.goControl) return { replay: false, run: this.findRun(id) };
            this.db
                .prepare('UPDATE runs SET taskSequence=? WHERE id=?')
                .run(this.taskSequence(taskId), id);
            this.appendTaskEvent(taskId, id, id + ':user', {
                kind: 'user_message',
                text: prompt,
                check: null,
            });
            return { replay: false, run: this.findRun(id) };
        };
        return this.goControl ? enqueue() : this.write(enqueue);
    }

    private retryByKey(taskId: string, key: string) {
        return this.db
            .prepare('SELECT * FROM retry_attempts WHERE taskId=? AND key=?')
            .get(taskId, key) as RetryAttempt | undefined;
    }

    acceptTaskRetry(
        owner: string,
        taskId: string,
        sourceRunId: string,
        key: string,
        evidence: RetryEvidence,
    ) {
        const accept = () => {
            const task = this.taskRow(owner, taskId);
            const source = this.findRun(sourceRunId);
            if (source.projectId !== taskId) throw missing();
            const hash = hashJson({ op: 'retry', sourceRunId });
            const prior = this.retryByKey(taskId, key);
            if (prior) {
                if (prior.hash !== hash) throw idempotencyConflict();
                return { replay: true, attempt: prior };
            }
            if (
                this.db
                    .prepare('SELECT 1 FROM runs WHERE projectId=? AND key=?')
                    .get(taskId, key)
            )
                throw idempotencyConflict();
            if (
                (source.status !== 'failed' && source.status !== 'cancelled') ||
                this.db
                    .prepare(
                        'SELECT 1 FROM runs WHERE projectId=? AND taskSequence>?',
                    )
                    .get(taskId, source.taskSequence) ||
                this.db
                    .prepare('SELECT 1 FROM retry_attempts WHERE sourceRunId=?')
                    .get(sourceRunId) ||
                !this.readStopProof(sourceRunId)
            )
                throw conflict('run_not_retryable', 'Run cannot be retried.');
            this.taskWriteGuard(owner, task);
            if (!this.hasQueueCapacity(owner)) throw queueFull();
            const id = randomUUID();
            const newRunId = randomUUID();
            const at = now();
            if (this.goControl) {
                if (
                    this.business('accept-retry', {
                        run: newRunId,
                        attempt: id,
                        project: taskId,
                        owner,
                        sourceRun: sourceRunId,
                        key,
                        proof: hash,
                        generation: evidence.oldGeneration,
                        newGeneration: evidence.newGeneration,
                        workspaceSHA256: evidence.workspaceSha256,
                        historySHA256: evidence.historySha256,
                        queueLimit: this.tenantQueueLimit,
                    }) !== true
                )
                    throw queueFull();
                return { replay: false, attempt: this.taskRetry(id) };
            }
            this.db
                .prepare(
                    `INSERT INTO retry_attempts
                VALUES (?,?,?,?,?,?,'preparing','preparing',?,?,?,?,NULL,?,?)`,
                )
                .run(
                    id,
                    taskId,
                    sourceRunId,
                    newRunId,
                    key,
                    hash,
                    evidence.oldGeneration,
                    evidence.newGeneration,
                    evidence.workspaceSha256,
                    evidence.historySha256,
                    at,
                    at,
                );
            return { replay: false, attempt: this.taskRetry(id) };
        };
        return this.goControl ? accept() : this.write(accept);
    }

    taskRetry(id: string) {
        const attempt = this.db
            .prepare('SELECT * FROM retry_attempts WHERE id=?')
            .get(id) as RetryAttempt | undefined;
        if (!attempt) throw missing();
        return attempt;
    }

    advanceTaskRetry(
        id: string,
        expected: ConfirmedRetryPhase,
        phase: 'workspace_restored' | 'history_restored' | 'blocked',
    ) {
        const next: Record<ConfirmedRetryPhase, string | null> = {
            preparing: 'workspace_restored',
            workspace_restored: 'history_restored',
            history_restored: null,
        };
        if (phase !== 'blocked' && next[expected] !== phase) return false;
        return (
            this.db
                .prepare(
                    'UPDATE retry_attempts SET phase=?,lastConfirmedPhase=?,error=?,updatedAt=? WHERE id=? AND phase=?',
                )
                .run(
                    phase,
                    phase === 'blocked' ? expected : phase,
                    phase === 'blocked' ? 'restore_conflict' : null,
                    now(),
                    id,
                    expected,
                ).changes === 1
        );
    }

    finalizeTaskRetry(id: string, phase: 'history_restored' | 'blocked') {
        if (this.goControl) {
            const attempt = this.taskRetry(id);
            if (
                attempt.phase !== 'queued' &&
                (attempt.phase !== phase ||
                    this.business('finalize-retry', {
                        run: id,
                        status: phase,
                    }) !== true)
            )
                throw conflict('task_busy', 'Retry phase changed.');
            return this.findRun(attempt.newRunId);
        }
        return this.write(() => {
            const attempt = this.taskRetry(id);
            if (attempt.phase === 'queued')
                return this.findRun(attempt.newRunId);
            if (attempt.phase !== phase)
                throw conflict('task_busy', 'Retry phase changed.');
            const source = this.findRun(attempt.sourceRunId);
            const time = now();
            this.db
                .prepare(
                    `INSERT INTO runs(id,projectId,sessionId,key,prompt,status,createdAt,updatedAt,taskSequence,retryOf,expectedGeneration)
                VALUES (?,?,?,?,?,'queued',?,?,?,?,?)`,
                )
                .run(
                    attempt.newRunId,
                    attempt.taskId,
                    source.sessionId,
                    attempt.key,
                    source.prompt,
                    time,
                    time,
                    this.taskSequence(attempt.taskId),
                    source.id,
                    attempt.newGeneration,
                );
            this.appendTaskEvent(
                attempt.taskId,
                attempt.newRunId,
                attempt.newRunId + ':retry',
                { kind: 'step', text: 'Retry queued.', check: null },
            );
            this.db
                .prepare(
                    "UPDATE retry_attempts SET phase='queued',lastConfirmedPhase='history_restored',error=NULL,updatedAt=? WHERE id=?",
                )
                .run(time, id);
            return this.findRun(attempt.newRunId);
        });
    }

    closeBlockedTaskRetry(
        id: string,
        authorityGeneration: number,
        evidenceDigest: string,
    ) {
        return this.write(() => {
            const prior = this.readTaskRetryClosure(id);
            if (prior) {
                if (prior.authorityGeneration !== authorityGeneration)
                    throw conflict(
                        'review_unavailable',
                        'Retry evidence changed.',
                    );
                return prior;
            }
            const attempt = this.taskRetry(id);
            if (
                attempt.phase !== 'blocked' ||
                attempt.newGeneration !== authorityGeneration
            )
                throw conflict(
                    'review_unavailable',
                    'Retry is not awaiting closure.',
                );
            const time = now();
            this.db
                .prepare(
                    'INSERT INTO task_retry_closure_audit VALUES (?,?,?,?)',
                )
                .run(id, authorityGeneration, evidenceDigest, time);
            this.db
                .prepare(
                    "UPDATE retry_attempts SET phase='closed',updatedAt=? WHERE id=?",
                )
                .run(time, id);
            this.db
                .prepare(
                    "UPDATE tasks SET closedReason='unconfirmed',updatedAt=? WHERE id=?",
                )
                .run(time, attempt.taskId);
            return this.readTaskRetryClosure(id);
        });
    }

    readTaskRetryClosure(id: string) {
        return this.db
            .prepare('SELECT * FROM task_retry_closure_audit WHERE attemptId=?')
            .get(id);
    }

    private appendTaskEvent(
        taskId: string,
        runId: string,
        eventId: string,
        value: TaskEventPayload,
    ) {
        const body = JSON.stringify(value);
        const prior = this.db
            .prepare(
                'SELECT runId,body FROM task_events WHERE taskId=? AND eventId=?',
            )
            .get(taskId, eventId);
        if (prior) {
            if (prior.runId !== runId || prior.body !== body)
                throw new Error('Conflicting Task event.');
            return;
        }
        this.db
            .prepare(
                'INSERT INTO task_events SELECT ?,COALESCE(MAX(sequence),0)+1,?,?,?,? FROM task_events WHERE taskId=?',
            )
            .run(taskId, eventId, runId, now(), body, taskId);
    }

    appendTaskEvents(
        taskId: string,
        runId: string,
        generation: number,
        events: readonly (TaskEventPayload & { offset: number })[],
    ) {
        this.write(() => {
            const run = this.findRun(runId);
            if (
                run.projectId !== taskId ||
                run.taskSequence === null ||
                run.admittedGeneration !== generation ||
                run.status !== 'running'
            )
                throw missing();
            const ended = this.db
                .prepare(
                    'SELECT 1 FROM task_projection_ends WHERE runId=? AND generation=?',
                )
                .get(runId, generation);
            const prefix = runId + ':' + generation + ':';
            const previous = this.db
                .prepare(
                    `SELECT max(CAST(substr(eventId,?) AS INTEGER)) AS offset
                 FROM task_events WHERE taskId=? AND runId=? AND substr(eventId,1,?)=?`,
                )
                .get(prefix.length + 1, taskId, runId, prefix.length, prefix);
            let highWater =
                typeof previous?.offset === 'number' ? previous.offset : -1;
            const existing = this.db.prepare(
                'SELECT 1 FROM task_events WHERE taskId=? AND eventId=?',
            );
            for (const { offset, ...value } of events) {
                const eventId = prefix + offset;
                if (!existing.get(taskId, eventId)) {
                    if (ended)
                        throw new Error('Task projection already ended.');
                    if (offset <= highWater)
                        throw new Error(
                            'Task event offset precedes a confirmed event.',
                        );
                    highWater = offset;
                }
                this.appendTaskEvent(taskId, runId, eventId, value);
            }
            if (events.length === 0)
                this.db
                    .prepare(
                        'INSERT OR IGNORE INTO task_projection_ends VALUES (?,?)',
                    )
                    .run(runId, generation);
        });
    }

    taskEvents(owner: string, taskId: string, after: number) {
        this.taskRow(owner, taskId);
        return this.db
            .prepare(
                'SELECT eventId AS id,sequence,runId,at,body FROM task_events WHERE taskId=? AND sequence>? ORDER BY sequence',
            )
            .all(taskId, after)
            .map((row) => ({
                id: row.id as string,
                sequence: row.sequence as number,
                runId: row.runId as string,
                at: row.at as string,
                ...(JSON.parse(row.body as string) as TaskEventPayload),
            }));
    }

    publishTaskResult(
        runId: string,
        input: TaskResultInput,
        reviewProof?: string,
    ) {
        const publish = () => {
            const run = this.findRun(runId);
            if (run.taskSequence === null) throw missing();
            const events = this.db
                .prepare(
                    'SELECT body FROM task_events WHERE runId=? ORDER BY sequence',
                )
                .all(runId)
                .map(
                    (row) => JSON.parse(row.body as string) as TaskEventPayload,
                );
            const summary =
                events.findLast((event) => event.kind === 'agent_reply')
                    ?.text ?? 'Run completed.';
            const checks = events.flatMap((event) =>
                event.check === null ? [] : [event.check],
            );
            const body = JSON.stringify({
                version: 1,
                baselineSha256: input.baselineSha256,
                initialSha256: input.initialSha256,
                afterSha256: input.afterSha256,
                incremental: input.incremental,
                cumulative: input.cumulative,
                incrementalSha256: sha256(input.incremental),
                cumulativeSha256: sha256(input.cumulative),
                summary,
                checks,
            });
            const prior = this.db
                .prepare(
                    'SELECT body,createdAt FROM task_run_results WHERE runId=?',
                )
                .get(runId);
            if (prior) {
                if (prior.body !== body)
                    throw new Error('Conflicting Task result.');
                return { ...JSON.parse(body), createdAt: prior.createdAt };
            }
            if (
                run.status !== 'running' &&
                run.status !== 'recovering' &&
                run.status !== 'needs_review'
            )
                throw conflict(
                    'diff_unavailable',
                    'Run cannot publish a result.',
                );
            if (
                reviewProof !== undefined &&
                (run.status !== 'needs_review' ||
                    run.receipt ||
                    !this.recoveryGeneration(runId))
            )
                throw conflict(
                    'review_unavailable',
                    'Run is not awaiting recovery review.',
                );
            const createdAt = now();
            if (this.goControl) {
                this.business('publish-result', {
                    run: runId,
                    summary,
                    diff: input.incremental,
                    body,
                    proof: reviewProof ?? '',
                    createdAt,
                });
                return { ...JSON.parse(body), createdAt };
            }
            this.db
                .prepare('INSERT INTO task_run_results VALUES (?,?,?)')
                .run(runId, body, createdAt);
            this.db
                .prepare(
                    "UPDATE runs SET status='succeeded',summary=?,diff=?,updatedAt=? WHERE id=?",
                )
                .run(summary, input.incremental, createdAt, runId);
            if (reviewProof !== undefined)
                this.db
                    .prepare('INSERT INTO run_reviews VALUES (?,?,?)')
                    .run(runId, reviewProof, createdAt);
            return { ...JSON.parse(body), createdAt };
        };
        return this.goControl ? publish() : this.write(publish);
    }

    recordStopProof(runId: string, canonicalJson: string) {
        return this.evidence.recordStopProof(runId, canonicalJson);
    }

    readPhysicalStopProof(runId: string, generation: number) {
        return this.db
            .prepare(
                'SELECT canonicalJson,sha256 FROM physical_stop_proofs WHERE runId=? AND generation=?',
            )
            .get(runId, generation);
    }

    recordPhysicalStopProof(
        runId: string,
        generation: number,
        canonicalJson: string,
    ) {
        const digest = createHash('sha256').update(canonicalJson).digest('hex');
        this.db
            .prepare('INSERT INTO physical_stop_proofs VALUES (?,?,?,?)')
            .run(runId, generation, canonicalJson, digest);
    }

    completeAmbiguousRecovery(id: string, generation: number, summary: string) {
        if (
            this.business('complete-ambiguous', {
                run: id,
                generation,
                summary,
            }) !== undefined
        )
            return;
        this.write(() => {
            const proof = this.readPhysicalStopProof(id, generation);
            if (
                !proof ||
                proof.sha256 !==
                    createHash('sha256')
                        .update(String(proof.canonicalJson))
                        .digest('hex')
            )
                throw new Error('Physical stop proof is unavailable');
            this.db
                .prepare(
                    "INSERT OR IGNORE INTO physical_stop_consumption VALUES (?,?,'slot',?)",
                )
                .run(id, generation, proof.sha256);
            this.status(id, 'needs_review', summary);
        });
    }

    consumeUpgradeStops() {
        const result = this.business('drain', {});
        if (result !== undefined) return result === true;
        return this.write(() => {
            const pending = this.db
                .prepare(
                    `SELECT 1 FROM runs
                     WHERE status IN ('running','recovering','cancelling')
                     UNION ALL
                     SELECT 1 FROM physical_stop_proofs p
                     WHERE NOT EXISTS (
                         SELECT 1 FROM physical_stop_consumption c
                         WHERE c.runId=p.runId AND c.generation=p.generation
                           AND c.consumer='slot' AND c.sha256=p.sha256
                     ) LIMIT 1`,
                )
                .get();
            if (pending) return false;
            this.db.exec(
                `INSERT OR IGNORE INTO physical_stop_consumption
                 SELECT runId,generation,'upgrade',sha256
                 FROM physical_stop_consumption WHERE consumer='slot'`,
            );
            return true;
        });
    }

    readStopProof(runId: string) {
        return this.evidence.readStopProof(runId);
    }

    acquireTaskInputDeleteHold(
        owner: string,
        spaceId: string,
        fileId: string,
        operationId: string,
        legacyProjectId: string | null,
    ) {
        return this.write(() =>
            this.changeInputDeleteHold(
                owner,
                spaceId,
                fileId,
                operationId,
                legacyProjectId,
                false,
            ),
        );
    }

    releaseTaskInputDeleteHold(
        owner: string,
        spaceId: string,
        fileId: string,
        operationId: string,
        legacyProjectId: string | null,
    ) {
        return this.write(() =>
            this.changeInputDeleteHold(
                owner,
                spaceId,
                fileId,
                operationId,
                legacyProjectId,
                true,
            ),
        );
    }

    private changeInputDeleteHold(
        owner: string,
        spaceId: string,
        fileId: string,
        operationId: string,
        legacyProjectId: string | null,
        release: boolean,
    ) {
        const prior = this.db
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
                this.db
                    .prepare(
                        "UPDATE task_input_delete_holds SET state='released' WHERE owner=? AND spaceId=? AND fileId=? AND operationId=?",
                    )
                    .run(owner, spaceId, fileId, operationId);
            return { state: 'released' as const };
        }
        const sourceState = this.sourceDeletion(owner, spaceId);
        if (sourceState === 'deleted') throw missing();
        let state: InputHoldState = 'released';
        if (!release) {
            if (sourceState) state = 'denied';
            else {
                this.requireOpenOwner(owner);
                const legacy =
                    legacyProjectId === null
                        ? undefined
                        : this.ownedProject(owner, legacyProjectId);
                const tasks = this.db
                    .prepare(
                        'SELECT p.* FROM projects p JOIN tasks t ON t.id=p.id JOIN task_input_refs r ON r.taskId=t.id WHERE t.owner=? AND t.sourceSpaceId=? AND r.fileId=?',
                    )
                    .all(owner, spaceId, fileId) as Project[];
                if (legacy) tasks.push(legacy);
                state = tasks.some(
                    (project) =>
                        project.status === 'importing' ||
                        this.projectHasPendingRun(project.id) ||
                        this.pendingTaskRetry(project.id) ||
                        this.isProjectDeleting(project.id) ||
                        (legacy?.id === project.id &&
                            this.projectDeletionBlockers(project).length > 0),
                )
                    ? 'denied'
                    : 'held';
            }
        }
        this.db
            .prepare('INSERT INTO task_input_delete_holds VALUES (?,?,?,?,?,?)')
            .run(owner, spaceId, fileId, operationId, legacyProjectId, state);
        return { state };
    }

    changeTaskSourceDeletion(
        owner: string,
        spaceId: string,
        operationId: string,
        legacyProjectId: string | null,
        phase: 'hold' | 'commit' | 'release',
    ) {
        return this.write(() => {
            const prior = this.db
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
                    this.db
                        .prepare(
                            "INSERT INTO task_source_deletions VALUES (?,?,?,?,'released',NULL)",
                        )
                        .run(owner, spaceId, operationId, legacyProjectId);
                if (prior?.state === 'held')
                    this.db
                        .prepare(
                            "UPDATE task_source_deletions SET state='released' WHERE owner=? AND spaceId=? AND operationId=?",
                        )
                        .run(owner, spaceId, operationId);
                return { state: 'released' as const, code: null };
            }
            if (phase === 'commit') {
                if (!prior || prior.state === 'released')
                    throw conflict(
                        'deletion_not_held',
                        'Deletion is not held.',
                    );
                if (prior.state !== 'held') return prior;
                this.db
                    .prepare(
                        "UPDATE task_source_deletions SET state='committing' WHERE owner=? AND spaceId=? AND operationId=?",
                    )
                    .run(owner, spaceId, operationId);
                return { state: 'committing' as const, code: null };
            }
            if (prior?.state === 'released')
                throw conflict('deletion_released', 'Deletion was released.');
            if (prior) return prior;
            if (this.sourceDeletion(owner, spaceId))
                throw idempotencyConflict();
            const projects = this.db
                .prepare(
                    'SELECT p.* FROM projects p JOIN tasks t ON t.id=p.id WHERE t.owner=? AND t.sourceSpaceId=?',
                )
                .all(owner, spaceId) as Project[];
            if (legacyProjectId !== null)
                projects.push(this.ownedProject(owner, legacyProjectId));
            const blocked = projects.flatMap((project) =>
                this.projectDeletionBlockers(project),
            );
            const code = blocked.includes('project_importing')
                ? 'project_importing'
                : blocked.length ||
                    projects.some((project) =>
                        this.isProjectDeleting(project.id),
                    ) ||
                    this.db
                        .prepare(
                            "SELECT 1 FROM task_input_delete_holds WHERE owner=? AND spaceId=? AND state='held'",
                        )
                        .get(owner, spaceId)
                  ? 'project_busy'
                  : this.db
                          .prepare(
                              'SELECT 1 FROM draining_owners WHERE owner=?',
                          )
                          .get(owner)
                    ? 'owner_closed'
                    : null;
            const state = code ? 'denied' : 'held';
            this.db
                .prepare(
                    'INSERT INTO task_source_deletions VALUES (?,?,?,?,?,?)',
                )
                .run(owner, spaceId, operationId, legacyProjectId, state, code);
            if (!code)
                for (const project of projects)
                    this.db
                        .prepare(
                            'INSERT INTO task_source_deletion_items VALUES (?,?,?,?,0)',
                        )
                        .run(owner, spaceId, operationId, project.id);
            return { state, code };
        });
    }

    taskSourceDeletionBindings(
        owner: string,
        spaceId: string,
        operationId: string,
    ) {
        return (
            this.db
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

    finishTaskSourceDeletion(
        owner: string,
        spaceId: string,
        operationId: string,
    ) {
        this.db
            .prepare(
                `UPDATE task_source_deletions SET state='deleted'
            WHERE owner=? AND spaceId=? AND operationId=? AND state='committing'
              AND NOT EXISTS(SELECT 1 FROM task_source_deletion_items i
                WHERE i.owner=? AND i.spaceId=? AND i.operationId=? AND i.cleaned=0)`,
            )
            .run(owner, spaceId, operationId, owner, spaceId, operationId);
        return (
            this.db
                .prepare(
                    'SELECT state FROM task_source_deletions WHERE owner=? AND spaceId=? AND operationId=?',
                )
                .get(owner, spaceId, operationId)?.state === 'deleted'
        );
    }

    taskConfig(taskId: string) {
        return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as
            Task | undefined;
    }

    prepareTask(owner: string, id: string) {
        return this.write(() => {
            const task = this.taskRow(owner, id);
            this.requireOpenOwner(owner);
            if (
                task.closedReason ||
                this.isProjectDeleting(id) ||
                this.inputDeletionHeld(id)
            )
                throw conflict('task_not_ready', 'Task cannot be prepared.');
            const changed = this.db
                .prepare(
                    "UPDATE projects SET status='importing' WHERE id=? AND status='failed'",
                )
                .run(id).changes;
            if (changed)
                this.db
                    .prepare(
                        'UPDATE tasks SET prepareError=NULL,updatedAt=? WHERE id=?',
                    )
                    .run(now(), id);
            return this.task(owner, id);
        });
    }

    taskInitialFiles(taskId: string) {
        const row = this.db
            .prepare('SELECT source FROM projects WHERE id=?')
            .get(taskId);
        return textSnapshot(
            JSON.parse((row?.source as string | null) ?? 'null'),
        );
    }

    taskRunRows(owner: string, id: string) {
        this.taskRow(owner, id);
        return this.db
            .prepare(
                'SELECT * FROM runs WHERE projectId=? ORDER BY taskSequence',
            )
            .all(id) as Run[];
    }

    taskRunRow(owner: string, id: string, runId: string) {
        this.taskRow(owner, id);
        const run = this.findRun(runId);
        if (run.projectId !== id) throw missing();
        return run;
    }

    taskResultRow(runId: string) {
        const row = this.db
            .prepare(
                'SELECT body,createdAt FROM task_run_results WHERE runId=?',
            )
            .get(runId);
        if (!row) return null;
        type Result = TaskResultInput & {
            version: 1;
            summary: string;
            checks: NonNullable<TaskEventPayload['check']>[];
            incrementalSha256: string;
            cumulativeSha256: string;
        };
        return {
            ...(JSON.parse(row.body as string) as Result),
            createdAt: row.createdAt as string,
        };
    }

    taskSourceImpact(
        owner: string,
        spaceId: string,
        legacyProjectId: string | null,
    ) {
        const projects = this.db
            .prepare(
                'SELECT p.* FROM projects p JOIN tasks t ON p.id=t.id WHERE t.owner=? AND t.sourceSpaceId=?',
            )
            .all(owner, spaceId) as Project[];
        if (legacyProjectId !== null)
            projects.push(this.ownedProject(owner, legacyProjectId));
        let runCount = 0;
        let diffCount = 0;
        const blockers = new Set<ProjectDeletionBlocker>();
        for (const project of projects) {
            const impact = this.db
                .prepare(
                    "SELECT count(*) AS runCount,count(CASE WHEN status='succeeded' AND diff IS NOT NULL THEN 1 END) AS diffCount FROM runs WHERE projectId=?",
                )
                .get(project.id) as { runCount: number; diffCount: number };
            runCount += impact.runCount;
            diffCount += impact.diffCount;
            for (const blocker of this.projectDeletionBlockers(project))
                blockers.add(blocker);
        }
        if (
            this.db
                .prepare(
                    "SELECT 1 FROM task_input_delete_holds WHERE owner=? AND spaceId=? AND state='held'",
                )
                .get(owner, spaceId)
        )
            blockers.add('project_busy');
        return { runCount, diffCount, blockers: [...blockers] };
    }

    hasActiveTaskRetry(id: string) {
        return this.pendingTaskRetry(id);
    }

    taskRetryReceipt(id: string, key: string) {
        return this.retryByKey(id, key);
    }

    nextTaskRetry(afterRowId: number) {
        return this.db
            .prepare(
                `SELECT rowid AS rowId,* FROM retry_attempts
            WHERE phase IN ('preparing','workspace_restored','history_restored')
            ORDER BY (rowid<=?),rowid LIMIT 1`,
            )
            .get(afterRowId) as (RetryAttempt & { rowId: number }) | undefined;
    }

    recordTaskCheckpoint(
        runId: string,
        files: readonly FileText[],
        workspaceSha256: string,
        historySha256: string,
    ) {
        return this.evidence.recordTaskCheckpoint(
            runId,
            files,
            workspaceSha256,
            historySha256,
        );
    }

    taskCheckpoint(runId: string) {
        return this.evidence.taskCheckpoint(runId);
    }

    recordTaskAdmission(runId: string, generation: number, digest: string) {
        return this.evidence.recordTaskAdmission(runId, generation, digest);
    }

    taskExit(runId: string, generation: number) {
        return this.evidence.taskExit(runId, generation);
    }

    recordTaskExit(
        runId: string,
        generation: number,
        bindingDigest: string,
        exitedAt: string,
    ) {
        return this.evidence.recordTaskExit(
            runId,
            generation,
            bindingDigest,
            exitedAt,
        );
    }

    listPendingRunReviews(): readonly { runId: string; updatedAt: string }[] {
        return this.db
            .prepare(
                "SELECT id AS runId, updatedAt FROM runs WHERE taskSequence IS NOT NULL AND status='needs_review' ORDER BY id",
            )
            .all()
            .map((row) => ({
                runId: row.runId as string,
                updatedAt: row.updatedAt as string,
            }));
    }

    readTaskClosure(runId: string) {
        return this.evidence.readTaskClosure(runId);
    }

    closeTaskRun(
        runId: string,
        decision: 'failed' | 'unconfirmed',
        generation: number,
        stopDigest: string,
    ) {
        return this.evidence.closeTaskRun(
            runId,
            decision,
            generation,
            stopDigest,
        );
    }

    private hasQueueCapacity(owner: string) {
        const count = this.db
            .prepare(
                `SELECT (
                (SELECT count(*) FROM projects p JOIN runs r ON r.projectId=p.id WHERE p.owner=? AND r.status IN ('queued','pending_approval')) +
                (SELECT count(*) FROM tasks t JOIN retry_attempts a ON a.taskId=t.id WHERE t.owner=? AND a.phase IN ${pendingRetries})
            ) AS value`,
            )
            .get(owner, owner)?.value as number;
        return count < this.tenantQueueLimit;
    }

    acquireFileDeleteHold(
        owner: string,
        projectId: string,
        operationId: string,
    ): FileDeleteHold {
        return this.write(() => {
            const project = this.ownedProject(owner, projectId);
            const prior = this.db
                .prepare(
                    'SELECT state FROM file_delete_holds WHERE projectId=? AND operationId=?',
                )
                .get(projectId, operationId) as FileDeleteHold | undefined;
            if (this.isProjectDeleting(projectId)) throw missing();
            if (prior) return prior;
            this.requireOpenOwner(owner);
            const busy = this.db
                .prepare(
                    `SELECT 1 FROM runs WHERE projectId=? AND status IN ${pending}`,
                )
                .get(projectId);
            const state =
                project.status === 'importing' || busy ? 'denied' : 'held';
            this.db
                .prepare(
                    'INSERT INTO file_delete_holds (projectId,operationId,state) VALUES (?,?,?)',
                )
                .run(projectId, operationId, state);
            return { state };
        });
    }

    releaseFileDeleteHold(
        owner: string,
        projectId: string,
        operationId: string,
    ): FileDeleteHold {
        return this.write(() => {
            this.ownedProject(owner, projectId);
            this.db
                .prepare(
                    `
                INSERT INTO file_delete_holds (projectId,operationId,state) VALUES (?,?,'released')
                ON CONFLICT(projectId,operationId) DO UPDATE SET state='released'
            `,
                )
                .run(projectId, operationId);
            return { state: 'released' };
        });
    }

    requireRunProject(owner: string, projectId: string): void {
        this.ownedProject(owner, projectId);
        if (
            this.isProjectDeleting(projectId) ||
            this.inputDeletionHeld(projectId)
        )
            throw conflict('project_busy', 'Project deletion is in progress.');
    }

    hasPendingProjectRun(projectId: string) {
        return !!this.db
            .prepare(
                `SELECT 1 FROM runs WHERE projectId=? AND status IN ${pending}`,
            )
            .get(projectId);
    }

    addRun(
        owner: string,
        projectId: string,
        key: string,
        prompt: string,
        sessionId?: string,
        validateSession?: (binding: Binding) => void,
    ) {
        const enqueue = () =>
            this.enqueueRun(
                owner,
                projectId,
                key,
                prompt,
                false,
                sessionId,
                validateSession,
            );
        return this.goControl ? enqueue() : this.write(enqueue);
    }

    private enqueueRun(
        owner: string,
        projectId: string,
        key: string,
        prompt: string,
        task = false,
        sessionId?: string,
        validateSession?: (binding: Binding) => void,
    ) {
        if (!task) this.requireRunProject(owner, projectId);
        this.requireOpenOwner(owner);
        const project = this.ownedProject(owner, projectId, task);
        const selectedSession = sessionId ?? project.sessionId;
        const previous = this.db
            .prepare('SELECT * FROM runs WHERE projectId=? AND key=?')
            .get(projectId, key) as Run | undefined;
        if (previous) {
            if (
                previous.prompt !== prompt ||
                previous.sessionId !== selectedSession
            )
                throw conflict(
                    'idempotency_conflict',
                    'Idempotency-Key already belongs to a different input.',
                );
            return { replay: true, run: runView(previous) };
        }
        if (
            this.db
                .prepare(
                    "SELECT 1 FROM file_delete_holds WHERE projectId=? AND state='held'",
                )
                .get(projectId)
        )
            throw conflict('project_busy', 'A project file is being deleted.');
        if (project.status !== 'ready')
            throw conflict('project_not_ready', 'Project is not ready.');
        if (
            this.db
                .prepare(
                    `SELECT 1 FROM runs WHERE projectId=? AND status IN ${pending}`,
                )
                .get(projectId)
        )
            throw conflict(
                'project_busy',
                'Project already has an unfinished Run.',
            );
        validateSession?.({
            ...projectBinding(project),
            session: selectedSession,
        });
        const id = randomUUID();
        const created = now();
        if (this.goControl) {
            if (
                this.business('enqueue', {
                    run: id,
                    session: selectedSession,
                    project: projectId,
                    owner,
                    key,
                    prompt,
                    task,
                    requireApproval: task && this.requireTaskRunApproval,
                    body: task
                        ? JSON.stringify({
                              kind: 'user_message',
                              text: prompt,
                              check: null,
                          })
                        : '',
                    queueLimit: this.tenantQueueLimit,
                }) !== true
            )
                throw queueFull();
            return { replay: false, run: runView(this.findRun(id)) };
        }
        const result = this.db
            .prepare(
                `
                INSERT INTO runs(id,projectId,sessionId,key,prompt,status,createdAt,updatedAt)
                SELECT ?,?,?,?,?,'queued',?,?
                WHERE ?
            `,
            )
            .run(
                id,
                projectId,
                selectedSession,
                key,
                prompt,
                created,
                created,
                Number(this.hasQueueCapacity(owner)),
            );
        if (result.changes !== 1)
            throw new RequestError(
                429,
                'tenant_queue_full',
                'Tenant queue is full. Retry after a Run is claimed.',
            );
        return { replay: false, run: runView(this.findRun(id)) };
    }

    findRun(id: string) {
        const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
        if (!row) throw missing();
        return row as Run;
    }

    private ownedRun(owner: string, project: string, id: string) {
        this.project(owner, project);
        const row = this.db
            .prepare('SELECT * FROM runs WHERE id=? AND projectId=?')
            .get(id, project);
        if (!row) throw missing();
        return row as Run;
    }

    runs(owner: string, project: string) {
        this.project(owner, project);
        return (
            this.db
                .prepare('SELECT * FROM runs WHERE projectId=? ORDER BY rowid')
                .all(project) as Run[]
        ).map(runView);
    }

    run(owner: string, project: string, id: string) {
        const run = this.ownedRun(owner, project, id);
        return { ...runView(run), prompt: run.prompt };
    }

    cancelQueuedRun(owner: string, project: string, id: string, task = false) {
        if (this.goControl) {
            const current = task
                ? this.taskRunRow(owner, project, id)
                : this.ownedRun(owner, project, id);
            if (
                current.status !== 'cancelled' &&
                this.business('cancel-queued', { run: id, project }) !== true
            )
                throw conflict(
                    'run_not_cancellable',
                    'The Run cannot be cancelled in its current state.',
                );
            return { ...runView(this.findRun(id)), prompt: current.prompt };
        }
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const current = task
                ? this.taskRunRow(owner, project, id)
                : this.ownedRun(owner, project, id);
            if (current.status !== 'cancelled') {
                const result = this.db
                    .prepare(
                        "UPDATE runs SET status='cancelled', summary=?, updatedAt=? WHERE id=? AND projectId=? AND status IN ('queued','pending_approval')",
                    )
                    .run('Cancelled before start.', now(), id, project);
                if (result.changes !== 1)
                    throw conflict(
                        'run_not_cancellable',
                        'The Run cannot be cancelled in its current state.',
                    );
            }
            const run = task
                ? { ...runView(this.findRun(id)), prompt: current.prompt }
                : this.run(owner, project, id);
            this.db.exec('COMMIT');
            return run;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    requestRunningCancellation(
        owner: string,
        project: string,
        id: string,
        generation: number,
        task = false,
    ) {
        if (this.goControl) {
            const current = task
                ? this.taskRunRow(owner, project, id)
                : this.ownedRun(owner, project, id);
            if (
                (current.cancelGeneration === null ||
                    !['cancelling', 'cancelled', 'needs_review'].includes(
                        current.status,
                    )) &&
                this.business('request-cancel', {
                    run: id,
                    project,
                    generation,
                }) !== true
            )
                throw conflict(
                    'run_not_cancellable',
                    'The Run cannot be cancelled in its current state.',
                );
            return { ...runView(this.findRun(id)), prompt: current.prompt };
        }
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const current = task
                ? this.taskRunRow(owner, project, id)
                : this.ownedRun(owner, project, id);
            if (
                current.cancelGeneration === null ||
                !['cancelling', 'cancelled', 'needs_review'].includes(
                    current.status,
                )
            ) {
                const result = this.db
                    .prepare(
                        "UPDATE runs SET status='cancelling', cancelGeneration=?, cancelWorkerClosed=?, summary=?, updatedAt=? WHERE id=? AND projectId=? AND status='running' AND receipt=0",
                    )
                    .run(
                        generation,
                        generation === 0 ? 1 : 0,
                        'Cancellation requested.',
                        now(),
                        id,
                        project,
                    );
                if (result.changes !== 1)
                    throw conflict(
                        'run_not_cancellable',
                        'The Run cannot be cancelled in its current state.',
                    );
            }
            const run = task
                ? { ...runView(this.findRun(id)), prompt: current.prompt }
                : this.run(owner, project, id);
            this.db.exec('COMMIT');
            return run;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    markCancellationWorkerClosed(id: string, generation: number): void {
        if (
            this.business('cancel-closed', { run: id, generation }) !==
            undefined
        )
            return;
        this.db
            .prepare(
                "UPDATE runs SET cancelWorkerClosed=1 WHERE id=? AND cancelGeneration=? AND status='cancelling'",
            )
            .run(id, generation);
    }

    finishCancellation(
        id: string,
        generation: number,
        status: 'cancelled' | 'needs_review',
    ): boolean {
        const summary =
            status === 'cancelled'
                ? 'Run stopped and cancelled.'
                : '旧执行已停止，操作结果未确认，等待核对。';
        const result = this.business('finish-cancel', {
            run: id,
            generation,
            status,
            summary,
        });
        if (result !== undefined) return result === true;
        return (
            this.db
                .prepare(
                    "UPDATE runs SET status=?, summary=?, updatedAt=?, diff=NULL WHERE id=? AND cancelGeneration=? AND status='cancelling' AND cancelWorkerClosed=1",
                )
                .run(status, summary, now(), id, generation).changes === 1
        );
    }

    failQueuedBaseline(id: string): void {
        if (this.business('fail-baseline', { run: id }) !== undefined) return;
        this.db
            .prepare(
                "UPDATE runs SET status='failed', summary=?, updatedAt=? WHERE id=? AND status='queued'",
            )
            .run('Workspace baseline could not be captured.', now(), id);
    }

    diff(owner: string, project: string, id: string) {
        const row = this.ownedRun(owner, project, id);
        if (row.status !== 'succeeded' || row.diff === null)
            throw conflict(
                'diff_unavailable',
                'The Run result is not available.',
            );
        return row.diff;
    }

    importing() {
        return this.db
            .prepare(
                "SELECT * FROM projects WHERE status='importing' ORDER BY rowid LIMIT 1",
            )
            .get() as Project | undefined;
    }

    importResult(
        id: string,
        status: 'ready' | 'failed',
        reason: string | null = null,
    ) {
        this.write(() => {
            this.db
                .prepare(
                    "UPDATE projects SET status=?, source=CASE WHEN EXISTS(SELECT 1 FROM tasks WHERE id=projects.id) THEN source ELSE NULL END WHERE id=? AND status='importing'",
                )
                .run(status, id);
            this.db
                .prepare(
                    'UPDATE tasks SET prepareError=?,updatedAt=? WHERE id=?',
                )
                .run(reason, now(), id);
        });
    }

    dispatchSnapshot(slots: number) {
        const occupied = this.db
            .prepare(
                `
            SELECT p.owner, r.status FROM runs r JOIN projects p ON p.id=r.projectId
            LEFT JOIN run_dispatches d ON d.runId=r.id
            WHERE r.status IN ('running','recovering','cancelling')
               OR (r.status='queued' AND d.runId IS NOT NULL)
               OR EXISTS (SELECT 1 FROM run_slot_leases l WHERE l.runId=r.id)
            ORDER BY r.rowid
        `,
            )
            .all() as { owner: string; status: string }[];
        const queued = this.db
            .prepare(
                `
            SELECT r.id, p.owner FROM runs r JOIN projects p ON p.id=r.projectId
            WHERE r.status='queued' AND NOT EXISTS (
                SELECT 1 FROM run_dispatches d WHERE d.runId=r.id
            ) ORDER BY r.rowid
        `,
            )
            .all() as { id: string; owner: string }[];
        return { slots, occupied, queued };
    }

    reserveDispatch(id: string, slots: number) {
        const result = this.business('reserve', { run: id, slots });
        if (result !== undefined) return result === true;
        return (
            this.db
                .prepare(
                    `
            WITH occupied AS (
                SELECT p.owner, r.status FROM runs r JOIN projects p ON p.id=r.projectId
                LEFT JOIN run_dispatches d ON d.runId=r.id
                WHERE r.status IN ('running','recovering','cancelling')
                   OR (r.status='queued' AND d.runId IS NOT NULL)
            )
            INSERT INTO run_dispatches(runId)
            SELECT r.id FROM runs r JOIN projects p ON p.id=r.projectId
            WHERE r.id=? AND r.status='queued'
                AND NOT EXISTS (SELECT 1 FROM run_dispatches d WHERE d.runId=r.id)
                AND NOT EXISTS (
                    SELECT 1 FROM occupied o WHERE o.owner=p.owner AND o.status='queued'
                )
                AND (SELECT COUNT(*) FROM occupied) < ?
        `,
                )
                .run(id, slots).changes === 1
        );
    }

    dispatchReserved(id: string) {
        return (
            this.db
                .prepare('SELECT 1 FROM run_dispatches WHERE runId=?')
                .get(id) !== undefined
        );
    }

    schedulableRuns() {
        return this.db
            .prepare(
                `
                SELECT r.id FROM runs r LEFT JOIN run_dispatches d ON d.runId=r.id
                WHERE r.status IN ('running','recovering','cancelling')
                   OR (r.status='queued' AND d.runId IS NOT NULL)
                ORDER BY r.status='queued', d.rowid, r.rowid
                `,
            )
            .all()
            .map((row) => row.id as string);
    }

    next(status: 'active' | 'queued') {
        const condition =
            status === 'active'
                ? "IN ('running','recovering','cancelling')"
                : "= 'queued'";
        return this.db
            .prepare(
                `SELECT * FROM runs WHERE status ${condition} ORDER BY rowid LIMIT 1`,
            )
            .get() as Run | undefined;
    }

    binding(run: Run) {
        const row = this.db
            .prepare('SELECT * FROM projects WHERE id=?')
            .get(run.projectId) as Project;
        return projectBinding(row);
    }

    pendingCapture() {
        return this.db
            .prepare(
                `SELECT * FROM runs WHERE status='needs_review' AND receipt=1
                 ORDER BY updatedAt, rowid LIMIT 1`,
            )
            .get() as Run | undefined;
    }

    start(id: string, baseline: readonly FileText[], slots: number) {
        const result = this.business('start', {
            run: id,
            baseline: JSON.stringify(baseline),
            slots,
        });
        if (result !== undefined) return result === true;
        return (
            this.db
                .prepare(
                    `
                UPDATE runs SET status='running', baseline=?, updatedAt=?
                WHERE id=? AND status='queued'
                    AND (SELECT COUNT(*) FROM runs WHERE status IN ('running','recovering','cancelling')) < ?
            `,
                )
                .run(JSON.stringify(baseline), now(), id, slots).changes === 1
        );
    }

    received(id: string) {
        if (this.business('receipt', { run: id }) !== undefined) return;
        this.db
            .prepare(
                "UPDATE runs SET receipt=1, updatedAt=? WHERE id=? AND status='running'",
            )
            .run(now(), id);
    }

    reconciled(id: string) {
        if (this.business('reconcile', { run: id }) !== undefined) return;
        this.db
            .prepare(
                "UPDATE runs SET reconciled=1, updatedAt=? WHERE id=? AND status='recovering'",
            )
            .run(now(), id);
    }

    recovered(id: string, generation: number) {
        if (this.business('recovered', { run: id, generation }) !== undefined)
            return;
        this.db
            .prepare('INSERT INTO run_recoveries VALUES (?,?)')
            .run(id, generation);
    }

    recoveryGeneration(id: string) {
        return this.db
            .prepare('SELECT generation FROM run_recoveries WHERE runId=?')
            .get(id)?.generation;
    }

    status(
        id: string,
        status: RunStatus,
        summary: string,
        diff: string | null = null,
    ) {
        if (
            this.business('status', { run: id, status, summary, diff }) !==
            undefined
        )
            return;
        this.db
            .prepare(
                'UPDATE runs SET status=?, summary=?, diff=?, updatedAt=? WHERE id=?',
            )
            .run(status, summary, diff, now(), id);
    }

    private business(
        action: string,
        input: object,
    ): boolean | number | undefined {
        if (!this.goControl) return undefined;
        try {
            const result: unknown = JSON.parse(
                execFileSync(this.goControl, ['business', this.path, action], {
                    input: JSON.stringify(input),
                    encoding: 'utf8',
                    timeout: 7000,
                    maxBuffer: 4096,
                    stdio: ['pipe', 'pipe', 'pipe'],
                }),
            );
            if (typeof result !== 'boolean' && typeof result !== 'number')
                throw new Error('invalid result');
            return result;
        } catch {
            throw new Error('Go Run authority denied or unavailable');
        }
    }

    acquireRunSlot(run: string, slots: number): number | undefined {
        const slot = this.business('acquire', { run, slots });
        if (slot === undefined || typeof slot === 'number') return slot;
        throw new Error('Invalid slot result');
    }

    releaseRunSlot(run: string) {
        this.business('release', { run });
    }

    resumeRunAdmission() {
        this.business('resume-admission', {});
    }

    beginRunDrain() {
        this.business('begin-drain', {});
    }

    reviewReceipt(id: string, proof: string) {
        const row = this.db
            .prepare('SELECT proof FROM run_reviews WHERE runId=?')
            .get(id);
        if (row && row.proof !== proof)
            throw conflict(
                'review_conflict',
                'A different review was already recorded.',
            );
        return row !== undefined;
    }

    confirmReview(id: string, proof: string, diff: string) {
        if (this.goControl) {
            if (!this.reviewReceipt(id, proof))
                this.business('confirm-review', {
                    run: id,
                    proof,
                    diff,
                    createdAt: now(),
                });
            return;
        }
        this.db.exec('BEGIN IMMEDIATE');
        try {
            if (!this.reviewReceipt(id, proof)) {
                const time = now();
                const result = this.db
                    .prepare(
                        `
                    UPDATE runs SET status='succeeded', diff=?, updatedAt=?,
                        summary='Workspace changes verified after recovery.'
                    WHERE id=? AND status='needs_review' AND receipt=0
                        AND EXISTS(SELECT 1 FROM run_recoveries WHERE runId=runs.id)
                `,
                    )
                    .run(diff, time, id);
                if (Number(result.changes) !== 1)
                    throw conflict(
                        'review_unavailable',
                        'Run is not awaiting recovery review.',
                    );
                this.db
                    .prepare('INSERT INTO run_reviews VALUES (?,?,?)')
                    .run(id, proof, time);
            }
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
}
