import { createHash, timingSafeEqual } from 'node:crypto';
import {
    createServer,
    type IncomingMessage,
    type ServerResponse,
} from 'node:http';
import {
    invalid,
    missing,
    oversized,
    projectInput,
    RequestError,
    runInput,
} from './input.ts';
import type { Store } from './store.ts';

const digest = (value: string) => createHash('sha256').update(value).digest();
const maxProjectBody = 6 * 1024 * 1024 + 3 * 1024 * 1024;
const maxRunBody = 128 * 1024;

function send(res: ServerResponse, status: number, body: string, type: string) {
    res.writeHead(status, {
        'content-type': type + '; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    res.end(body);
}

const json = (res: ServerResponse, status: number, value: unknown) =>
    send(res, status, JSON.stringify(value), 'application/json');

async function body(req: IncomingMessage, maxBytes: number) {
    if (
        !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')
    )
        throw invalid('Expected application/json.');
    if (Number(req.headers['content-length']) > maxBytes) throw oversized();
    const parts: Buffer[] = [];
    let bytes = 0;
    // A size rejection must not destroy the socket before the 413 is sent.
    for await (const part of req.iterator({ destroyOnReturn: false })) {
        const chunk = part as Buffer;
        bytes += chunk.length;
        if (bytes > maxBytes) throw oversized();
        parts.push(chunk);
    }
    try {
        const source = new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.concat(parts),
        );
        return JSON.parse(source) as unknown;
    } catch {
        throw invalid('Invalid UTF-8 JSON.');
    }
}

export function executionHttp(
    store: Store,
    token: string,
    wake: () => void,
    purgeOwner: (owner: string) => Promise<boolean>,
) {
    const authorization = digest('Bearer ' + token);
    const server = createServer(async (req, res) => {
        try {
            const supplied = req.headers.authorization;
            const owner = req.headers['x-bento-owner-id'];
            if (
                !supplied ||
                !timingSafeEqual(authorization, digest(supplied)) ||
                typeof owner !== 'string' ||
                !/^[!-~]{1,256}$/.test(owner) ||
                owner.includes(',')
            )
                throw new RequestError(
                    401,
                    'unauthorized',
                    'Service authentication required.',
                );

            const pathname = (req.url ?? '').split('?')[0];
            if (pathname === '/v1/account/purge' && req.method === 'POST') {
                const complete = await purgeOwner(owner);
                return json(res, complete ? 200 : 202, { complete });
            }
            if (pathname === '/v1/projects') {
                if (req.method === 'GET')
                    return json(res, 200, { projects: store.projects(owner) });
                if (req.method === 'POST') {
                    const { name, files } = projectInput(
                        await body(req, maxProjectBody),
                    );
                    const keys = req.headersDistinct['idempotency-key'];
                    const key = keys?.[0];
                    if (
                        keys &&
                        (keys.length !== 1 ||
                            !key ||
                            !/^[!-~]{1,128}$/.test(key))
                    )
                        throw invalid('Invalid Idempotency-Key.');
                    const result = store.createProject(owner, name, files, key);
                    json(res, result.replay ? 200 : 201, result.project);
                    wake();
                    return;
                }
            }

            const hold =
                /^\/v1\/projects\/([^/]+)\/file-deletion-holds\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.exec(
                    pathname ?? '',
                );
            if (hold) {
                const [, projectId, operationId] = hold;
                if (!projectId || !operationId) throw missing();
                if (req.method === 'POST')
                    return json(
                        res,
                        200,
                        store.acquireFileDeleteHold(
                            owner,
                            projectId,
                            operationId,
                        ),
                    );
                if (req.method === 'DELETE')
                    return json(
                        res,
                        200,
                        store.releaseFileDeleteHold(
                            owner,
                            projectId,
                            operationId,
                        ),
                    );
                throw missing();
            }

            const route =
                /^\/v1\/projects\/([^/]+)(?:\/(runs)(?:\/([^/]+)(\/(diff))?)?)?$/.exec(
                    pathname ?? '',
                );
            if (!route) throw missing();
            const [, projectId, runs, runId, , diff] = route;
            if (!projectId) throw missing();
            if (!runs && req.method === 'GET')
                return json(res, 200, store.project(owner, projectId));
            if (runs && !runId) {
                if (req.method === 'GET')
                    return json(res, 200, {
                        runs: store.runs(owner, projectId),
                    });
                if (req.method === 'POST') {
                    store.project(owner, projectId);
                    const key = req.headers['idempotency-key'];
                    const input = runInput(
                        await body(req, maxRunBody),
                        typeof key === 'string' ? key : undefined,
                    );
                    const result = store.addRun(
                        owner,
                        projectId,
                        input.key,
                        input.prompt,
                    );
                    json(res, result.replay ? 200 : 202, result.run);
                    wake();
                    return;
                }
            }
            if (runId && req.method === 'GET') {
                if (diff)
                    return send(
                        res,
                        200,
                        store.diff(owner, projectId, runId),
                        'text/plain',
                    );
                return json(res, 200, store.run(owner, projectId, runId));
            }
            throw missing();
        } catch (error) {
            if (req.aborted || res.destroyed) return;
            if (!req.complete) {
                res.setHeader('connection', 'close');
                req.resume();
            }
            const problem =
                error instanceof RequestError
                    ? error
                    : new RequestError(
                          500,
                          'internal_error',
                          'Execution service request failed.',
                      );
            json(res, problem.status, {
                error: { code: problem.code, message: problem.message },
            });
        }
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    return server;
}
