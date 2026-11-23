import { createHash } from 'node:crypto';
import { httpListener } from './http-listener.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { keycloakAuth } from './oidc.ts';
import type { sessionAuth } from './auth.ts';
import {
    notFound,
    parseTaskRequest,
    projectInput,
    RequestError,
    resourceId,
    runPrompt,
} from './protocol.ts';
import type { Backend, Operation } from './protocol.ts';
import type { mySpace } from './space.ts';

type Options = {
    port: number;
    origin: string;
    auth: ReturnType<typeof sessionAuth>;
    oidc?: Awaited<ReturnType<typeof keycloakAuth>>;
    backend: Backend;
    space?: ReturnType<typeof mySpace>;
};

const maxJsonBytes = 8 * 1024 * 1024;
function reply(
    response: ServerResponse,
    status: number,
    type: string,
    body: string,
) {
    response.writeHead(status, {
        'Content-Type': type + '; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
    });
    response.end(body);
}

function json(response: ServerResponse, status: number, body: unknown) {
    reply(response, status, 'application/json', JSON.stringify(body));
}

async function readJson(
    request: IncomingMessage,
    maxBytes: number,
): Promise<unknown> {
    const type = request.headers['content-type']
        ?.split(';')[0]
        ?.trim()
        .toLowerCase();
    if (type !== 'application/json') {
        throw new RequestError(
            400,
            'invalid_content_type',
            '请使用 application/json。',
        );
    }
    const tooLarge = new RequestError(413, 'too_large', '请求超过大小限制。');
    if (Number(request.headers['content-length']) > maxBytes) throw tooLarge;

    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        const bytes = Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > maxBytes) throw tooLarge;
        chunks.push(bytes);
    }
    try {
        return JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
                Buffer.concat(chunks),
            ),
        );
    } catch {
        throw new RequestError(
            400,
            'invalid_json',
            '请求内容必须是 UTF-8 JSON。',
        );
    }
}

function decodeId(raw: string) {
    try {
        return resourceId(decodeURIComponent(raw));
    } catch {
        throw notFound();
    }
}

async function route(
    request: IncomingMessage,
    path: string,
): Promise<Operation> {
    const method = request.method;
    const [, api, projects, rawProject, runs, rawRun, action, ...rest] =
        path.split('/');
    if (api !== 'api' || projects !== 'projects' || rest.length)
        throw notFound();
    if (rawProject === undefined) {
        if (method === 'GET') return { kind: 'listProjects' };
        if (method === 'POST') {
            return {
                kind: 'createProject',
                input: projectInput(await readJson(request, maxJsonBytes)),
            };
        }
        throw notFound();
    }

    const projectId = decodeId(rawProject);
    if (runs === undefined && method === 'GET')
        return { kind: 'project', projectId };
    if (runs !== 'runs') throw notFound();

    if (rawRun === undefined) {
        if (method === 'GET') return { kind: 'listRuns', projectId };
        if (method === 'POST') {
            const keys = request.headersDistinct['idempotency-key'];
            const key = keys?.[0];
            if (keys?.length !== 1 || !key || !/^[!-~]+$/.test(key)) {
                throw new RequestError(
                    400,
                    'invalid_key',
                    '请提供一个有效的 Idempotency-Key。',
                );
            }
            const prompt = runPrompt(await readJson(request, 64 * 1024));
            return { kind: 'createRun', projectId, prompt, key };
        }
    }

    if (rawRun !== undefined) {
        const runId = decodeId(rawRun);
        if (method === 'GET' && action === undefined)
            return { kind: 'run', projectId, runId };
        if (method === 'GET' && action === 'diff')
            return { kind: 'diff', projectId, runId };
        if (method === 'POST' && action === 'cancel')
            return { kind: 'cancelRun', projectId, runId };
    }
    throw notFound();
}

