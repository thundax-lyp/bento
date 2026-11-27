import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runDshWorker, type DshWorkerBootstrap } from '../src/dsh-worker.ts';
import type { WorkerRequest } from '../src/protocol.ts';
import bootstrap from '../src/task-bootstrap.ts';

const request: WorkerRequest = {
    mode: 'execute',
    binding: {
        tenant: 'tenant',
        project: 'project',
        session: 'session',
        sandbox: 'sandbox',
        volume: 'volume',
    },
    grant: { token: 'fixture', session: 'session', run: 'run', generation: 1 },
    persistenceUrl: 'http://127.0.0.1',
    operationUrl: 'http://127.0.0.1',
    publicEventsUrl: 'http://127.0.0.1/task-events',
    gateway: 'http://127.0.0.1',
    prompt: 'check',
};
const effect: Parameters<DshWorkerBootstrap>[1] = async (
    _id,
    _input,
    dispatch,
) => dispatch();

const fixture = `
import assert from 'node:assert/strict';
export let original;
export let args;
export const calls = [];
const baseEvents = [
    {type:'tool/call',data:{name:'bento_workspace_check',arguments:'synthetic-secret'}},
    {type:'tool/result',data:{meta:{bentoWorkspaceCheck:{version:1,outcome:'pass'}}}},
    {type:'turn/end',data:{reason:{kind:'completed'}}},
];
export default function create(request,effect) {
    const events = request.prompt === 'four-checks'
        ? [...baseEvents.slice(0, 2), {type:'tool/result',data:{privateDiagnostic:'synthetic-secret'}}, baseEvents[2]]
        : baseEvents;
    calls.length = 0;
    args = [request,effect];
    let submitted = false;
    const agent = {
        session: {snapshotEvents: () => submitted ? events : []},
        followup() { calls.push('followup'); submitted = true; },
        async whenIdle() {},
    };
    const persistence = {stat: async () => null};
    const runtime = {
        ctx: {plugin: async () => {},inject: () => {}},
        agentOptions: {provider:'fixture',model:'fixture'},
        workspaceRoot: '/workspace',
        provider: {},
        agents: {create: async () => ({agent})},
        persistence() { assert.equal(this,runtime); calls.push('persistence'); return persistence; },
        flush() {
            assert.equal(this,runtime); calls.push('flush');
            if(request.prompt==='fail flush') return Promise.reject(new Error('original flush'));
            return Promise.resolve();
        },
        userMessage(prompt) {
            assert.equal(this,runtime); calls.push('userMessage');
            if(prompt==='fail') throw new Error('original message');
            return prompt;
        },
        initialize() { assert.equal(this,runtime); calls.push('initialize'); return Promise.resolve(); },
        dispose() {
            assert.equal(this,runtime); calls.push('dispose');
            if(request.prompt==='fail facade') throw new Error('dispose error');
        },
        publicEvents(input) {
            assert.equal(this,runtime); assert.deepEqual(input,events); calls.push('visible');
            return [{offset:2,kind:'agent_reply',text:'base'}];
        },
        trustedTaskChecks(input) {
            assert.equal(this,runtime); assert.deepEqual(input,events); calls.push('proofs');
            return request.prompt === 'four-checks'
                ? ['pass','fail','skip','unavailable'].map((outcome,offset)=>({version:1,offset,outcome}))
                : [];
        },
    };
    if (request.prompt==='missing proof') delete runtime.trustedTaskChecks;
    if (request.prompt==='missing public') delete runtime.publicEvents;
    if (request.prompt==='missing initialize') delete runtime.initialize;
    if (request.prompt==='fail facade') Object.defineProperty(runtime,'initialize',{get(){throw new Error('original facade')}});
    original = runtime;
    return runtime;
}
`;

