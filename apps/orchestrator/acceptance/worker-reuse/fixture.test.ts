import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { PreparedSdk } from '@/apps/orchestrator/openshell/binding-grants/sdk.ts';
import type { WorkerRequest } from '@/apps/worker/protocol.ts';
import { createRunSdkTransport } from '@/apps/worker/sdk-transport.ts';
import { createReuseFixture } from './fixture.ts';
import { sha256 } from './observer.ts';
import { prepareReuseSdk } from './sdk.ts';

let sdk: PreparedSdk;
type Interactive = {
    output: AsyncIterable<
        | { stream: 'stdout' | 'stderr'; data: Buffer }
        | { type: 'exit'; exitCode: number }
    >;
    write(data: Buffer): void;
    closeInput(): void;
    done: Promise<number>;
};
type Client = {
    get(name: string): Promise<{ name: string }>;
    execInteractive(
        name: string,
        command: string[],
        options: {
            workdir: string;
            tty: false;
            noLoginShell: true;
            workspace: string;
        },
    ): Promise<Interactive>;
};
let createClient: (request: WorkerRequest) => {
    client: Client;
    close(): Promise<void>;
};
const timeout = { timeout: 120_000, concurrency: false };
before(
    async () => {
        sdk = await prepareReuseSdk();
        const api = await import(
            pathToFileURL(join(dirname(sdk.raw), 'index.js')).href
        );
        createClient = (request) => {
            assert(request.gateway);
            const transport = createRunSdkTransport(
                request.gateway,
                request.grant.token,
            );
            return {
                client: new api.SandboxClient(transport.transport) as Client,
                close: transport.close,
            };
        };
    },
    { timeout: 600_000 },
);
after(async () => sdk?.dispose());

async function helper(client: Client, request: WorkerRequest, method: string) {
    const call = await client.execInteractive(
        request.binding.sandbox,
        ['/usr/local/bin/node', '/runtime/fs.mjs'],
        {
            workdir: '/sandbox/project',
            tty: false,
            noLoginShell: true,
            workspace: 'default',
        },
    );
    call.write(
        Buffer.from(
            JSON.stringify({
                version: '0.2.1-rc.4',
                method,
                path:
                    '/sandbox/project' +
                    (method === 'streamText' ? '/hold' : ''),
                workspaceRoot: '/sandbox/project',
                defaultMode: 'workspace-write',
            }),
        ),
    );
    return call;
}
async function output(call: Interactive) {
    const text: Buffer[] = [];
    for await (const event of call.output) {
        if ('stream' in event) {
            assert.equal(event.stream, 'stdout');
            text.push(event.data);
        } else assert.equal(event.exitCode, 0);
    }
    return Buffer.concat(text).toString();
}
async function until(done: () => boolean) {
    const deadline = Date.now() + 5000;
    while (!done()) {
        if (Date.now() >= deadline)
            throw new Error('Independent wire observation timed out');
        await delay(10);
    }
}
function sqlRows(fixture: Awaited<ReturnType<typeof createReuseFixture>>) {
    const authority = new DatabaseSync(fixture.paths.authority, {
        readOnly: true,
    });
    const history = new DatabaseSync(fixture.paths.history, { readOnly: true });
    try {
        return {
            authority: authority
                .prepare('SELECT * FROM execution_sessions ORDER BY session')
                .all(),
            history: Object.fromEntries(
                ['sessions', 'events', 'batch_receipts', 'batch_intents'].map(
                    (table) => [
                        table,
                        history
                            .prepare('SELECT * FROM ' + table + ' ORDER BY id')
                            .all(),
                    ],
                ),
            ),
        };
    } finally {
        history.close();
        authority.close();
    }
}

