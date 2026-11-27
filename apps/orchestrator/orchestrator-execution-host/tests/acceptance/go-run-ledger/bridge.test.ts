import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { connectGoRunLedger } from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/go-run-ledger.ts';

test('TS commands are persisted by the Go Run ledger controller', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'bento-go-run-ledger-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const binary = join(dir, 'bento-orchestrator');
    const path = join(dir, 'go-runs.sqlite');
    execFileSync('go', ['build', '-o', binary, './src/control'], {
        cwd: fileURLToPath(
            new URL('../../../../orchestrator-control/', import.meta.url),
        ),
        timeout: 120_000,
    });
    const first = await connectGoRunLedger(path, binary);
    try {
        await assert.rejects(connectGoRunLedger(path, binary), /unavailable/);
        const task = {
            ID: 'task',
            Name: 'Workspace diagnostics',
            Binding: {
                Owner: 'owner',
                Workspace: 'workspace',
                Session: 'session',
                Sandbox: 'sandbox',
                Volume: 'volume',
            },
        };
        const input = {
            task,
            runId: 'run',
            key: 'request-key',
            prompt: 'Inspect workspace',
        };
        const initial = await first.call('submitTaskRun', input);
        assert.equal(initial.Replay, false);
        await assert.rejects(
            first.call('consumeStart', {
                runId: 'run',
                attemptId: 'premature',
            }),
            { code: 'transition_refused' },
        );
        assert.equal(
            await first.call('reserveDispatch', { runId: 'run' }),
            'bento-run-run',
        );
        assert.equal(
            await first.call('reserveDispatch', { runId: 'run' }),
            'bento-run-run',
        );
        const replay = await first.call('submitTaskRun', {
            ...input,
            runId: 'proposed-replay-run',
        });
        assert.equal(replay.Run.ID, 'run');
        assert.equal(replay.Sequence, 1);
        assert.equal(replay.Replay, true);
        await assert.rejects(
            first.call('submitTaskRun', { ...input, prompt: 'different' }),
            { code: 'idempotency_conflict' },
        );
        await assert.rejects(
            first.call('task', { owner: 'outside', taskId: task.ID }),
            { code: 'not_found' },
        );
    } finally {
        await first.close();
    }

    // Observe a durable start grant independently while discarding its reply,
    // then terminate the controller process owned by this test.
    const unobserved = spawn(binary, ['run-ledger', path], {
        stdio: ['pipe', 'ignore', 'inherit'],
    });
    const exited = new Promise<void>((resolve, reject) => {
        unobserved.once('close', () => resolve());
        unobserved.once('error', reject);
    });
    unobserved.stdin.on('error', () => {});
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
        unobserved.stdin.write(
            JSON.stringify({
                id: 'lost-reply',
                method: 'consumeStart',
                runId: 'run',
                attemptId: 'a1',
            }) + '\n',
        );
        const status = reader.prepare(
            "SELECT status FROM runs WHERE id = 'run'",
        );
        for (let i = 0; i < 250; i++) {
            if (status.get()?.status === 'starting') break;
            await delay(20);
        }
        assert.equal(status.get()?.status, 'starting');
    } finally {
        reader.close();
        unobserved.kill('SIGKILL');
        await exited;
    }

    const restarted = await connectGoRunLedger(path, binary);
    try {
        const claims = await Promise.all(
            Array.from({ length: 8 }, () =>
                restarted.call('consumeStart', {
                    runId: 'run',
                    attemptId: 'a1',
                }),
            ),
        );
        assert.equal(claims.filter(({ issued }) => issued).length, 0);
        const { attempt } = claims[0]!;
        await restarted.call('markRunning', { attempt });
        const task = await restarted.call('task', {
            owner: 'owner',
            taskId: 'task',
        });
        await restarted.call('admitWorker', { attempt, binding: task.Binding });
        await assert.rejects(
            restarted.call('admitWorker', {
                attempt,
                binding: { ...task.Binding, Volume: 'outside' },
            }),
            { code: 'stale_attempt' },
        );
        let signal!: AbortSignal;
        let opened!: () => void;
        let transportClosed!: () => void;
        const opening = new Promise<void>((resolve) => {
            opened = resolve;
        });
        const transport = new Promise<void>((resolve) => {
            transportClosed = resolve;
        });
        const channel = restarted.workerChannel(
            attempt,
            task.Binding,
            (observed) => {
                signal = observed;
                opened();
                return transport;
            },
        );
        await opening;
        await restarted.revoke(attempt);
        assert.equal(signal.aborted, true);
        let observedClosed = false;
        const closure = restarted.awaitChannelClosure(attempt).then(() => {
            observedClosed = true;
        });
        await delay(10);
        assert.equal(observedClosed, false);
        transportClosed();
        await channel;
        await closure;
        assert.equal(observedClosed, true);
        await assert.rejects(
            restarted.workerChannel(attempt, task.Binding, () => {
                assert.fail('revoked attempt opened a second channel');
            }),
            { code: 'stale_attempt' },
        );
        await assert.rejects(
            restarted.call('admitWorker', { attempt, binding: task.Binding }),
            { code: 'stale_attempt' },
        );
        await assert.rejects(
            restarted.call('recordCompletion', { attempt, reference: 'late' }),
            { code: 'stale_attempt' },
        );
        await restarted.call('markUnknown', { attempt });
        await restarted.call('recordStop', {
            attempt,
            stops: { Host: 'host' },
        });
    } finally {
        await restarted.close();
    }

    const second = await connectGoRunLedger(path, binary);
    try {
        const run = await second.call('run', { runId: 'run' });
        assert.equal(run.Status, 'unknown');
        const attempt = await second.call('attempt', {
            runId: run.ID,
            generation: run.Generation,
        });
        const key = {
            RunID: attempt.RunID,
            ID: attempt.ID,
            Generation: attempt.Generation,
        };
        assert.deepEqual(attempt.Stops, { Host: 'host', Sandbox: '' });
        const outcome = { Status: 'queued', Reference: 'no-effect' } as const;
        await assert.rejects(
            second.call('resolve', { attempt: key, outcome }),
            {
                code: 'transition_refused',
            },
        );
        await second.call('recordStop', {
            attempt: key,
            stops: { Sandbox: 'sandbox' },
        });
        await second.call('resolve', { attempt: key, outcome });
        await second.call('reserveDispatch', { runId: 'run' });
        const next = await second.call('consumeStart', {
            runId: 'run',
            attemptId: 'a2',
        });
        assert.equal(next.issued, true);
        assert.equal(next.attempt.Generation, run.Generation + 1);
        await second.call('markRunning', { attempt: next.attempt });
        await assert.rejects(
            second.call('recordCompletion', {
                attempt: key,
                reference: 'old-generation',
            }),
            { code: 'stale_attempt' },
        );
        await second.call('recordCompletion', {
            attempt: next.attempt,
            reference: 'completion',
        });
        await second.revoke(next.attempt);
        await second.call('recordStop', {
            attempt: next.attempt,
            stops: { Host: 'host-2', Sandbox: 'sandbox-2' },
        });
        await second.call('resolve', {
            attempt: next.attempt,
            outcome: { Status: 'succeeded', Reference: 'completion' },
        });

        const observer = new DatabaseSync(path, { readOnly: true });
        try {
            const row = observer
                .prepare(
                    "SELECT status, generation, owner FROM runs WHERE id = 'run'",
                )
                .get();
            assert.deepEqual(
                { ...row },
                {
                    status: 'succeeded',
                    generation: 2,
                    owner: 'owner',
                },
            );
            assert.equal(
                observer.prepare('SELECT count(*) AS n FROM receipts').get()?.n,
                1,
            );
        } finally {
            observer.close();
        }
    } finally {
        await second.close();
    }
});
