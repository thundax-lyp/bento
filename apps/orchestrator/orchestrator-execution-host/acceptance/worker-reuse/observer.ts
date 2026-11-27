import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Http2Server, Http2Session } from 'node:http2';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import type { PreparedSdk } from '@/apps/orchestrator/orchestrator-execution-host/tests/openshell/binding-grants/sdk.ts';
import type { WorkerRequest } from '@/apps/worker/protocol.ts';

export const sha256 = (value: string | Uint8Array) =>
    createHash('sha256').update(value).digest('hex');
export type ReusePaths = { authority: string; history: string };
export type ReuseSnapshot = {
    schema: 1;
    sessions: {
        tenant: string;
        session: string;
        run: string;
        generation: number;
        historySha256: string;
        receiptsSha256: string;
        handle: string | null;
        intents: number;
    }[];
    sdkConnections: number;
    sdkStreams: number;
    upstreamCalls: number;
    workerPids: number[];
};
export type WireRecord = {
    connection: number;
    tokenSha256: string;
    method: string;
    targets: string[];
    openedAt: number;
    closedAt: number | null;
    status: string | null;
};

export function readWorkerProcesses(parentPid: number) {
    const text = execFileSync('ps', ['-axo', 'pid=,ppid=,args='], {
        encoding: 'utf8',
        timeout: 5000,
    });
    return text.split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (
            !match ||
            Number(match[2]) !== parentPid ||
            !match[3]!.includes('apps/worker/run-worker.ts') ||
            !/(?:^|\s)--warm(?:\s|$)/.test(match[3]!)
        )
            return [];
        return [{ pid: Number(match[1]), ppid: Number(match[2]) }];
    });
}

export function readReuseSnapshot(
    paths: ReusePaths,
    sessions: readonly WorkerRequest[],
    resources: Pick<
        ReuseSnapshot,
        'sdkConnections' | 'sdkStreams' | 'upstreamCalls' | 'workerPids'
    >,
): ReuseSnapshot {
    const authority = new DatabaseSync(paths.authority, { readOnly: true });
    const history = new DatabaseSync(paths.history, { readOnly: true });
    try {
        return {
            schema: 1,
            sessions: sessions.map(({ binding, grant }) => {
                const row = authority
                    .prepare(
                        'SELECT tenant,project,session,sandbox,volume,run,generation FROM execution_sessions WHERE session=?',
                    )
                    .get(binding.session);
                assert(row);
                for (const key of [
                    'tenant',
                    'project',
                    'session',
                    'sandbox',
                    'volume',
                ] as const)
                    assert.equal(row[key], binding[key]);
                assert.equal(row.run, grant.run);
                assert.equal(typeof row.generation, 'number');
                const stored = history
                    .prepare('SELECT handle FROM sessions WHERE id=?')
                    .get(binding.session);
                const events = history
                    .prepare('SELECT * FROM events WHERE id=? ORDER BY seq')
                    .all(binding.session);
                const receipts = history
                    .prepare(
                        'SELECT * FROM batch_receipts WHERE id=? ORDER BY epoch,batch',
                    )
                    .all(binding.session);
                const intents = history
                    .prepare(
                        'SELECT COUNT(*) AS n FROM batch_intents WHERE id=?',
                    )
                    .get(binding.session);
                return {
                    tenant: binding.tenant,
                    session: binding.session,
                    run: String(row.run),
                    generation: Number(row.generation),
                    historySha256: sha256(JSON.stringify(events)),
                    receiptsSha256: sha256(JSON.stringify(receipts)),
                    // A live writer key is a capability, so only its digest is observed.
                    handle:
                        typeof stored?.handle === 'string'
                            ? sha256(stored.handle)
                            : null,
                    intents: Number(intents?.n ?? 0),
                };
            }),
            ...resources,
        };
    } finally {
        history.close();
        authority.close();
    }
}

export function observeSdk(server: Http2Server, sdk: PreparedSdk) {
    const sessions = new Map<
        Http2Session,
        { id: number; openedAt: number; closedAt: number | null }
    >();
    const connections: {
        id: number;
        openedAt: number;
        closedAt: number | null;
    }[] = [];
    const wire: WireRecord[] = [];
    let activeStreams = 0;
    let decodeErrors = 0;
    server.on('session', (session) => {
        const row = {
            id: connections.length + 1,
            openedAt: performance.now(),
            closedAt: null as number | null,
        };
        connections.push(row);
        sessions.set(session, row);
        session.on('error', () => undefined);
        session.once('close', () => {
            row.closedAt = performance.now();
            sessions.delete(session);
        });
    });
    server.on('stream', (stream, headers) => {
        activeStreams++;
        const row: WireRecord = {
            connection: sessions.get(stream.session!)!.id,
            tokenSha256: sha256(
                String(headers.authorization ?? '').replace(/^Bearer /, ''),
            ),
            method: String(headers[':path']).split('/').at(-1)!,
            targets: [],
            openedAt: performance.now(),
            closedAt: null,
            status: null,
        };
        wire.push(row);
        let buffer = Buffer.alloc(0);
        stream.on('error', () => undefined);
        stream.on('data', (chunk: Buffer) => {
            try {
                buffer = Buffer.concat([buffer, chunk]);
                assert(buffer.length <= 1024 * 1024 + 5);
                while (buffer.length >= 5) {
                    const size = buffer.readUInt32BE(1);
                    assert(buffer[0] === 0 && size <= 1024 * 1024);
                    if (buffer.length < size + 5) break;
                    if (
                        row.method === 'GetSandbox' ||
                        row.method === 'ExecSandbox' ||
                        row.method === 'ExecSandboxInteractive'
                    ) {
                        const target = sdk.decode(
                            row.method,
                            buffer.subarray(5, size + 5),
                        );
                        if (target !== 'stdin')
                            row.targets.push(target.sandbox);
                    }
                    buffer = buffer.subarray(size + 5);
                }
            } catch {
                decodeErrors++;
                buffer = Buffer.alloc(0);
            }
        });
        stream.once('close', () => {
            activeStreams--;
            row.closedAt = performance.now();
            row.status = String(
                stream.sentTrailers?.['grpc-status'] ??
                    stream.sentHeaders?.['grpc-status'] ??
                    'unknown',
            );
        });
    });
    return {
        wire,
        connections,
        get activeConnections() {
            return sessions.size;
        },
        get activeStreams() {
            return activeStreams;
        },
        get decodeErrors() {
            return decodeErrors;
        },
        async close() {
            await Promise.all(
                [...sessions.keys()].map(
                    (session) =>
                        new Promise<void>((resolve) => {
                            session.once('close', resolve);
                            session.destroy();
                        }),
                ),
            );
        },
    };
}