export async function taskEntryServer({
    port,
    origin,
    auth,
    oidc,
    backend,
    space,
}: Options) {
    const inFlight = new Map<string, number>();
    let cleaning: Promise<void> | undefined;
    let closing = false;
    function sweepAccounts() {
        if (closing || cleaning) return;
        cleaning = (async () => {
            for (const {
                ownerId: owner,
                spaceRequired,
            } of await auth.pendingPurges()) {
                if (closing) return;
                space?.drain(owner);
                if (inFlight.has(owner)) continue;
                try {
                    const drained = await backend(owner, {
                        kind: 'drainOwner',
                    });
                    if (
                        drained.status !== 204 ||
                        (space && !space.drain(owner, true))
                    )
                        continue;
                    const result = await backend(owner, { kind: 'purgeOwner' });
                    if (
                        !('json' in result) ||
                        !('complete' in result.json) ||
                        !result.json.complete
                    )
                        continue;
                    if (space ? !(await space.purge(owner)) : spaceRequired)
                        continue;
                    await auth.finishPurge(owner);
                } catch {
                    // Retain the durable cleanup request and retry dependencies independently of login.
                }
            }
        })()
            .catch(() => undefined)
            .finally(() => {
                cleaning = undefined;
            });
    }
    const handle = async (
        request: IncomingMessage,
        response: ServerResponse,
    ) => {
        let activeOwner: string | undefined;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader(
            'Content-Security-Policy',
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'" +
                (space ? ' ' + space.origin : '') +
                '; ' +
                "base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        );

        try {
            const url = request.url ?? '';
            if (!url.startsWith('/') || url.startsWith('//')) throw notFound();
            const [path = '', query] = url.split('?', 2);
            if (
                !path.startsWith('/api/') &&
                path !== '/auth' &&
                !path.startsWith('/auth/')
            )
                throw notFound();

            if (
                (request.method === 'POST' ||
                    (request.method === 'DELETE' &&
                        /^\/api\/space\/(?:files|projects)\/[^/]+$/.test(
                            path,
                        ))) &&
                request.headers.origin !== origin
            ) {
                throw new RequestError(
                    400,
                    'invalid_origin',
                    '请从任务入口提交请求。',
                );
            }
            if (
                path === '/auth' ||
                path.startsWith('/auth/') ||
                path.startsWith('/api/oidc/')
            ) {
                if (!oidc) throw notFound();
                await oidc(request, response, new URL(url, origin), !!space);
                return;
            }
            if (
                oidc &&
                ['/api/login', '/api/register', '/api/account/close'].includes(
                    path,
                )
            )
                throw notFound();
            if (request.method === 'POST' && path === '/api/login') {
                const login = await auth.login(
                    request,
                    await readJson(request, 4096),
                );
                response.setHeader('Set-Cookie', login.cookie);
                return json(response, 200, { account: login.account });
            }
            if (request.method === 'POST' && path === '/api/register') {
                return json(
                    response,
                    201,
                    await auth.register(await readJson(request, 4096)),
                );
            }
            if (request.method === 'POST' && path === '/api/logout') {
                response.setHeader('Set-Cookie', auth.logout(request));
                return json(response, 200, {});
            }
            if (request.method === 'POST' && path === '/api/account/close') {
                const cookie = await auth.closeAccount(
                    request,
                    await readJson(request, 4096),
                    !!space,
                );
                response.setHeader('Set-Cookie', cookie);
                sweepAccounts();
                return json(response, 200, {});
            }
            const account = await auth.account(request);
            activeOwner = account.ownerId;
            inFlight.set(activeOwner, (inFlight.get(activeOwner) ?? 0) + 1);
            if (request.method === 'GET' && path === '/api/session') {
                return json(response, 200, { account: account.account });
            }
            if (
                space &&
                (path === '/api/space' || path.startsWith('/api/space/'))
            ) {
                const result = await space.route(
                    account.ownerId,
                    request.method,
                    path,
                    () => readJson(request, 32 * 1024),
                    request.headersDistinct['idempotency-key'],
                );
                if ('deleteStatus' in result && result.deleteStatus === 204) {
                    response.writeHead(204).end();
                    return;
                }
                if ('deleteStatus' in result && result.deleteStatus === 202)
                    return json(response, 202, { state: 'deleting' });
                if ('executionStatus' in result)
                    return json(
                        response,
                        result.executionStatus,
                        result.execution,
                    );
                if ('redirect' in result && result.redirect) {
                    response.writeHead(302, { Location: result.redirect });
                    response.end();
                    return;
                }
                return json(response, 200, result);
            }
            if (path === '/api/tasks' || path.startsWith('/api/tasks/')) {
                const operation = await parseTaskRequest(
                    path,
                    query,
                    request.method,
                    request.headersDistinct['idempotency-key'],
                    async () => {
                        try {
                            return await readJson(request, 64 * 1024);
                        } catch (error) {
                            if (
                                error instanceof RequestError &&
                                error.status === 400
                            )
                                throw new RequestError(
                                    400,
                                    'invalid_input',
                                    '任务请求内容无效。',
                                );
                            throw error;
                        }
                    },
                    () => {
                        if (
                            Number(request.headers['content-length'] ?? 0) !==
                                0 ||
                            request.headers['transfer-encoding'] !== undefined
                        )
                            throw new RequestError(
                                400,
                                'invalid_input',
                                '此任务请求不接受正文。',
                            );
                    },
                );
                let result;
                if (operation.kind === 'taskSubmission') {
                    if (operation.input.source.kind === 'blank') {
                        result = await backend(account.ownerId, {
                            kind: 'createTask',
                            key: operation.key,
                            input: {
                                id: null,
                                name: operation.input.name,
                                sourceSpaceId: null,
                                inputFiles: [],
                                inputManifest: [],
                                inputDigest: createHash('sha256')
                                    .update('[]')
                                    .digest('hex'),
                            },
                        });
                    } else {
                        if (!space)
                            throw new RequestError(
                                503,
                                'source_unavailable',
                                '空间文件入口暂不可用。',
                            );
                        result = await space.createTask(
                            account.ownerId,
                            operation.key,
                            operation.input.name,
                            operation.input.source,
                        );
                    }
                } else result = await backend(account.ownerId, operation);
                if ('diff' in result) {
                    if (new URLSearchParams(query).get('download') === '1')
                        response.setHeader(
                            'Content-Disposition',
                            'attachment; filename="changes.patch"',
                        );
                    return reply(response, 200, 'text/plain', result.diff);
                }
                if (!('json' in result))
                    throw new Error('Invalid Task response');
                return json(response, result.status, result.json);
            }
            const operation = await route(request, path);
            const result = await backend(account.ownerId, operation);
            if ('diff' in result) {
                if (new URLSearchParams(query).get('download') === '1') {
                    response.setHeader(
                        'Content-Disposition',
                        'attachment; filename="bento.diff"',
                    );
                }
                return reply(response, 200, 'text/plain', result.diff);
            }
            if (!('json' in result))
                throw new Error('Unexpected execution response');
            return json(response, result.status, result.json);
        } catch (error) {
            if (response.destroyed) return;
            const failure =
                error instanceof RequestError
                    ? error
                    : new RequestError(
                          500,
                          'server_error',
                          '任务入口暂不可用，请稍后重试。',
                      );
            request.resume();
            json(response, failure.status, {
                error: {
                    code: failure.code,
                    message: failure.message,
                    ...(failure.issues ? { issues: failure.issues } : {}),
                    ...(failure.reason ? { reason: failure.reason } : {}),
                },
            });
        } finally {
            if (activeOwner) {
                const count = inFlight.get(activeOwner) ?? 0;
                if (count <= 1) inFlight.delete(activeOwner);
                else inFlight.set(activeOwner, count - 1);
            }
        }
    };

    let cleanupTimer: ReturnType<typeof setInterval> | undefined;
    const requests = new Set<Promise<void>>();
    let listener: ReturnType<typeof httpListener> | undefined;
    let stopping: Promise<void> | undefined;
    function close() {
        return (stopping ??= (async () => {
            closing = true;
            clearInterval(cleanupTimer);
            if (listener?.server.listening) await listener.close();
            // An aborted client can close its socket before its handler has finished.
            await Promise.allSettled(requests);
            await cleaning;
            await space?.close();
        })());
    }

    try {
        function dispatch(request: IncomingMessage, response: ServerResponse) {
            if (closing)
                return json(response, 503, {
                    error: { code: 'shutting_down', message: '服务正在停止。' },
                });
            const work = handle(request, response).finally(() =>
                requests.delete(work),
            );
            requests.add(work);
            return work;
        }
        listener = httpListener((request, response) => {
            void dispatch(request, response);
        });
        const server = listener.server;
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, '127.0.0.1', () => {
                server.off('error', reject);
                resolve();
            });
        });
        const address = server.address();
        if (!address || typeof address === 'string')
            throw new Error('HTTP listener unavailable');
        cleanupTimer = setInterval(sweepAccounts, 2000).unref();
        sweepAccounts();
        return { origin: 'http://127.0.0.1:' + address.port, close };
    } catch (error) {
        await close();
        throw error;
    }
}
