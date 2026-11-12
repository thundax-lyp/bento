import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { conflict, missing, RequestError } from './input.ts';
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
};

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
const pending = "('queued','running','recovering','cancelling','needs_review')";

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

    private readonly tenantQueueLimit: number;

    constructor(path: string, tenantQueueLimit = 16) {
        this.tenantQueueLimit = tenantQueueLimit;
        this.db = new DatabaseSync(path);
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
            CREATE TABLE IF NOT EXISTS project_requests (
                owner TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL,
                projectId TEXT NOT NULL REFERENCES projects(id), PRIMARY KEY(owner,key)
            );
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), sessionId TEXT NOT NULL,
                key TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL,
                createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, summary TEXT,
                baseline TEXT, receipt INTEGER NOT NULL DEFAULT 0, reconciled INTEGER NOT NULL DEFAULT 0, diff TEXT,
                cancelGeneration INTEGER, cancelWorkerClosed INTEGER NOT NULL DEFAULT 0,
                UNIQUE(projectId,key)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS one_pending_run_per_project
                ON runs(projectId) WHERE status IN ${pending};
            DROP INDEX IF EXISTS one_active_host_run;
            CREATE TABLE IF NOT EXISTS run_dispatches (
                runId TEXT PRIMARY KEY REFERENCES runs(id)
            );
            CREATE TABLE IF NOT EXISTS run_reviews (
                runId TEXT PRIMARY KEY REFERENCES runs(id), proof TEXT NOT NULL, reviewedAt TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS run_recoveries (
                runId TEXT PRIMARY KEY REFERENCES runs(id), generation INTEGER NOT NULL
            );
        `);
    }

    close() {
        this.db.close();
    }

    drainOwner(owner: string) {
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
                `SELECT 1 FROM projects p WHERE p.owner = ? AND
              (p.status = 'importing' OR EXISTS (SELECT 1 FROM runs r WHERE r.projectId = p.id AND r.status IN ${pending}))`,
            )
            .get(owner);
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

    purgeProject(binding: Binding) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.ownedProject(binding.tenant, binding.project);
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
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
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

    addProject(owner: string, name: string, files: FileText[]) {
        this.requireOpenOwner(owner);
        const id = randomUUID();
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

    private ownedProject(owner: string, id: string) {
        const row = this.db
            .prepare('SELECT * FROM projects WHERE id=? AND owner=?')
            .get(id, owner);
        if (!row) throw missing();
        return row as Project;
    }

    project(owner: string, id: string) {
        return projectView(this.ownedProject(owner, id));
    }

    projects(owner: string) {
        return (
            this.db
                .prepare('SELECT * FROM projects WHERE owner=? ORDER BY rowid')
                .all(owner) as Project[]
        ).map(projectView);
    }

    addRun(owner: string, projectId: string, key: string, prompt: string) {
        this.requireOpenOwner(owner);
        const project = this.ownedProject(owner, projectId);
        const previous = this.db
            .prepare('SELECT * FROM runs WHERE projectId=? AND key=?')
            .get(projectId, key) as Run | undefined;
        if (previous) {
            if (previous.prompt !== prompt)
                throw conflict(
                    'idempotency_conflict',
                    'Idempotency-Key already belongs to a different input.',
                );
            return { replay: true, run: runView(previous) };
        }
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
        const id = randomUUID();
        const created = now();
        const result = this.db
            .prepare(
                `
                INSERT INTO runs(id,projectId,sessionId,key,prompt,status,createdAt,updatedAt)
                SELECT ?,?,?,?,?,'queued',?,?
                WHERE (
                    SELECT COUNT(*) FROM projects p JOIN runs r ON r.projectId=p.id
                    WHERE p.owner=? AND r.status='queued'
                ) < ?
            `,
            )
            .run(
                id,
                projectId,
                project.sessionId,
                key,
                prompt,
                created,
                created,
                owner,
                this.tenantQueueLimit,
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
        this.ownedProject(owner, project);
        const row = this.db
            .prepare('SELECT * FROM runs WHERE id=? AND projectId=?')
            .get(id, project);
        if (!row) throw missing();
        return row as Run;
    }

    runs(owner: string, project: string) {
        this.ownedProject(owner, project);
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

    cancelQueuedRun(owner: string, project: string, id: string) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const current = this.ownedRun(owner, project, id);
            if (current.status !== 'cancelled') {
                const result = this.db
                    .prepare(
                        "UPDATE runs SET status='cancelled', summary=?, updatedAt=? WHERE id=? AND projectId=? AND status='queued'",
                    )
                    .run('Cancelled before start.', now(), id, project);
                if (result.changes !== 1)
                    throw conflict(
                        'run_not_cancellable',
                        'The Run cannot be cancelled in its current state.',
                    );
            }
            const run = this.run(owner, project, id);
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
    ) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const current = this.ownedRun(owner, project, id);
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
            const run = this.run(owner, project, id);
            this.db.exec('COMMIT');
            return run;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    markCancellationWorkerClosed(id: string, generation: number): void {
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
        return (
            this.db
                .prepare(
                    "UPDATE runs SET status=?, summary=?, updatedAt=?, diff=NULL WHERE id=? AND cancelGeneration=? AND status='cancelling' AND cancelWorkerClosed=1",
                )
                .run(status, summary, now(), id, generation).changes === 1
        );
    }

    failQueuedBaseline(id: string): void {
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

    importResult(id: string, status: 'ready' | 'failed') {
        this.db
            .prepare(
                "UPDATE projects SET status=?, source=NULL WHERE id=? AND status='importing'",
            )
            .run(status, id);
    }

    dispatchSnapshot(slots: number) {
        const occupied = this.db
            .prepare(
                `
            SELECT p.owner, r.status FROM runs r JOIN projects p ON p.id=r.projectId
            LEFT JOIN run_dispatches d ON d.runId=r.id
            WHERE r.status IN ('running','recovering','cancelling')
               OR (r.status='queued' AND d.runId IS NOT NULL)
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
        this.db
            .prepare(
                "UPDATE runs SET receipt=1, updatedAt=? WHERE id=? AND status='running'",
            )
            .run(now(), id);
    }

    reconciled(id: string) {
        this.db
            .prepare(
                "UPDATE runs SET reconciled=1, updatedAt=? WHERE id=? AND status='recovering'",
            )
            .run(now(), id);
    }

    recovered(id: string, generation: number) {
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
        this.db
            .prepare(
                'UPDATE runs SET status=?, summary=?, diff=?, updatedAt=? WHERE id=?',
            )
            .run(status, summary, diff, now(), id);
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
