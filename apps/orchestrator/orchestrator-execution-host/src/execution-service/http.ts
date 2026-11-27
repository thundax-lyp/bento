import { createHash, timingSafeEqual } from 'node:crypto';
import { wellFormed } from '@/shared/text-snapshot.ts';
import {
    createServer,
    type IncomingMessage,
    type ServerResponse,
} from 'node:http';
import {
    invalid,
    object,
    textSnapshot,
    missing,
    oversized,
    projectInput,
    RequestError,
    runInput,
} from './input.ts';
import {
    diagnosticAuthorization,
    diagnosticKeyPrefix,
    diagnosticPrompt,
    type AdminDiagnostics,
} from './admin-diagnostics.ts';
import type { ProjectDeletionReceipt, Store } from './store/index.ts';

const digest = (value: string) => createHash('sha256').update(value).digest();
const maxProjectBody = 6 * 1024 * 1024 + 3 * 1024 * 1024;
const maxRunBody = 128 * 1024;

const uuidV4 =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

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

type Tasks = {
    environmentVersion: string;
    runView(run: ReturnType<Store['findRun']>): unknown;
    cancel(owner: string, taskId: string, runId: string): unknown;
    retry(
        owner: string,
        taskId: string,
        runId: string,
        key: string,
    ): { status: number; retry: unknown };
    purgeSource(
        owner: string,
        spaceId: string,
        operationId: string,
    ): Promise<boolean>;
};

function taskKey(req: IncomingMessage) {
    const keys = req.headersDistinct['idempotency-key'];
    if (keys?.length !== 1 || !keys[0] || !uuidV4.test(keys[0]))
        throw new RequestError(
            400,
            'invalid_key',
            'A single Idempotency-Key is required.',
        );
    return keys[0];
}

function taskQuery(url: URL, keys: readonly string[]) {
    for (const name of url.searchParams.keys())
        if (!keys.includes(name) || url.searchParams.getAll(name).length !== 1)
            throw invalid('Invalid query parameters.');
}

function emptyTaskBody(req: IncomingMessage) {
    if (
        Number(req.headers['content-length'] ?? 0) !== 0 ||
        req.headers['transfer-encoding'] !== undefined
    )
        throw invalid('Request body must be empty.');
}

