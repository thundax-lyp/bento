import { taskStore } from './tasks.ts';
import type { TaskInput } from './model.ts';
import { projectStore } from './projects.ts';
import { runStore } from './runs.ts';
import {
    type Project,
    type Run,
    type Task,
    type ConfirmedRetryPhase,
    type RetryEvidence,
    type TaskEventPayload,
    type TaskResultInput,
    pending,
    pendingRetries,
    projectBinding,
} from './model.ts';
import { initializeStoreSchema } from './schema.ts';
import { taskProjectionStore } from './task-projection.ts';
import { taskRetryStore } from './task-retry.ts';
import { taskSourceDeletionStore } from './task-source-deletion.ts';
import { TaskEvidenceStore } from './task-evidence.ts';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { conflict } from '../input.ts';
import type { Binding, FileText, RunStatus } from '../types.ts';
export type { TaskInput } from './model.ts';
export { projectBinding } from './model.ts';

export type FileDeleteHold = { state: 'held' | 'denied' | 'released' };

export type ProjectDeletionBlocker = 'project_importing' | 'project_busy';
export type ProjectDeletionReceipt =
    | { state: 'denied'; code: ProjectDeletionBlocker }
    | { state: 'deleting' | 'deleted' };

export class Store {
    private readonly taskProjection: ReturnType<typeof taskProjectionStore>;
    private readonly retries: ReturnType<typeof taskRetryStore>;
    private readonly sourceDeletions: ReturnType<
        typeof taskSourceDeletionStore
    >;
    private readonly projectRecords: ReturnType<typeof projectStore>;
    private readonly runRecords: ReturnType<typeof runStore>;
    private readonly taskRecords: ReturnType<typeof taskStore>;
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
        this.taskProjection = taskProjectionStore({
            db: this.db,
            write: (...args) => this.write(...args),
            findRun: (...args) => this.findRun(...args),
            taskRow: (...args) => this.taskRow(...args),
            recoveryGeneration: (...args) => this.recoveryGeneration(...args),
            goControl: this.goControl,
            business: (...args) => this.business(...args),
        });
        this.retries = taskRetryStore({
            db: this.db,
            write: (...args) => this.write(...args),
            taskRow: (...args) => this.taskRow(...args),
            findRun: (...args) => this.findRun(...args),
            readStopProof: (...args) => this.readStopProof(...args),
            taskWriteGuard: (...args) => this.taskWriteGuard(...args),
            hasQueueCapacity: (...args) => this.hasQueueCapacity(...args),
            goControl: this.goControl,
            business: (...args) => this.business(...args),
            tenantQueueLimit: this.tenantQueueLimit,
            taskSequence: (...args) => this.taskSequence(...args),
            appendTaskEvent: (...args) => this.appendTaskEvent(...args),
        });
        this.sourceDeletions = taskSourceDeletionStore({
            db: this.db,
            write: (...args) => this.write(...args),
            requireOpenOwner: (...args) => this.requireOpenOwner(...args),
            ownedProject: (...args) => this.ownedProject(...args),
            isProjectDeleting: (...args) => this.isProjectDeleting(...args),
            pendingTaskRetry: (...args) => this.pendingTaskRetry(...args),
            projectDeletionBlockers: (...args) =>
                this.projectDeletionBlockers(...args),
            projectHasPendingRun: (...args) =>
                this.projectHasPendingRun(...args),
        });
        this.projectRecords = projectStore({
            db: this.db,
            requireOpenOwner: (...args) => this.requireOpenOwner(...args),
            pendingTaskRetry: (...args) => this.pendingTaskRetry(...args),
            inputDeletionHeld: (...args) => this.inputDeletionHeld(...args),
            taskSourceDeletionBindings: (...args) =>
                this.taskSourceDeletionBindings(...args),
            write: (...args) => this.write(...args),
        });
        this.runRecords = runStore({
            db: this.db,
            business: (...args) => this.business(...args),
            goControl: this.goControl,
            tenantQueueLimit: this.tenantQueueLimit,
            requireTaskRunApproval: this.requireTaskRunApproval,
            write: (...args) => this.write(...args),
            ownedProject: (...args) => this.ownedProject(...args),
            isProjectDeleting: (...args) => this.isProjectDeleting(...args),
            project: (...args) => this.project(...args),
            requireOpenOwner: (...args) => this.requireOpenOwner(...args),
            inputDeletionHeld: (...args) => this.inputDeletionHeld(...args),
            hasQueueCapacity: (...args) => this.hasQueueCapacity(...args),
            taskRunRow: (...args) => this.taskRunRow(...args),
        });
        this.taskRecords = taskStore({
            db: this.db,
            write: (...args) => this.write(...args),
            goControl: this.goControl,
            ownedProject: (...args) => this.ownedProject(...args),
            isProjectDeleting: (...args) => this.isProjectDeleting(...args),
            requireOpenOwner: (...args) => this.requireOpenOwner(...args),
            sourceDeletion: (...args) => this.sourceDeletion(...args),
            addProject: (...args) => this.addProject(...args),
            inputDeletionHeld: (...args) => this.inputDeletionHeld(...args),
            projectHasPendingRun: (...args) =>
                this.projectHasPendingRun(...args),
            pendingTaskRetry: (...args) => this.pendingTaskRetry(...args),
            taskRetryReceipt: (...args) => this.taskRetryReceipt(...args),
            findRun: (...args) => this.findRun(...args),
            enqueueRun: (...args) => this.enqueueRun(...args),
            appendTaskEvent: (...args) => this.appendTaskEvent(...args),
        });
        initializeStoreSchema(this.db);
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
        return this.projectRecords.projectRunIds(project);
    }

    purgeProject(
        binding: Binding,
        operationId?: string,
        sourceSpaceId?: string,
    ) {
        return this.projectRecords.purgeProject(
            binding,
            operationId,
            sourceSpaceId,
        );
    }

    isProjectDeleting(projectId: string): boolean {
        return this.projectRecords.isProjectDeleting(projectId);
    }

    private projectDeletionBlockers(
        project: Project,
    ): ProjectDeletionBlocker[] {
        return this.projectRecords.projectDeletionBlockers(project);
    }

    projectDeletionImpact(owner: string, projectId: string) {
        return this.projectRecords.projectDeletionImpact(owner, projectId);
    }

    beginProjectDeletion(
        owner: string,
        projectId: string,
        operationId: string,
    ): ProjectDeletionReceipt {
        return this.projectRecords.beginProjectDeletion(
            owner,
            projectId,
            operationId,
        );
    }

    projectDeletionBinding(
        owner: string,
        projectId: string,
        operationId: string,
    ): Binding {
        return this.projectRecords.projectDeletionBinding(
            owner,
            projectId,
            operationId,
        );
    }

    hasProjectDeletionInProgress(owner: string): boolean {
        return this.projectRecords.hasProjectDeletionInProgress(owner);
    }

    clearProjectDeletionReceipts(owner: string): void {
        return this.projectRecords.clearProjectDeletionReceipts(owner);
    }

    createProject(
        owner: string,
        name: string,
        files: FileText[],
        key?: string,
    ) {
        return this.projectRecords.createProject(owner, name, files, key);
    }

    addProject(
        owner: string,
        name: string,
        files: FileText[],
        id: string = randomUUID(),
    ) {
        return this.projectRecords.addProject(owner, name, files, id);
    }

    private ownedProject(owner: string, id: string, allowTask = false) {
        return this.projectRecords.ownedProject(owner, id, allowTask);
    }

    project(owner: string, id: string) {
        return this.projectRecords.project(owner, id);
    }

    sharedProjectBinding(owner: string, id: string) {
        return this.projectRecords.sharedProjectBinding(owner, id);
    }

    projects(owner: string) {
        return this.projectRecords.projects(owner);
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
        return this.sourceDeletions.sourceDeletion(owner, spaceId);
    }

    private taskRow(owner: string, taskId: string) {
        return this.taskRecords.taskRow(owner, taskId);
    }

    task(owner: string, taskId: string) {
        return this.taskRecords.task(owner, taskId);
    }

    tasks(owner: string, creationKey?: string) {
        return this.taskRecords.tasks(owner, creationKey);
    }

    createTask(
        owner: string,
        key: string,
        input: TaskInput,
        environmentVersion: string,
    ) {
        return this.taskRecords.createTask(
            owner,
            key,
            input,
            environmentVersion,
        );
    }

    private taskWriteGuard(owner: string, task: Task) {
        return this.taskRecords.taskWriteGuard(owner, task);
    }

    private pendingTaskRetry(taskId: string) {
        return this.retries.pendingTaskRetry(taskId);
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
        return this.taskRecords.taskSequence(taskId);
    }

    enqueueTaskRun(owner: string, taskId: string, key: string, prompt: string) {
        return this.taskRecords.enqueueTaskRun(owner, taskId, key, prompt);
    }

    acceptTaskRetry(
        owner: string,
        taskId: string,
        sourceRunId: string,
        key: string,
        evidence: RetryEvidence,
    ) {
        return this.retries.acceptTaskRetry(
            owner,
            taskId,
            sourceRunId,
            key,
            evidence,
        );
    }

    taskRetry(id: string) {
        return this.retries.taskRetry(id);
    }

    advanceTaskRetry(
        id: string,
        expected: ConfirmedRetryPhase,
        phase: 'workspace_restored' | 'history_restored' | 'blocked',
    ) {
        return this.retries.advanceTaskRetry(id, expected, phase);
    }

    finalizeTaskRetry(id: string, phase: 'history_restored' | 'blocked') {
        return this.retries.finalizeTaskRetry(id, phase);
    }

    closeBlockedTaskRetry(
        id: string,
        authorityGeneration: number,
        evidenceDigest: string,
    ) {
        return this.retries.closeBlockedTaskRetry(
            id,
            authorityGeneration,
            evidenceDigest,
        );
    }

    readTaskRetryClosure(id: string) {
        return this.retries.readTaskRetryClosure(id);
    }

    private appendTaskEvent(
        taskId: string,
        runId: string,
        eventId: string,
        value: TaskEventPayload,
    ) {
        return this.taskProjection.appendTaskEvent(
            taskId,
            runId,
            eventId,
            value,
        );
    }

    appendTaskEvents(
        taskId: string,
        runId: string,
        generation: number,
        events: readonly (TaskEventPayload & { offset: number })[],
    ) {
        return this.taskProjection.appendTaskEvents(
            taskId,
            runId,
            generation,
            events,
        );
    }

    taskEvents(owner: string, taskId: string, after: number) {
        return this.taskProjection.taskEvents(owner, taskId, after);
    }

    publishTaskResult(
        runId: string,
        input: TaskResultInput,
        reviewProof?: string,
    ) {
        return this.taskProjection.publishTaskResult(runId, input, reviewProof);
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
        return this.sourceDeletions.acquireTaskInputDeleteHold(
            owner,
            spaceId,
            fileId,
            operationId,
            legacyProjectId,
        );
    }

    releaseTaskInputDeleteHold(
        owner: string,
        spaceId: string,
        fileId: string,
        operationId: string,
        legacyProjectId: string | null,
    ) {
        return this.sourceDeletions.releaseTaskInputDeleteHold(
            owner,
            spaceId,
            fileId,
            operationId,
            legacyProjectId,
        );
    }

    changeTaskSourceDeletion(
        owner: string,
        spaceId: string,
        operationId: string,
        legacyProjectId: string | null,
        phase: 'hold' | 'commit' | 'release',
    ) {
        return this.sourceDeletions.changeTaskSourceDeletion(
            owner,
            spaceId,
            operationId,
            legacyProjectId,
            phase,
        );
    }

    taskSourceDeletionBindings(
        owner: string,
        spaceId: string,
        operationId: string,
    ) {
        return this.sourceDeletions.taskSourceDeletionBindings(
            owner,
            spaceId,
            operationId,
        );
    }

    finishTaskSourceDeletion(
        owner: string,
        spaceId: string,
        operationId: string,
    ) {
        return this.sourceDeletions.finishTaskSourceDeletion(
            owner,
            spaceId,
            operationId,
        );
    }

    taskConfig(taskId: string) {
        return this.taskRecords.taskConfig(taskId);
    }

    prepareTask(owner: string, id: string) {
        return this.taskRecords.prepareTask(owner, id);
    }

    taskInitialFiles(taskId: string) {
        return this.taskRecords.taskInitialFiles(taskId);
    }

    taskRunRows(owner: string, id: string) {
        return this.taskRecords.taskRunRows(owner, id);
    }

    taskRunRow(owner: string, id: string, runId: string) {
        return this.taskRecords.taskRunRow(owner, id, runId);
    }

    taskResultRow(runId: string) {
        return this.taskProjection.taskResultRow(runId);
    }

    taskSourceImpact(
        owner: string,
        spaceId: string,
        legacyProjectId: string | null,
    ) {
        return this.sourceDeletions.taskSourceImpact(
            owner,
            spaceId,
            legacyProjectId,
        );
    }

    hasActiveTaskRetry(id: string) {
        return this.pendingTaskRetry(id);
    }

    taskRetryReceipt(id: string, key: string) {
        return this.retries.taskRetryReceipt(id, key);
    }

    nextTaskRetry(afterRowId: number) {
        return this.retries.nextTaskRetry(afterRowId);
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
        return this.projectRecords.acquireFileDeleteHold(
            owner,
            projectId,
            operationId,
        );
    }

    releaseFileDeleteHold(
        owner: string,
        projectId: string,
        operationId: string,
    ): FileDeleteHold {
        return this.projectRecords.releaseFileDeleteHold(
            owner,
            projectId,
            operationId,
        );
    }

    requireRunProject(owner: string, projectId: string): void {
        return this.runRecords.requireRunProject(owner, projectId);
    }

    hasPendingProjectRun(projectId: string) {
        return this.runRecords.hasPendingProjectRun(projectId);
    }

    addRun(
        owner: string,
        projectId: string,
        key: string,
        prompt: string,
        sessionId?: string,
        validateSession?: (binding: Binding) => void,
    ) {
        return this.runRecords.addRun(
            owner,
            projectId,
            key,
            prompt,
            sessionId,
            validateSession,
        );
    }

    addDiagnosticRun(
        owner: string,
        project: string,
        key: string,
        prompt: string,
        validateSession?: (binding: Binding) => void,
    ) {
        return this.runRecords.addDiagnosticRun(
            owner,
            project,
            key,
            prompt,
            validateSession,
        );
    }

    diagnosticRun(owner: string, project: string, id: string) {
        return this.runRecords.diagnosticRun(owner, project, id);
    }

    private enqueueRun(
        owner: string,
        projectId: string,
        key: string,
        prompt: string,
        task = false,
        sessionId?: string,
        validateSession?: (binding: Binding) => void,
        diagnostic = false,
    ) {
        return this.runRecords.enqueueRun(
            owner,
            projectId,
            key,
            prompt,
            task,
            sessionId,
            validateSession,
            diagnostic,
        );
    }

    findRun(id: string) {
        return this.runRecords.findRun(id);
    }

    runs(owner: string, project: string) {
        return this.runRecords.runs(owner, project);
    }

    run(owner: string, project: string, id: string) {
        return this.runRecords.run(owner, project, id);
    }

    cancelQueuedRun(owner: string, project: string, id: string, task = false) {
        return this.runRecords.cancelQueuedRun(owner, project, id, task);
    }

    requestRunningCancellation(
        owner: string,
        project: string,
        id: string,
        generation: number,
        task = false,
    ) {
        return this.runRecords.requestRunningCancellation(
            owner,
            project,
            id,
            generation,
            task,
        );
    }

    markCancellationWorkerClosed(id: string, generation: number): void {
        return this.runRecords.markCancellationWorkerClosed(id, generation);
    }

    finishCancellation(
        id: string,
        generation: number,
        status: 'cancelled' | 'needs_review',
    ): boolean {
        return this.runRecords.finishCancellation(id, generation, status);
    }

    failQueuedBaseline(id: string): void {
        return this.runRecords.failQueuedBaseline(id);
    }

    diff(owner: string, project: string, id: string) {
        return this.runRecords.diff(owner, project, id);
    }

    importing() {
        return this.projectRecords.importing();
    }

    importResult(
        id: string,
        status: 'ready' | 'failed',
        reason: string | null = null,
    ) {
        return this.projectRecords.importResult(id, status, reason);
    }

    reserveDispatch(id: string, slots: number) {
        return this.runRecords.reserveDispatch(id, slots);
    }

    dispatchReserved(id: string) {
        return this.runRecords.dispatchReserved(id);
    }

    next(status: 'active' | 'queued') {
        return this.runRecords.next(status);
    }

    binding(run: Run) {
        return this.runRecords.binding(run);
    }

    pendingCapture() {
        return this.runRecords.pendingCapture();
    }

    start(id: string, baseline: readonly FileText[], slots: number) {
        return this.runRecords.start(id, baseline, slots);
    }

    received(id: string) {
        return this.runRecords.received(id);
    }

    reconciled(id: string) {
        return this.runRecords.reconciled(id);
    }

    recovered(id: string, generation: number) {
        return this.runRecords.recovered(id, generation);
    }

    recoveryGeneration(id: string) {
        return this.runRecords.recoveryGeneration(id);
    }

    status(
        id: string,
        status: RunStatus,
        summary: string,
        diff: string | null = null,
    ) {
        return this.runRecords.status(id, status, summary, diff);
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
        if (this.business('resume-admission', {}) === undefined)
            this.db.exec('DELETE FROM run_admission_drain');
    }

    beginRunDrain() {
        if (this.business('begin-drain', {}) === undefined)
            this.db.exec(
                'INSERT OR IGNORE INTO run_admission_drain VALUES (1)',
            );
    }

    reviewReceipt(id: string, proof: string) {
        return this.runRecords.reviewReceipt(id, proof);
    }

    confirmReview(id: string, proof: string, diff: string) {
        return this.runRecords.confirmReview(id, proof, diff);
    }
}
