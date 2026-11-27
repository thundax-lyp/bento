import type { DatabaseSync } from 'node:sqlite';
import { pending, pendingRetries } from './model.ts';

export function initializeStoreSchema(db: DatabaseSync) {
    db.exec(`
            PRAGMA busy_timeout=5000;
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
            CREATE TABLE IF NOT EXISTS admin_diagnostic_runs (
                runId TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE
            );
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