function taskIdentifier(value: string | null | undefined) {
    if (!value || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw missing();
    return value;
}

async function handleTasks(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    owner: string,
    store: Store,
    tasks: Tasks,
    wake: () => void,
) {
    const pathname = url.pathname;
    const method = req.method;
    if (pathname === '/v1/account/drain' && method === 'POST') {
        taskQuery(url, []);
        emptyTaskBody(req);
        store.drainOwner(owner);
        return res.writeHead(204, { 'cache-control': 'no-store' }).end();
    }
    if (pathname === '/v1/tasks') {
        if (method === 'GET') {
            taskQuery(url, ['creationKey']);
            const key = url.searchParams.get('creationKey');
            if (key !== null && !uuidV4.test(key))
                throw invalid('Invalid creation key.');
            return json(res, 200, {
                items: store.tasks(owner, key ?? undefined),
            });
        }
        if (method !== 'POST') throw missing();
        taskQuery(url, []);
        const key = taskKey(req);
        const data = object(await body(req, 8 * 1024 * 1024));
        const {
            id,
            name,
            sourceSpaceId,
            inputFiles,
            inputManifest,
            inputDigest,
        } = data;
        if (
            Object.keys(data).length !== 6 ||
            (id !== null && (typeof id !== 'string' || !uuidV4.test(id))) ||
            typeof name !== 'string' ||
            [...name.trim()].length < 1 ||
            [...name.trim()].length > 120 ||
            !wellFormed(name) ||
            (sourceSpaceId !== null && typeof sourceSpaceId !== 'string') ||
            typeof inputDigest !== 'string' ||
            !/^[0-9a-f]{64}$/.test(inputDigest) ||
            !Array.isArray(inputManifest)
        )
            throw invalid('Invalid Task input.');
        if (sourceSpaceId !== null) taskIdentifier(sourceSpaceId);
        const manifest = inputManifest.map((entry) => {
            const { fileId, path, bytes, sha256 } = object(entry);
            if (
                Object.keys(entry).length !== 4 ||
                typeof fileId !== 'string' ||
                typeof path !== 'string' ||
                typeof bytes !== 'number' ||
                !Number.isSafeInteger(bytes) ||
                bytes < 0 ||
                typeof sha256 !== 'string' ||
                !/^[0-9a-f]{64}$/.test(sha256)
            )
                throw invalid('Invalid Task manifest.');
            taskIdentifier(fileId);
            return { fileId, path, bytes, sha256 };
        });
        const result = store.createTask(
            owner,
            key,
            {
                id,
                name: name.trim(),
                sourceSpaceId,
                inputFiles: textSnapshot(inputFiles),
                inputManifest: manifest,
                inputDigest,
            },
            tasks.environmentVersion,
        );
        wake();
        return json(res, result.replay ? 200 : 202, { task: result.task });
    }

    const source =
        /^\/v1\/task-sources\/([^/]+)(?:\/(deletion)|\/files\/([^/]+)\/deletion-holds\/([^/]+))?$/.exec(
            pathname,
        );
    if (source) {
        const [, scope, impact, file, operation] = source;
        const spaceId = taskIdentifier(scope);
        const legacy = url.searchParams.get('legacyProjectId');
        if (legacy !== null) taskIdentifier(legacy);
        if (file && operation) {
            taskQuery(url, ['legacyProjectId']);
            emptyTaskBody(req);
            const fileId = taskIdentifier(file);
            if (!uuidV4.test(operation)) throw missing();
            if (method === 'POST')
                return json(
                    res,
                    200,
                    store.acquireTaskInputDeleteHold(
                        owner,
                        spaceId,
                        fileId,
                        operation,
                        legacy,
                    ),
                );
            if (method === 'DELETE')
                return json(
                    res,
                    200,
                    store.releaseTaskInputDeleteHold(
                        owner,
                        spaceId,
                        fileId,
                        operation,
                        legacy,
                    ),
                );
            throw missing();
        }
        if (impact && method === 'GET') {
            taskQuery(url, ['legacyProjectId']);
            return json(
                res,
                200,
                store.taskSourceImpact(owner, spaceId, legacy),
            );
        }
        if (impact || method !== 'DELETE') throw missing();
        taskQuery(url, ['legacyProjectId', 'phase']);
        emptyTaskBody(req);
        const phase = url.searchParams.get('phase');
        if (phase !== 'hold' && phase !== 'release' && phase !== 'commit')
            throw invalid('Invalid deletion phase.');
        const key = taskKey(req);
        const result = store.changeTaskSourceDeletion(
            owner,
            spaceId,
            key,
            legacy,
            phase,
        );
        if (result.state === 'denied')
            throw new RequestError(
                409,
                result.code ?? 'project_busy',
                'Project deletion is blocked.',
            );
        if (result.state === 'held') return json(res, 202, { state: 'held' });
        if (
            result.state === 'committing' &&
            (phase !== 'commit' ||
                !(await tasks.purgeSource(owner, spaceId, key)))
        )
            return json(res, 202, { state: 'deleting' });
        return res.writeHead(204, { 'cache-control': 'no-store' }).end();
    }

    const route =
        /^\/v1\/tasks\/([^/]+)(?:\/(prepare|events|runs)(?:\/([^/]+)(?:\/(cancel|retry|results)(?:\/(1)\/diff)?)?)?)?$/.exec(
            pathname,
        );
    if (!route) throw missing();
    const [, id, section, rawRunId, action, version] = route;
    if (!id || !uuidV4.test(id)) throw missing();
    if (section === 'events' && !rawRunId && method === 'GET') {
        taskQuery(url, ['after']);
        const after = url.searchParams.get('after') ?? '0';
        if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))
            throw invalid('Invalid event cursor.');
        return json(res, 200, {
            items: store.taskEvents(owner, id, Number(after)),
        });
    }
    if (
        section === 'runs' &&
        rawRunId &&
        action === 'results' &&
        version &&
        method === 'GET'
    ) {
        taskQuery(url, ['view', 'download']);
        const view = url.searchParams.get('view');
        const download = url.searchParams.get('download');
        if (
            (view !== 'incremental' && view !== 'cumulative') ||
            (download !== null && download !== '1')
        )
            throw invalid('Invalid diff options.');
        const run = store.taskRunRow(owner, id, rawRunId);
        const result = store.taskResultRow(run.id);
        if (!result || run.status !== 'succeeded')
            throw new RequestError(
                409,
                'diff_unavailable',
                'Run result is unavailable.',
            );
        if (download)
            res.setHeader(
                'content-disposition',
                'attachment; filename="changes.patch"',
            );
        return send(res, 200, result[view], 'text/plain');
    }
    taskQuery(url, []);
    if (!section && method === 'GET')
        return json(res, 200, { task: store.task(owner, id) });
    if (section === 'prepare' && !rawRunId && method === 'POST') {
        emptyTaskBody(req);
        const task = store.prepareTask(owner, id);
        wake();
        return json(res, 200, { task });
    }
    if (section !== 'runs') throw missing();
    if (!rawRunId && method === 'GET')
        return json(res, 200, {
            items: store.taskRunRows(owner, id).map(tasks.runView),
        });
    if (!rawRunId && method === 'POST') {
        const key = taskKey(req);
        const contents = object(await body(req, 64 * 1024));
        if (Object.keys(contents).length !== 1)
            throw invalid('Invalid Run input.');
        const input = runInput(contents, key);
        const result = store.enqueueTaskRun(owner, id, key, input.prompt);
        wake();
        return json(res, result.replay ? 200 : 202, {
            run: tasks.runView(result.run),
        });
    }
    if (!rawRunId || !uuidV4.test(rawRunId)) throw missing();
    if (!action && method === 'GET')
        return json(res, 200, {
            run: tasks.runView(store.taskRunRow(owner, id, rawRunId)),
        });
    if (action === 'cancel' && !version && method === 'POST') {
        emptyTaskBody(req);
        const run = tasks.cancel(owner, id, rawRunId);
        wake();
        return json(res, 200, { run });
    }
    if (action === 'retry' && !version && method === 'POST') {
        emptyTaskBody(req);
        const { status, retry } = tasks.retry(
            owner,
            id,
            rawRunId,
            taskKey(req),
        );
        wake();
        return json(res, status, { retry });
    }
    if (action === 'results' && !version && method === 'GET') {
        const run = store.taskRunRow(owner, id, rawRunId);
        const result = store.taskResultRow(run.id);
        if (!result || run.status !== 'succeeded')
            throw new RequestError(
                409,
                'diff_unavailable',
                'Run result is unavailable.',
            );
        const {
            version,
            summary,
            checks,
            incrementalSha256,
            cumulativeSha256,
            createdAt,
        } = result;
        return json(res, 200, {
            result: {
                runId: run.id,
                version,
                summary,
                checks,
                incrementalSha256,
                cumulativeSha256,
                createdAt,
            },
        });
    }
    throw missing();
}

