import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sessionAuth } from './auth.ts';
import {
    notFound,
    projectInput,
    RequestError,
    resourceId,
    runPrompt,
} from './protocol.ts';
import type { Backend, Operation } from './protocol.ts';

type Options = {
    mode: 'mock' | 'http';
    origin: string;
    auth: ReturnType<typeof sessionAuth>;
    backend: Backend;
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
    const [, api, projects, rawProject, runs, rawRun, diff, ...rest] =
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

    if (rawRun !== undefined && method === 'GET') {
        const runId = decodeId(rawRun);
        if (diff === undefined) return { kind: 'run', projectId, runId };
        if (diff === 'diff') return { kind: 'diff', projectId, runId };
    }
    throw notFound();
}

export function taskEntryServer({ mode, origin, auth, backend }: Options) {
    const assets = new Map([
        [
            '/',
            {
                type: 'text/html',
                body: readFileSync(
                    new URL('./index.html', import.meta.url),
                    'utf8',
                ).replace('__MODE__', mode),
            },
        ],
        [
            '/client.js',
            {
                type: 'text/javascript',
                body: readFileSync(
                    new URL('./client.js', import.meta.url),
                    'utf8',
                ),
            },
        ],
        [
            '/style.css',
            {
                type: 'text/css',
                body: readFileSync(
                    new URL('./style.css', import.meta.url),
                    'utf8',
                ),
            },
        ],
    ]);

    return createServer(
        { requestTimeout: 30_000 },
        async (request, response) => {
            response.setHeader('Cache-Control', 'no-store');
            response.setHeader('X-Content-Type-Options', 'nosniff');
            response.setHeader('Referrer-Policy', 'no-referrer');
            response.setHeader(
                'Content-Security-Policy',
                "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
                    "base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
            );

            try {
                const url = request.url ?? '';
                if (!url.startsWith('/') || url.startsWith('//'))
                    throw notFound();
                const [path = '', query] = url.split('?', 2);
                const asset =
                    request.method === 'GET' ? assets.get(path) : undefined;
                if (asset) return reply(response, 200, asset.type, asset.body);
                if (!path.startsWith('/api/')) throw notFound();

                if (
                    request.method === 'POST' &&
                    request.headers.origin !== origin
                ) {
                    throw new RequestError(
                        400,
                        'invalid_origin',
                        '请从任务入口提交请求。',
                    );
                }
                if (request.method === 'POST' && path === '/api/login') {
                    const login = auth.login(
                        request,
                        await readJson(request, 4096),
                    );
                    response.setHeader('Set-Cookie', login.cookie);
                    return json(response, 200, { account: login.account });
                }
                if (request.method === 'POST' && path === '/api/logout') {
                    response.setHeader('Set-Cookie', auth.logout(request));
                    return json(response, 200, {});
                }
                const account = auth.account(request);
                if (request.method === 'GET' && path === '/api/session') {
                    return json(response, 200, { account: account.account });
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
                    error: { code: failure.code, message: failure.message },
                });
            }
        },
    );
}