test(
    'official SDK crosses production ingress and mTLS; cross-session probes preserve SQL',
    timeout,
    async () => {
        const fixture = await createReuseFixture(sdk, 2);
        const first = fixture.request(0);
        const next = fixture.request(1);
        const run = createClient(first);
        try {
            assert.equal(
                (await run.client.get(first.binding.sandbox)).name,
                first.binding.sandbox,
            );
            const call = await helper(run.client, first, 'resolve');
            const collected = output(call);
            call.closeInput();
            assert.equal(await call.done, 0);
            assert.deepEqual(JSON.parse(await collected), {
                version: '0.2.1-rc.4',
                value: { targetKey: '/sandbox/project' },
            });
            assert(fixture.authenticatedSessions > 0);
            const rows = sqlRows(fixture);
            const snapshot = fixture.snapshot().sessions;
            const upstreamCalls = fixture.upstreamCalls;
            await assert.rejects(run.client.get(next.binding.sandbox));
            await until(() => fixture.wire.at(-1)?.closedAt !== null);
            assert.equal(fixture.wire.at(-1)?.status, '7');
            assert.equal(fixture.upstreamCalls, upstreamCalls);
            const denied = await fetch(new URL('/rpc', first.persistenceUrl), {
                method: 'POST',
                headers: { authorization: 'Bearer ' + first.grant.token },
                body: JSON.stringify({
                    method: 'stat',
                    id: next.binding.session,
                }),
                signal: AbortSignal.timeout(5000),
            });
            assert.equal(denied.status, 403);
            await denied.arrayBuffer();
            assert.equal(fixture.controlRequests.length, 1);
            assert.equal(fixture.controlRequests[0]!.interface, 'persistence');
            assert.equal(
                fixture.controlRequests[0]!.tokenSha256,
                sha256(first.grant.token),
            );
            assert.equal(fixture.controlRequests[0]!.path, '/rpc');
            const invalid = await fetch(
                new URL('/operations', first.operationUrl),
                {
                    method: 'POST',
                    headers: { authorization: 'Bearer ' + first.grant.token },
                    body: '{}',
                    signal: AbortSignal.timeout(5000),
                },
            );
            assert.equal(invalid.status, 403);
            await invalid.arrayBuffer();
            assert.equal(fixture.controlRequests.length, 2);
            assert.equal(fixture.controlRequests[1]!.interface, 'operation');
            assert.equal(
                fixture.controlRequests[1]!.tokenSha256,
                sha256(first.grant.token),
            );
            assert.equal(fixture.controlRequests[1]!.path, '/operations');
            for (const row of fixture.controlRequests) {
                assert.equal(row.status, 403);
                assert(row.finishedAt !== null && row.finishedAt >= row.at);
            }
            assert(
                isDeepStrictEqual(sqlRows(fixture), rows),
                'Denied probes changed private SQL rows',
            );
            assert.deepEqual(fixture.snapshot().sessions, snapshot);
            for (const wire of fixture.wire)
                assert.equal(wire.tokenSha256, sha256(first.grant.token));
            assert(
                fixture.wire.some(
                    (wire) =>
                        wire.targets.includes(next.binding.sandbox) &&
                        wire.status === '7',
                ),
            );
            await run.close();
            await fixture.quiescent();
            const closed = fixture.snapshot();
            assert.equal(closed.sdkConnections, 0);
            assert.equal(closed.sdkStreams, 0);
            assert.deepEqual(closed.workerPids, []);
            assert(
                fixture.connections.every(
                    (connection) => connection.closedAt !== null,
                ),
            );
        } finally {
            await run.close();
            await fixture.close();
        }
    },
);

test(
    'takeover revokes a real open-input RPC and denies reconnect while another session works',
    timeout,
    async () => {
        const fixture = await createReuseFixture(sdk, 2);
        const first = fixture.request(0);
        const next = fixture.request(1);
        const run = createClient(first);
        let denied: ReturnType<typeof createClient> | undefined;
        let neighbor: ReturnType<typeof createClient> | undefined;
        try {
            const call = await helper(run.client, first, 'streamText');
            // Neither closeInput nor cancel has run: denial must close live input.
            const result = Promise.allSettled([call.done, output(call)]);
            await fixture.waitHeld(0);
            assert.equal(fixture.activeHeld, 1);
            await fixture.takeover(0);
            const settled = await result;
            assert.equal(settled[0]!.status, 'rejected');
            assert.throws(() => call.write(Buffer.from('post-revocation')));
            await until(() => fixture.activeHeld === 0);
            assert.equal(fixture.revocations.length, 1);
            assert.equal(fixture.revocations[0]!.state, 'UNKNOWN');
            assert.equal(fixture.revocations[0]!.stopConfirmed, false);
            await run.close();
            denied = createClient(first);
            const upstreamCalls = fixture.upstreamCalls;
            await assert.rejects(denied.client.get(first.binding.sandbox));
            await until(() => fixture.wire.at(-1)?.closedAt !== null);
            assert.equal(fixture.wire.at(-1)?.status, '16');
            assert.equal(fixture.upstreamCalls, upstreamCalls);
            await denied.close();
            neighbor = createClient(next);
            assert.equal(
                (await neighbor.client.get(next.binding.sandbox)).name,
                next.binding.sandbox,
            );
            assert.equal(
                fixture.wire.at(-1)?.tokenSha256,
                sha256(next.grant.token),
            );
            await neighbor.close();
            await fixture.quiescent();
            const snapshot = fixture.snapshot();
            assert.equal(snapshot.sdkConnections, 0);
            assert.equal(snapshot.sdkStreams, 0);
            assert.deepEqual(snapshot.workerPids, []);
        } finally {
            await Promise.all([
                run.close(),
                denied?.close(),
                neighbor?.close(),
            ]);
            await fixture.close();
        }
    },
);
