import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import type { WorkerGate, WorkerGrant } from './worker-gate.ts';

type PersistenceGrant = WorkerGrant & { backendToken: string };
type Result = { status: number; body: string };

export function createPersistenceIngress(
    gate: WorkerGate,
    resolveGrant: (
        authorization: string | undefined,
    ) => PersistenceGrant | undefined,
    dispatch: (
        body: string,
        backendToken: string,
        grant: WorkerGrant,
    ) => Promise<Result | undefined>,
) {
    const server = createServer(async (req, res) => {
        try {
            const grant = resolveGrant(req.headers.authorization);
            if (!grant || req.method !== 'POST' || req.url !== '/rpc')
                throw new Error('denied');
            let body = '';
            for await (const part of req) {
                body += part;
                if (Buffer.byteLength(body) > 1024 * 1024)
                    throw new Error('oversize');
            }
            const query = JSON.parse(body);
            const binding = gate.require(grant);
            if (
                (query.id !== undefined && query.id !== binding.session) ||
                (query.header !== undefined &&
                    query.header?.id !== binding.session)
            )
                throw new Error('wrong session');
            const result = await dispatch(body, grant.backendToken, grant);
            if (!result) {
                res.destroy();
                return;
            }
            res.writeHead(result.status, {
                'content-type': 'application/json',
            });
            res.end(result.body);
        } catch {
            if (!res.headersSent)
                res.writeHead(403, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({ ok: false, error: { name: 'GrantDenied' } }),
            );
        }
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    return server;
}