test('bootstrap resolves only a distinct absolute module and preserves the underlying runtime', async (t) => {
    const prior = process.env.BENTO_DSH_BASE_BOOTSTRAP;
    const folder = await mkdtemp(join(tmpdir(), 'bento-bootstrap-'));
    t.after(async () => {
        if (prior === undefined) delete process.env.BENTO_DSH_BASE_BOOTSTRAP;
        else process.env.BENTO_DSH_BASE_BOOTSTRAP = prior;
        await rm(folder, { recursive: true, force: true });
    });
    const path = join(folder, 'fixture.mjs');
    await writeFile(path, fixture);
    const mod = (await import(pathToFileURL(path).href)) as {
        original: Awaited<ReturnType<DshWorkerBootstrap>>;
        args: unknown[];
        calls: string[];
    };
    const invalid = join(folder, 'invalid.mjs');
    await writeFile(invalid, 'export default {}');

    await t.test(
        'rejects empty, relative, recursive and non-function configurations',
        async () => {
            for (const bad of [
                '',
                'fixture.mjs',
                fileURLToPath(
                    new URL('../src/task-bootstrap.ts', import.meta.url),
                ),
                invalid,
            ]) {
                process.env.BENTO_DSH_BASE_BOOTSTRAP = bad;
                await assert.rejects(
                    () => bootstrap(request, effect),
                    /bootstrap/,
                );
            }
            process.env.BENTO_DSH_BASE_BOOTSTRAP = path;
        },
    );

    await t.test(
        'preserves identities, receivers, returns, exceptions and optional initialize',
        async () => {
            const runtime = await bootstrap(
                { ...request, prompt: 'fail flush' },
                effect,
            );
            assert.deepEqual(mod.args[0], { ...request, prompt: 'fail flush' });
            assert.equal(mod.args[1], effect);
            for (const key of [
                'ctx',
                'agentOptions',
                'workspaceRoot',
                'provider',
                'agents',
            ] as const)
                assert.equal(runtime[key], mod.original[key]);
            const handle = await runtime.agents.create({
                sessionId: request.grant.session as Parameters<
                    typeof runtime.agents.create
                >[0]['sessionId'],
                meta: { cwd: runtime.workspaceRoot },
                agentOptions: runtime.agentOptions,
            });
            await runtime.initialize?.();
            assert.equal(typeof runtime.persistence().stat, 'function');
            assert.equal(runtime.userMessage('example'), 'example');
            assert.throws(
                () => runtime.userMessage('fail'),
                /original message/,
            );
            await assert.rejects(runtime.flush(handle.agent), /original flush/);
            assert.equal(await runtime.dispose(), undefined);
            assert.deepEqual(mod.calls, [
                'initialize',
                'persistence',
                'userMessage',
                'userMessage',
                'flush',
                'dispose',
            ]);
            assert.equal(
                (
                    await bootstrap(
                        { ...request, prompt: 'missing initialize' },
                        effect,
                    )
                ).initialize,
                undefined,
            );
            await assert.rejects(
                bootstrap({ ...request, prompt: 'fail facade' }, effect),
                /original facade/,
            );
            assert.deepEqual(mod.calls, ['dispose']);
            const legacy = { ...request };
            delete legacy.publicEventsUrl;
            assert.equal(await bootstrap(legacy, effect), mod.original);
            assert.equal(
                await bootstrap({ ...request, mode: 'recover' }, effect),
                mod.original,
            );
        },
    );

    await t.test(
        'sends only safe events and the end receipt despite forged check data',
        async (t) => {
            const batches: unknown[] = [];
            const server = createServer((req, res) => {
                let body = '';
                req.setEncoding('utf8').on('data', (chunk: string) => {
                    body += chunk;
                });
                req.on('end', () => {
                    batches.push(JSON.parse(body));
                    res.writeHead(200, {
                        'content-type': 'application/json',
                    }).end('{"accepted":true}');
                });
            });
            server.listen(0, '127.0.0.1');
            await once(server, 'listening');
            t.after(() => {
                server.close();
            });
            const address = server.address();
            assert(address && typeof address !== 'string');
            const reachable = {
                ...request,
                publicEventsUrl:
                    'http://127.0.0.1:' + address.port + '/task-events',
            };
            assert.equal(await runDshWorker(reachable, bootstrap), 'completed');
            assert.deepEqual(batches, [
                { items: [{ offset: 2, kind: 'agent_reply', text: 'base' }] },
                { items: [] },
            ]);
            assert.deepEqual(mod.calls, [
                'initialize',
                'persistence',
                'userMessage',
                'followup',
                'flush',
                'visible',
                'proofs',
                'dispose',
            ]);
            for (const prompt of ['missing proof', 'missing public']) {
                assert.equal(
                    await runDshWorker({ ...reachable, prompt }, bootstrap),
                    'review',
                );
                assert.deepEqual(mod.calls, [
                    'initialize',
                    'persistence',
                    'dispose',
                ]);
            }
            assert.equal(batches.length, 2);
            batches.length = 0;
            assert.equal(
                await runDshWorker(
                    { ...reachable, prompt: 'four-checks' },
                    bootstrap,
                ),
                'completed',
            );
            assert.deepEqual(batches, [
                {
                    items: [
                        {
                            offset: 0,
                            kind: 'check',
                            name: '工作区内容检查',
                            status: 'passed',
                            output: '内容与预期一致',
                        },
                        {
                            offset: 1,
                            kind: 'check',
                            name: '工作区内容检查',
                            status: 'failed',
                            output: '内容与预期不同',
                        },
                        {
                            offset: 2,
                            kind: 'check',
                            name: '工作区内容检查',
                            status: 'not_run',
                            output: null,
                        },
                        {
                            offset: 3,
                            kind: 'check',
                            name: '工作区内容检查',
                            status: 'unavailable',
                            output: '无法读取检查目标',
                        },
                    ],
                },
                { items: [] },
            ]);
            assert.equal(
                JSON.stringify(batches).includes('synthetic-secret'),
                false,
            );
        },
    );
});