export class RetryUnavailable extends RequestError {
    readonly reason: string;

    constructor(reason: string) {
        super(409, 'run_not_retryable', 'Run cannot be retried.');
        this.reason = reason;
    }
}

export function executionHttp(
    store: Store,
    token: string,
    wake: () => void,
    purgeOwner: (owner: string) => Promise<boolean>,
    requestCancellation: Store['cancelQueuedRun'],
    advanceProjectDeletion: (
        owner: string,
        projectId: string,
        operationId: string,
    ) => Promise<ProjectDeletionReceipt>,
    tasks?: Tasks,
    addProjectRun?: Store['addRun'],
    adminDiagnostics?: AdminDiagnostics,
    validateDiagnosticSession?: Parameters<Store['addDiagnosticRun']>[4],
) {
    const authorization = digest('Bearer ' + token);
    const admin = diagnosticAuthorization(token, adminDiagnostics);
    const server = createServer(async (req, res) => {
        try {
            const supplied = req.headers.authorization;
            const pathname = (req.url ?? '').split('?')[0];
            const adminNamespace = /^\/v1\/admin(?:$|\/)/.test(pathname ?? '');
            const workspaceIdentity =
                !!supplied && timingSafeEqual(authorization, digest(supplied));
            if (admin.matches(supplied)) {
                const route =
                    /^\/v1\/admin\/workspaces\/([^/]+)\/diagnostic-runs(?:\/([^/]+))?$/.exec(
                        pathname ?? '',
                    );
                const workspace = route?.[1];
                const runId = route?.[2];
                const submit = req.method === 'POST' && !runId;
                if (!workspace || (!submit && !(req.method === 'GET' && runId)))
                    throw new RequestError(
                        403,
                        'operation_denied',
                        'Operation denied.',
                    );
                const owner = admin.authorize(
                    req.headers['x-bento-admin-subject'],
                    workspace,
                );
                if (runId)
                    return json(
                        res,
                        200,
                        store.diagnosticRun(owner, workspace, runId),
                    );
                const result = store.addDiagnosticRun(
                    owner,
                    workspace,
                    diagnosticKeyPrefix + taskKey(req),
                    diagnosticPrompt,
                    validateDiagnosticSession,
                );
                json(res, result.replay ? 200 : 202, result.run);
                wake();
                return;
            }
            if (adminNamespace && workspaceIdentity)
                throw new RequestError(403, 'caller_denied', 'Caller denied.');
            const owner = req.headers['x-bento-owner-id'];
            if (
                !workspaceIdentity ||
                typeof owner !== 'string' ||
                !/^[!-~]{1,256}$/.test(owner) ||
                owner.includes(',')
            )
                throw new RequestError(
                    401,
                    'unauthorized',
                    'Service authentication required.',
                );

            if (
                tasks &&
                pathname &&
                (/^\/v1\/tasks(?:$|\/)/.test(pathname) ||
                    pathname.startsWith('/v1/task-sources/') ||
                    pathname === '/v1/account/drain')
            )
                return await handleTasks(
                    req,
                    res,
                    new URL(req.url ?? '/', 'http://127.0.0.1'),
                    owner,
                    store,
                    tasks,
                    wake,
                );
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

            const impact = /^\/v1\/projects\/([^/]+)\/deletion$/.exec(
                pathname ?? '',
            );
            if (impact?.[1] && req.method === 'GET')
                return json(
                    res,
                    200,
                    store.projectDeletionImpact(owner, impact[1]),
                );

            const route =
                /^\/v1\/projects\/([^/]+)(?:\/(runs)(?:\/([^/]+)(\/(diff|cancel))?)?)?$/.exec(
                    pathname ?? '',
                );
            if (!route) throw missing();
            const [, projectId, runs, runId, , action] = route;
            if (!projectId) throw missing();
            if (!runs && req.method === 'DELETE') {
                const keys = req.headersDistinct['idempotency-key'];
                const key = keys?.[0];
                if (keys?.length !== 1 || !key || !uuidV4.test(key))
                    throw invalid('Invalid Idempotency-Key.');
                const receipt = await advanceProjectDeletion(
                    owner,
                    projectId,
                    key,
                );
                if (receipt.state === 'denied')
                    throw new RequestError(
                        409,
                        receipt.code,
                        'Project deletion is blocked.',
                    );
                if (receipt.state === 'deleting')
                    return json(res, 202, { state: 'deleting' });
                res.writeHead(204, { 'cache-control': 'no-store' }).end();
                return;
            }
            if (!runs && req.method === 'GET')
                return json(res, 200, store.project(owner, projectId));
            if (runs && !runId) {
                if (req.method === 'GET')
                    return json(res, 200, {
                        runs: store.runs(owner, projectId),
                    });
                if (req.method === 'POST') {
                    store.requireRunProject(owner, projectId);
                    const key = req.headers['idempotency-key'];
                    const bodyInput = object(await body(req, maxRunBody));
                    const { sessionId } = bodyInput;
                    if (
                        sessionId !== undefined &&
                        (!addProjectRun ||
                            typeof sessionId !== 'string' ||
                            !uuidV4.test(sessionId))
                    )
                        throw invalid('Invalid project Session.');
                    if (
                        typeof key === 'string' &&
                        key.startsWith(diagnosticKeyPrefix)
                    )
                        throw invalid('Reserved Idempotency-Key.');
                    const input = runInput(
                        bodyInput,
                        typeof key === 'string' ? key : undefined,
                    );
                    const result = (addProjectRun ?? store.addRun.bind(store))(
                        owner,
                        projectId,
                        input.key,
                        input.prompt,
                        sessionId,
                    );
                    json(res, result.replay ? 200 : 202, result.run);
                    wake();
                    return;
                }
            }
            if (runId && action === 'cancel' && req.method === 'POST') {
                const run = requestCancellation(owner, projectId, runId);
                json(res, 200, run);
                wake();
                return;
            }
            if (runId && req.method === 'GET' && action !== 'cancel') {
                if (action === 'diff')
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
                error: {
                    code:
                        problem.code === 'payload_too_large' &&
                        /^\/v1\/tasks(?:$|\/)/.test(req.url ?? '')
                            ? 'too_large'
                            : problem.code,
                    message: problem.message,
                    ...(problem instanceof RetryUnavailable
                        ? { reason: problem.reason }
                        : {}),
                },
            });
        }
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    return server;
}
