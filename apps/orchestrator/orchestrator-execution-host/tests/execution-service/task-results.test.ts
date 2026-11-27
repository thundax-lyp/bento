import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { localHost } from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/local.ts';
import { completedTurn } from '@/apps/worker/src/dsh-worker.ts';
import { snapshotSha256 } from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/service.ts';
import {
    type ExecutionHost,
    type WorkerRequest,
} from '@/apps/orchestrator/orchestrator-execution-host/src/execution-service/types.ts';
import { testToken, barrier, until, start } from './fixtures/service.ts';

test('DSH completion and UNKNOWN use the structured event shapes', () => {
    const completed = {
        type: 'turn/end',
        data: { turn: 2, reason: { kind: 'completed' } },
    };
    const interrupted = {
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'interrupted' } },
    };
    const unknown = {
        type: 'tool/result',
        data: {
            error: {
                name: 'ToolOutcomeUnknownError',
                code: 'TOOL_OUTCOME_UNKNOWN',
            },
        },
    };
    assert.equal(completedTurn([completed]), true);
    assert.equal(completedTurn([interrupted]), false);
    assert.equal(completedTurn([unknown, completed]), false);
    assert.equal(completedTurn([]), false);
});

test(
    'Task event projection deduplicates retries and rejects stale grants and private fields',
    { timeout: 15_000 },
    async (t) => {
        const state = await mkdtemp(join(tmpdir(), 'bento-task-projection-'));
        const base = localHost(join(state, 'volume'));
        const requests: WorkerRequest[] = [];
        const canary = 'fixture-credential-must-not-project';
        async function project(request: WorkerRequest, items: unknown[]) {
            assert(request.publicEventsUrl);
            const response = await fetch(request.publicEventsUrl, {
                method: 'POST',
                headers: {
                    authorization: 'Bearer ' + request.grant.token,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ items }),
                signal: AbortSignal.timeout(3000),
            });
            await response.body?.cancel();
            return response.status;
        }
        const service = await start(state, {
            ...base,
            async worker(request, signal, slot, exit) {
                if (request.mode === 'execute' && request.publicEventsUrl) {
                    requests.push(request);
                    assert.equal(
                        await project(request, [
                            {
                                offset: 0,
                                kind: 'agent_reply',
                                text: canary,
                                privateDiagnostic: { marker: canary },
                            },
                        ]),
                        403,
                    );
                    const items = [
                        { offset: 0, kind: 'agent_reply', text: '任务结果' },
                        { offset: 1, kind: 'command', text: '确定性检查' },
                        {
                            offset: 10,
                            kind: 'check',
                            name: 'fixture check',
                            status: 'passed',
                            output: 'ok',
                        },
                    ];
                    assert.equal(await project(request, items), 200);
                    assert.equal(await project(request, items), 200);
                    assert.equal(
                        await project(request, [
                            { offset: 2, kind: 'step', text: 'out of order' },
                            {
                                offset: 11,
                                kind: 'step',
                                text: 'must not commit',
                            },
                        ]),
                        403,
                    );
                    assert.equal(await project(request, [items[0]!]), 200);

                    assert.equal(
                        await project(request, [
                            {
                                offset: 0,
                                kind: 'agent_reply',
                                text: 'conflict',
                            },
                        ]),
                        403,
                    );
                    const result = await base.worker(
                        request,
                        signal,
                        slot,
                        exit,
                    );
                    assert.equal(
                        await project(request, [
                            { offset: 3, kind: 'step', text: 'late' },
                        ]),
                        403,
                    );
                    return result;
                }
                return base.worker(request, signal, slot, exit);
            },
        });
        t.after(async () => {
            await service.close();
            await rm(state, { recursive: true, force: true });
        });
        async function api(
            path: string,
            method = 'GET',
            body?: unknown,
            key?: string,
        ) {
            const response = await fetch(service.url + '/v1' + path, {
                method,
                headers: {
                    authorization: 'Bearer ' + testToken,
                    'x-bento-owner-id': 'account-a',
                    ...(key ? { 'idempotency-key': key } : {}),
                    ...(body === undefined
                        ? {}
                        : { 'content-type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(5000),
            });
            const text = await response.text();
            return { status: response.status, text, body: JSON.parse(text) };
        }
        async function create() {
            const task = await api(
                '/tasks',
                'POST',
                {
                    id: null,
                    name: 'Projected Task',
                    sourceSpaceId: null,
                    inputFiles: [],
                    inputManifest: [],
                    inputDigest: snapshotSha256([]),
                },
                randomUUID(),
            );
            assert.equal(task.status, 202, task.text);
            const path = '/tasks/' + task.body.task.id;
            await until(
                () => api(path),
                (r) => r.body.task.status === 'ready',
                'Projected Task ready',
            );
            return path;
        }
        async function run(task: string) {
            const response = await api(
                task + '/runs',
                'POST',
                { prompt: 'noop' },
                randomUUID(),
            );
            assert.equal(response.status, 202, response.text);
            const path = task + '/runs/' + response.body.run.id;
            await until(
                () => api(path),
                (r) => r.body.run.status === 'succeeded',
                'Projected Run published',
            );
            const result = await api(path + '/results');
            assert.equal(result.body.result.summary, '任务结果');
            assert.equal(result.text.includes(canary), false);
            for (const view of ['incremental', 'cumulative']) {
                const patches = [];
                for (const download of ['', '&download=1']) {
                    const response = await fetch(
                        service.url +
                            '/v1' +
                            path +
                            '/results/1/diff?view=' +
                            view +
                            download,
                        {
                            headers: {
                                authorization: 'Bearer ' + testToken,
                                'x-bento-owner-id': 'account-a',
                            },
                            signal: AbortSignal.timeout(5000),
                        },
                    );
                    assert.equal(response.status, 200);
                    const bytes = Buffer.from(await response.arrayBuffer());
                    assert.equal(bytes.includes(canary), false);
                    patches.push(bytes);
                }
                assert.deepEqual(patches[0], patches[1]);
            }
            assert.deepEqual(result.body.result.checks, [
                { name: 'fixture check', status: 'passed', output: 'ok' },
            ]);
        }
        const task = await create();
        await run(task);
        await run(task);
        const separate = await create();
        await run(separate);
        assert.equal(requests[0]!.grant.session, requests[1]!.grant.session);
        assert.notEqual(requests[0]!.grant.session, requests[2]!.grant.session);
        assert.equal(
            await project(requests[0]!, [
                { offset: 10, kind: 'step', text: 'old' },
            ]),
            403,
        );
        const { body, text } = await api(task + '/events');
        assert.deepEqual(
            body.items.map((event: { sequence: number }) => event.sequence),
            [1, 2, 3, 4, 5, 6, 7, 8],
        );
        assert.equal(
            body.items.filter(
                (event: { kind: string }) => event.kind === 'check',
            ).length,
            2,
        );
        assert.equal(text.includes(canary), false);
        assert.equal((await api(separate + '/events')).body.items.length, 4);
    },
);

test(
    'Task terminal results preserve four checks, empty bytes and unavailable gates across reopen',
    { timeout: 15_000 },
    async (t) => {
        const state = await mkdtemp(join(tmpdir(), 'bento-terminal-results-'));
        const base = localHost(join(state, 'volume'));
        const blocked = barrier();
        const checks = [
            { name: '通过检查', status: 'passed', output: '安全通过摘要' },
            { name: '失败检查', status: 'failed', output: '安全失败摘要' },
            { name: '未运行检查', status: 'not_run', output: null },
            {
                name: '无法运行检查',
                status: 'unavailable',
                output: '安全不可用摘要',
            },
        ];
        const host: ExecutionHost = {
            ...base,
            async worker(request, signal, slot, exit) {
                if (request.mode === 'execute') {
                    if (request.prompt === 'blocked') await blocked.promise;
                    assert(request.publicEventsUrl);
                    const response = await fetch(request.publicEventsUrl, {
                        method: 'POST',
                        headers: {
                            authorization: 'Bearer ' + request.grant.token,
                            'content-type': 'application/json',
                        },
                        body: JSON.stringify({
                            items: checks.map((check, offset) => ({
                                offset,
                                kind: 'check',
                                ...check,
                            })),
                        }),
                        signal: AbortSignal.timeout(3000),
                    });
                    assert.equal(response.status, 200);
                    await response.body?.cancel();
                }
                return base.worker(
                    request.prompt === 'blocked'
                        ? { ...request, prompt: 'noop' }
                        : request,
                    signal,
                    slot,
                    exit,
                );
            },
        };
        let service = await start(state, host);
        t.after(async () => {
            blocked.resolve();
            await service.close();
            await rm(state, { recursive: true, force: true });
        });
        async function api(
            path: string,
            owner = 'account-a',
            method = 'GET',
            body?: unknown,
        ) {
            return fetch(service.url + '/v1' + path, {
                method,
                headers: {
                    authorization: 'Bearer ' + testToken,
                    'x-bento-owner-id': owner,
                    ...(body === undefined
                        ? {}
                        : {
                              'content-type': 'application/json',
                              'idempotency-key': randomUUID(),
                          }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(5000),
            });
        }
        async function json(path: string) {
            const response = await api(path);
            assert.equal(response.status, 200);
            return response.json();
        }
        async function create(prompt: string) {
            const response = await api('/tasks', 'account-a', 'POST', {
                id: null,
                name: 'Terminal fixture',
                sourceSpaceId: null,
                inputFiles: [],
                inputManifest: [],
                inputDigest: snapshotSha256([]),
            });
            assert.equal(response.status, 202);
            const task = (await response.json()).task.id as string;
            const root = '/tasks/' + task;
            await until(
                () => json(root),
                (value) => value.task.status === 'ready',
                'terminal Task ready',
            );
            const run = await api(root + '/runs', 'account-a', 'POST', {
                prompt,
            });
            assert.equal(run.status, 202);
            return { root, path: root + '/runs/' + (await run.json()).run.id };
        }
        async function capture(path: string, empty: boolean) {
            const { result } = await json(path + '/results');
            assert.equal(result.version, 1);
            assert.equal(result.runId, path.split('/').at(-1));
            assert.deepEqual(result.checks, checks);
            const patches: Record<string, string> = {};
            for (const view of ['incremental', 'cumulative'] as const) {
                const preview = await api(
                    path + '/results/1/diff?view=' + view,
                );
                const download = await api(
                    path + '/results/1/diff?view=' + view + '&download=1',
                );
                assert.equal(preview.status, 200);
                assert.equal(download.status, 200);
                assert.match(
                    preview.headers.get('content-type') ?? '',
                    /^text\/plain/,
                );
                assert.equal(
                    download.headers.get('content-disposition'),
                    'attachment; filename="changes.patch"',
                );
                const bytes = Buffer.from(await preview.arrayBuffer());
                assert.deepEqual(
                    bytes,
                    Buffer.from(await download.arrayBuffer()),
                );
                assert.equal(bytes.length === 0, empty);
                assert.equal(
                    createHash('sha256').update(bytes).digest('hex'),
                    result[view + 'Sha256'],
                );
                patches[view] = bytes.toString('utf8');
                assert.equal(
                    (
                        await api(
                            path + '/results/1/diff?view=' + view,
                            'account-b',
                        )
                    ).status,
                    404,
                );
            }
            assert.equal(
                (await api(path + '/results', 'account-b')).status,
                404,
            );
            return { result, patches };
        }
        const empty = await create('noop');
        await until(
            () => json(empty.path),
            (value) => value.run.status === 'succeeded',
            'empty result published',
        );
        const beforeEmpty = await capture(empty.path, true);
        const changed = await create('fixture change');
        await until(
            () => json(changed.path),
            (value) => value.run.status === 'succeeded',
            'nonempty result published',
        );
        const beforeChanged = await capture(changed.path, false);
        for (const { root } of [empty, changed]) {
            const { items } = await json(root + '/events');
            assert.deepEqual(
                items
                    .filter((event: { kind: string }) => event.kind === 'check')
                    .map((event: { check: unknown }) => event.check),
                checks,
            );
        }
        const pending = await create('blocked');
        await until(
            () => json(pending.path),
            (value) => value.run.status === 'running',
            'pending Run running',
        );
        assert.equal((await json(pending.path)).run.resultVersion, null);
        for (const suffix of [
            '/results',
            '/results/1/diff?view=cumulative',
            '/results/1/diff?view=incremental&download=1',
        ]) {
            const unavailable = await api(pending.path + suffix);
            assert.equal(unavailable.status, 409);
            assert.equal(
                (await unavailable.json()).error.code,
                'diff_unavailable',
            );
        }
        blocked.resolve();
        await until(
            () => json(pending.path),
            (value) => value.run.status === 'succeeded',
            'barrier released',
        );
        await service.close();
        service = await start(state, host);
        assert.deepEqual(await capture(empty.path, true), beforeEmpty);
        assert.deepEqual(await capture(changed.path, false), beforeChanged);
    },
);
