import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { conflict } from './input.ts';
import type { FileText } from './types.ts';
import type { Store } from './store.ts';
const sha256 = (value: string) =>
    createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
export class TaskEvidenceStore {
    private readonly db: DatabaseSync;
    private readonly write: <T>(action: () => T) => T;
    private readonly findRun: Store['findRun'];
    constructor(
        db: DatabaseSync,
        write: <T>(action: () => T) => T,
        findRun: Store['findRun'],
    ) {
        this.db = db;
        this.write = write;
        this.findRun = findRun;
    }
    recordStopProof(runId: string, canonicalJson: string) {
        const digest = sha256(canonicalJson);
        return this.write(() => {
            const prior = this.readStopProof(runId);
            if (prior) {
                if (
                    prior.canonicalJson !== canonicalJson ||
                    prior.sha256 !== digest
                )
                    throw new Error('Conflicting stop proof.');
                return prior;
            }
            const createdAt = now();
            this.db
                .prepare('INSERT INTO stop_proofs VALUES (?,?,?,?)')
                .run(runId, canonicalJson, digest, createdAt);
            return { canonicalJson, sha256: digest, createdAt };
        });
    }

    readStopProof(runId: string) {
        return this.db
            .prepare(
                'SELECT canonicalJson,sha256,createdAt FROM stop_proofs WHERE runId=?',
            )
            .get(runId);
    }

    recordTaskCheckpoint(
        runId: string,
        files: readonly FileText[],
        workspaceSha256: string,
        historySha256: string,
    ) {
        const workspace = JSON.stringify(files);
        return this.write(() => {
            const prior = this.taskCheckpoint(runId);
            if (prior) {
                if (
                    prior.workspace !== workspace ||
                    prior.workspaceSha256 !== workspaceSha256 ||
                    prior.historySha256 !== historySha256
                )
                    throw new Error('Task checkpoint conflict.');
                return;
            }
            this.db
                .prepare('INSERT INTO task_run_checkpoints VALUES (?,?,?,?)')
                .run(runId, workspace, workspaceSha256, historySha256);
        });
    }

    taskCheckpoint(runId: string) {
        return this.db
            .prepare(
                'SELECT workspace,workspaceSha256,historySha256 FROM task_run_checkpoints WHERE runId=?',
            )
            .get(runId) as
            | {
                  workspace: string;
                  workspaceSha256: string;
                  historySha256: string;
              }
            | undefined;
    }

    recordTaskAdmission(runId: string, generation: number, digest: string) {
        const admitted = this.db
            .prepare(
                'UPDATE runs SET admittedGeneration=?,admittedBindingDigest=? WHERE id=? AND admittedGeneration IS NULL AND taskSequence IS NOT NULL',
            )
            .run(generation, digest, runId);
        if (admitted.changes !== 1)
            throw new Error('Task execution admission changed');
    }

    taskExit(runId: string, generation: number) {
        return this.db
            .prepare(
                'SELECT bindingDigest,exitedAt FROM worker_exit WHERE runId=? AND generation=?',
            )
            .get(runId, generation) as
            { bindingDigest: string; exitedAt: string } | undefined;
    }

    recordTaskExit(
        runId: string,
        generation: number,
        bindingDigest: string,
        exitedAt: string,
    ) {
        return this.write(() => {
            const row = this.findRun(runId);
            if (
                row.admittedGeneration !== generation ||
                row.admittedBindingDigest !== bindingDigest
            )
                throw new Error('Task execution identity mismatch');
            const prior = this.taskExit(runId, generation);
            if (prior) {
                if (prior.bindingDigest !== bindingDigest)
                    throw new Error('Task exit identity mismatch');
                return prior;
            }
            this.db
                .prepare('INSERT INTO worker_exit VALUES (?,?,?,?)')
                .run(runId, generation, bindingDigest, exitedAt);
            return { bindingDigest, exitedAt };
        });
    }

    readTaskClosure(runId: string) {
        return (
            this.db
                .prepare('SELECT * FROM task_closure_audit WHERE runId=?')
                .get(runId) ?? null
        );
    }

    closeTaskRun(
        runId: string,
        decision: 'failed' | 'unconfirmed',
        generation: number,
        stopDigest: string,
    ) {
        return this.write(() => {
            const prior = this.readTaskClosure(runId);
            if (prior) {
                if (
                    prior.decision !== decision ||
                    prior.authorityGeneration !== generation
                )
                    throw conflict(
                        'review_unavailable',
                        'Closure decision changed.',
                    );
                return;
            }
            const run = this.findRun(runId);
            if (
                run.taskSequence === null ||
                run.status !== 'needs_review' ||
                run.receipt
            )
                throw conflict(
                    'review_unavailable',
                    'Run is not awaiting closure.',
                );
            const time = now();
            this.db
                .prepare('INSERT INTO task_closure_audit VALUES (?,?,?,?,?)')
                .run(runId, decision, generation, stopDigest, time);
            this.db
                .prepare(
                    "UPDATE runs SET status='failed',summary=?,updatedAt=? WHERE id=?",
                )
                .run(
                    decision === 'unconfirmed'
                        ? '执行结果无法确认。'
                        : '可信核对确认执行失败。',
                    time,
                    runId,
                );
            if (decision === 'unconfirmed')
                this.db
                    .prepare(
                        "UPDATE tasks SET closedReason='unconfirmed',updatedAt=? WHERE id=?",
                    )
                    .run(time, run.projectId);
        });
    }
}
