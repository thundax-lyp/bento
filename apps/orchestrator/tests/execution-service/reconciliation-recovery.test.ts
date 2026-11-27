import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { connect, constants, createSecureServer } from 'node:http2';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { localHost } from '@/apps/orchestrator/src/execution-service/local.ts';
import { snapshotSha256 } from '@/apps/orchestrator/src/execution-service/service.ts';
import {
    executionBindingDigest,
    type ExecutionHost,
    type WorkerRequest,
} from '@/apps/orchestrator/src/execution-service/types.ts';
import { until, start } from './fixtures/service.ts';

import { frame, bounded } from '../openshell/binding-grants/fixture.ts';
import { prepareSdk } from '../openshell/binding-grants/sdk.ts';
import {
    taskRetryTestClient,
    taskRetryTestInput,
} from './fixtures/task-retry.ts';

test(
    'trusted SDK selector publishes only the original Task with a persisted UNKNOWN',
    { timeout: 600_000 },
    async (t) => {
        const state = await mkdtemp(join(tmpdir(), 'bento-sdk-review-'));
        t.after(() => rm(state, { recursive: true, force: true }));
        const generated = await prepareSdk();
        t.after(() => generated.dispose());
        const keyPath = join(state, 'key.pem');
        const certPath = join(state, 'cert.pem');
        await promisify(execFile)('openssl', [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-days',
            '1',
            '-subj',
            '/CN=review-fixture',
            '-addext',
            'subjectAltName=IP:127.0.0.1',
            '-keyout',
            keyPath,
            '-out',
            certPath,
        ]);
        const [key, cert] = await Promise.all([
            readFile(keyPath),
            readFile(certPath),
        ]);
        const upstream = createSecureServer({
            key,
            cert,
            ca: cert,
            requestCert: true,
        });
        upstream.listen(0, '127.0.0.1');
        await once(upstream, 'listening');
        const address = upstream.address();
        assert(address && typeof address === 'object');
        const sockets = new Set<import('node:http2').ServerHttp2Session>();
        upstream.on('session', (session) => {
            sockets.add(session);
            session.once('close', () => sockets.delete(session));
            session.on('error', () => {});
        });
        t.after(async () => {
            for (const s of sockets) s.destroy();
            await new Promise<void>((resolve) =>
                upstream.close(() => resolve()),
            );
        });
        const base = localHost(join(state, 'volume'));
        const effects = new Map<string, string>();
        const seen = new Map<string, string>();
        const upstreamStages: (() => void)[] = [];
        let active: WorkerRequest;
        let stage: 'terminal' | 'held';
        const exits = new Map<string, string>();
        const stoppedSessions = new Set<string>();
        let drainDuringRun = false;
        let drainFinished = false;
        let draining: Promise<void> | undefined;
        const rows = (session: string, generation: number) => {
            const db = new DatabaseSync(join(state, 'authority.sqlite'), {
                readOnly: true,
            });
            try {
                return db
                    .prepare(
                        'SELECT id,state FROM operations WHERE session=? AND generation=? ORDER BY rowid',
                    )
                    .all(session, generation);
            } finally {
                db.close();
            }
        };
        upstream.on('stream', (stream) => {
            stream.on('error', () => {});
            stream.resume();
            stream.once('end', () => {
                const reserved = rows(
                    active.binding.session,
                    active.grant.generation,
                ).at(-1);
                assert.equal(
                    reserved?.state,
                    'UNKNOWN',
                    'Reservation is durable on arrival at the upstream',
                );
                assert.match(String(reserved?.id), /^sdk:/);
                if (stage === 'terminal') {
                    stream.respond(
                        { ':status': 200, 'content-type': 'application/grpc' },
                        { waitForTrailers: true },
                    );
                    stream.once('wantTrailers', () =>
                        stream.sendTrailers({ 'grpc-status': '0' }),
                    );
                    stream.end(frame(generated.exit(0)));
                    return;
                }
                effects.set(
                    active.binding.session,
                    '# Fixture\nreviewed SDK effect\n',
                );
                seen.set(active.binding.session, String(reserved!.id));
                upstreamStages.shift()?.();
            });
        });
        const observedHost: ExecutionHost = {
            ...base,
            async stopped(session) {
                const stopped = await base.stopped(session);
                if (stopped) stoppedSessions.add(session.session);
                else stoppedSessions.delete(session.session);
                return stopped;
            },
            async start(session) {
                stoppedSessions.delete(session.session);
                return base.start(session);
            },
            async observeWorkerExit(binding, runId, generation) {
                const exitedAt = exits.get(runId + ':' + generation);
                return exitedAt
                    ? {
                          runId,
                          sessionId: binding.session,
                          generation,
                          bindingDigest: executionBindingDigest(binding),
                          exitedAt,
                      }
                    : null;
            },
            async observeTaskVolumeStopped(binding, runId, generation) {
                if (
                    !exits.has(runId + ':' + generation) ||
                    !stoppedSessions.has(binding.session)
                )
                    return null;
                return {
                    runId,
                    sessionId: binding.session,
                    generation,
                    bindingDigest: executionBindingDigest(binding),
                    restoreIdle: true,
                    sandboxStopped: true,
                    volumeWriters: 0,
                    observedAt: new Date().toISOString(),
                };
            },
            sdk: {
                upstream: new URL('https://127.0.0.1:' + address.port),
                credentials: { cert, ca: cert, key },
                workspace: 'default',
                decode: generated.decode,
                decodeExecEvent: generated.decodeExecEvent,
            },
            async snapshot(binding) {
                const after = effects.get(binding.session);
                return after
                    ? [{ path: 'README.md', text: after }]
                    : base.snapshot(binding);
            },
            async worker(request) {
                if (request.mode === 'recover') return 'recovered';
                active = request;
                assert(request.gateway);
                const transport = connect(request.gateway);
                transport.on('error', () => {});
                try {
                    const open = () => {
                        const call = transport.request({
                            ':method': 'POST',
                            ':path': '/openshell.v1.OpenShell/ExecSandbox',
                            'content-type': 'application/grpc',
                            te: 'trailers',
                            authorization: 'Bearer ' + request.grant.token,
                        });
                        call.on('error', () => {});
                        call.resume();
                        return call;
                    };
                    stage = 'terminal';
                    const completed = open();
                    const terminal = once(completed, 'end');
                    completed.end(
                        frame(
                            generated.encode(
                                'ExecSandbox',
                                'start',
                                request.binding.sandbox,
                            ),
                        ),
                    );
                    await bounded(terminal, 5000, 'complete SDK terminal');
                    assert.equal(
                        rows(
                            request.binding.session,
                            request.grant.generation,
                        ).at(-1)?.state,
                        'SUCCEEDED',
                    );
                    stage = 'held';
                    const arrived = new Promise<void>((resolve) =>
                        upstreamStages.push(resolve),
                    );
                    const held = open();
                    const close = once(held, 'close');
                    held.end(
                        frame(
                            generated.encode(
                                'ExecSandbox',
                                'start',
                                request.binding.sandbox,
                            ),
                        ),
                    );
                    await bounded(arrived, 5000, 'held SDK call');
                    assert.equal(
                        rows(
                            request.binding.session,
                            request.grant.generation,
                        ).at(-1)?.state,
                        'UNKNOWN',
                    );
                    if (drainDuringRun) {
                        draining = service.drain().then(() => {
                            drainFinished = true;
                        });
                        if (process.env.BENTO_TEST_GO_CONTROL) {
                            const db = new DatabaseSync(
                                join(state, 'business.sqlite'),
                                { readOnly: true },
                            );
                            try {
                                assert.equal(
                                    db
                                        .prepare(
                                            'SELECT runId FROM run_slot_leases WHERE slot=0',
                                        )
                                        .get()?.runId,
                                    request.grant.run,
                                );
                                assert(
                                    db
                                        .prepare(
                                            'SELECT 1 FROM run_admission_drain',
                                        )
                                        .get(),
                                );
                            } finally {
                                db.close();
                            }
                        }
                        await delay(20);
                        assert.equal(drainFinished, false);
                    }
                    held.close(constants.NGHTTP2_CANCEL);
                    await bounded(close, 5000, 'lost SDK terminal');
                    return 'review';
                } finally {
                    transport.destroy();
                    exits.set(
                        request.grant.run + ':' + request.grant.generation,
                        new Date().toISOString(),
                    );
                }
            },
        };
        const service = await start(
            state,
            observedHost,
            process.env.BENTO_TEST_GO_CONTROL,
        );
        t.after(() => service.close());
        const api = taskRetryTestClient(() => service.url);
        async function executeOne() {
            const result = await api(
                '/tasks',
                'POST',
                taskRetryTestInput(),
                randomUUID(),
            );
            assert.equal(result.status, 202, result.text);
            const task = '/tasks/' + result.json().task.id;
            await until(
                () => api(task),
                (r) => r.json().task.status === 'ready',
                'SDK Task ready',
            );
            const accepted = await api(
                task + '/runs',
                'POST',
                { prompt: 'review SDK' },
                randomUUID(),
            );
            assert.equal(accepted.status, 202, accepted.text);
            const runId = accepted.json().run.id as string;
            const run = task + '/runs/' + runId;
            await until(
                () => api(run),
                (r) => r.json().run.status === 'needs_review',
                'SDK Task review',
            );
            assert.equal(
                (await api(run + '/results/1/diff?view=cumulative')).status,
                409,
            );
            const original = active;
            assert.equal(original.grant.run, runId);
            const sdkOperationId = seen.get(original.binding.session);
            assert(sdkOperationId);
            assert.deepEqual(
                rows(original.binding.session, original.grant.generation).map(
                    (row) => row.state,
                ),
                ['SUCCEEDED', 'UNKNOWN'],
            );
            return { run, runId, original, sdkOperationId };
        }
        const unrelated = await executeOne();
        drainDuringRun = true;
        const original = await executeOne();
        const proof = {
            runId: original.runId,
            failedGeneration: original.original.grant.generation,
            readyGeneration: original.original.grant.generation + 2,
            sdkOperationId: original.sdkOperationId,
            expectedSnapshotSha256: snapshotSha256([
                {
                    path: 'README.md',
                    text: effects.get(original.original.binding.session)!,
                },
            ]),
        };
        await assert.rejects(
            service.reviewRun({
                ...proof,
                sdkOperationId: unrelated.sdkOperationId,
            }),
            /evidence changed/,
        );
        await assert.rejects(
            service.reviewRun({
                ...proof,
                failedGeneration: proof.failedGeneration + 1,
                readyGeneration: proof.readyGeneration + 1,
            }),
            /not awaiting|admission changed/,
        );
        await assert.rejects(
            service.reviewRun({
                ...proof,
                expectedSnapshotSha256: '0'.repeat(64),
            }),
            /does not match/,
        );
        const both = { ...proof, stableOperationId: 'legacy' };
        await assert.rejects(
            service.reviewRun(both as typeof proof),
            /Invalid review proof/,
        );
        assert.equal(
            (await api(original.run + '/results/1/diff?view=cumulative'))
                .status,
            409,
        );
        await Promise.all([service.reviewRun(proof), service.reviewRun(proof)]);
        for (const view of ['incremental', 'cumulative']) {
            const result = await api(
                original.run + '/results/1/diff?view=' + view,
            );
            assert.equal(result.status, 200, result.text);
            assert.equal(
                (result.text.match(/^\+reviewed SDK effect$/gm) ?? []).length,
                1,
            );
        }
        assert.equal(
            (await api(unrelated.run)).json().run.status,
            'needs_review',
        );
        assert.equal(
            rows(original.original.binding.session, proof.failedGeneration).at(
                -1,
            )?.state,
            'UNKNOWN',
        );
        assert(draining);
        await draining;
        assert.equal(drainFinished, true);
        const evidence = new DatabaseSync(join(state, 'business.sqlite'), {
            readOnly: true,
        });
        try {
            const consumed = evidence
                .prepare(
                    `SELECT c.consumer, c.sha256, p.sha256 AS proofDigest
                     FROM physical_stop_consumption c
                     JOIN physical_stop_proofs p USING(runId,generation)
                     WHERE c.runId=? AND c.generation=?
                     ORDER BY c.consumer`,
                )
                .all(original.runId, proof.failedGeneration);
            assert.deepEqual(
                consumed.map(({ consumer }) => consumer),
                ['slot', 'upgrade'],
            );
            for (const row of consumed)
                assert.equal(row.sha256, row.proofDigest);
            assert.equal(
                evidence
                    .prepare('SELECT count(*) AS count FROM run_slot_leases')
                    .get()?.count,
                0,
            );
        } finally {
            evidence.close();
        }
    },
);
