import console from 'node:console';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

const uuidV4 =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha256 = (value) =>
    createHash('sha256').update(value, 'utf8').digest('hex');
const [taskId, runId, ...extra] = process.argv.slice(2);

let db;
try {
    if (extra.length || !uuidV4.test(taskId ?? '') || !uuidV4.test(runId ?? ''))
        throw new Error('Invalid observation identity');

    db = new DatabaseSync('/data/business.sqlite', { readOnly: true });
    const rows = db
        .prepare(
            `
        SELECT r.sessionId, r.status, r.taskSequence, r.admittedGeneration,
               r.admittedBindingDigest, p.owner, p.id,
               p.sessionId AS boundSession, p.sandbox, p.volume
        FROM runs r JOIN projects p ON p.id = r.projectId
        WHERE r.id = ? AND p.id = ?
    `,
        )
        .all(runId, taskId);
    const run = rows[0];
    if (
        rows.length !== 1 ||
        run.status !== 'succeeded' ||
        !Number.isSafeInteger(run.taskSequence) ||
        run.taskSequence < 1 ||
        !Number.isSafeInteger(run.admittedGeneration) ||
        run.admittedGeneration < 0 ||
        run.sessionId !== run.boundSession
    )
        throw new Error('Invalid Run evidence');

    const { count } = db
        .prepare(
            'SELECT COUNT(*) AS count FROM task_projection_ends WHERE runId = ? AND generation = ?',
        )
        .get(runId, run.admittedGeneration);
    const { owner, id, boundSession, sandbox, volume } = run;
    const bindingDigest = sha256(
        JSON.stringify({
            tenant: owner,
            project: id,
            session: boundSession,
            sandbox,
            volume,
        }),
    );
    if (count !== 1 || bindingDigest !== run.admittedBindingDigest)
        throw new Error('Dispatch and projection evidence do not match');

    console.log(
        JSON.stringify({
            taskId,
            runId,
            sessionDigest: sha256(boundSession),
            workspaceDigest: sha256(JSON.stringify({ sandbox, volume })),
            bindingDigest,
        }),
    );
} catch {
    console.error('WEB-A11 observation rejected');
    process.exitCode = 1;
} finally {
    db?.close();
}
