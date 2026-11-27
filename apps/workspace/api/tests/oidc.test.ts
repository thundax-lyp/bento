import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { localHost } from '@/apps/orchestrator/src/execution-service/local.ts';
import {
    serveExecution,
    snapshotSha256,
} from '@/apps/orchestrator/src/execution-service/service.ts';
import test from 'node:test';
import { mockAccounts } from '../src/account-store.ts';
import { sessionAuth } from '../src/auth.ts';
import { httpBackend } from '../src/execution-service-http.ts';
import { mockBackend } from '../src/mock.ts';
import {
    oidcFixtureClient,
    oidcFixtureEmail,
    startOidcFixture,
} from './fixtures/oidc-fixture.ts';
import { keycloakAuth } from '../src/oidc.ts';
import { taskEntryServer } from '../src/server.ts';
import { mySpace } from '../src/space/index.ts';
import { spaceObjectKey, spaceStorage } from '../src/space/storage.ts';

test('built auth pages retain the OIDC login, logout and account closure contract', async (t) => {
    const fixture = await startOidcFixture();
    t.after(() => fixture.close());
    const origin = 'http://127.0.0.1:8080';
    const ownerId = 'fixture-owner';
    const records = mockAccounts([
        { account: oidcFixtureEmail, ownerId, inviteSha256: '' },
    ]);
    const store = {
        ...records,
        bindOidc: () => records.byOwner(ownerId),
    };
    const auth = sessionAuth(store, false, true);
    const oidc = await keycloakAuth({
        ...oidcFixtureClient,
        origin: new URL(origin),
        issuer: fixture.issuer,
        store,
        auth,
    });
    const server = await taskEntryServer({
        port: 0,
        origin,
        backend: mockBackend(),
        auth,
        oidc,
    });
    t.after(() => server.close());

    const request = (path: string, options?: RequestInit) =>
        fetch(server.origin + path, { redirect: 'manual', ...options });
    async function status(response: Promise<Response>, expected: number) {
        const result = await response;
        assert.equal(result.status, expected, await result.clone().text());
        return result;
    }
    function cookie(response: Response, name: string) {
        const value = response.headers
            .getSetCookie()
            .find((value) => value.startsWith(name + '='));
        assert.ok(value);
        return value;
    }
    function location(response: Response) {
        const target = response.headers.get('location');
        assert.ok(target);
        return new URL(target, origin);
    }
    const session = (value: string) =>
        request('/api/session', { headers: { Cookie: value } });
    const submit = (path: string, value = '', body = '', from = origin) =>
        request(path, {
            method: 'POST',
            body,
            headers: { Origin: from, Cookie: value },
        });

    async function checkAsset(path: string, file: string, authCookie = '') {
        const result = await status(
            request(path, { headers: { Cookie: authCookie } }),
            200,
        );
        const css = file === 'style.css';
        assert.equal(
            result.headers.get('content-type'),
            css ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8',
        );
        assert.equal(
            result.headers.get('referrer-policy'),
            css ? 'no-referrer' : 'same-origin',
        );
        assert.equal(
            result.headers.get('content-security-policy'),
            css
                ? "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
                : "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' " +
                      fixture.issuer,
        );
        assert.equal(result.headers.get('cache-control'), 'no-store');
        assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
        const body = Buffer.from(await result.arrayBuffer());
        assert.deepEqual(
            body,
            await readFile(new URL('../../auth/dist/' + file, import.meta.url)),
        );
        return body.toString('utf8');
    }

    function grant(
        response: Response,
        code: string,
        subject = 'fixture-subject',
        invited = true,
    ) {
        const target = location(response);
        assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
        fixture.authorization(target);
        fixture.setCode(code, subject, invited);
        const transaction = cookie(response, 'bento_oidc');
        assert.match(
            transaction,
            /^bento_oidc=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=300$/,
        );
        const callback = new URL('/api/oidc/callback', origin);
        callback.searchParams.set(
            'state',
            target.searchParams.get('state') ?? '',
        );
        callback.searchParams.set('code', code);
        return { callback, transaction: transaction.split(';', 1)[0] ?? '' };
    }
    function callback(
        { callback: url, transaction }: ReturnType<typeof grant>,
        sessionCookie = '',
    ) {
        return request(url.pathname + url.search, {
            headers: {
                Cookie: [transaction, sessionCookie].filter(Boolean).join('; '),
            },
        });
    }
    function checkLogout(response: Response) {
        const target = location(response);
        assert.equal(
            target.origin + target.pathname,
            fixture.issuer + '/end-session',
        );
        assert.match(
            target.searchParams.get('id_token_hint') ?? '',
            /^[\w-]+\.[\w-]+\.[\w-]+$/,
        );
        assert.equal(
            target.searchParams.get('post_logout_redirect_uri'),
            origin + '/auth',
        );
        assert.match(cookie(response, 'bento_one'), /^bento_one=; .*Max-Age=0/);
    }
    async function login(code: string) {
        const transaction = grant(
            await status(request('/api/oidc/start'), 303),
            code,
        );
        const result = await status(callback(transaction), 303);
        assert.equal(location(result).href, origin + '/');
        const value = cookie(result, 'bento_one');
        assert.match(
            value,
            /^bento_one=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=86400$/,
        );
        return value.split(';', 1)[0] ?? '';
    }

    const guest = await checkAsset('/auth', 'login.html');
    assert.match(guest, /href="\/api\/oidc\/start"/);
    await checkAsset('/auth/style.css', 'style.css');
    for (const path of ['/api/login', '/api/register', '/api/account/close']) {
        await status(submit(path), 404);
    }
    const first = grant(await status(request('/api/oidc/start'), 303), 'first');
    const wrongState = new URL(first.callback);
    wrongState.searchParams.set('state', 'wrong');
    await status(callback({ ...first, callback: wrongState }), 401);
    assert.equal(fixture.tokenRequests(), 0);
    const firstLogin = await status(callback(first), 303);
    assert.equal(location(firstLogin).href, origin + '/');
    const firstCookie = cookie(firstLogin, 'bento_one').split(';', 1)[0] ?? '';
    await status(callback(first), 401);
    assert.equal(fixture.tokenRequests(), 1);
    await status(
        callback(
            grant(
                await status(request('/api/oidc/start'), 303),
                'uninvited',
                'uninvited',
                false,
            ),
        ),
        401,
    );

    const settings = await checkAsset('/auth', 'account.html', firstCookie);
    assert.match(settings, /method="post" action="\/api\/oidc\/logout"/);
    assert.match(settings, /method="post" action="\/api\/oidc\/close"/);
    const confirmation = settings.indexOf('name="confirmed"');
    assert.ok(confirmation >= 0);
    const beforeConfirmation = settings
        .slice(0, confirmation)
        .replace(/\s+/g, ' ');
    assert.ok(
        beforeConfirmation.includes(
            '注销会立即结束此 Bento 账号的所有会话。已提交的任务会继续执行。任务结束、待核对事项结案且未完成上传的签发地址到期后，系统会继续清理。',
        ),
    );
    assert.ok(
        beforeConfirmation.includes(
            '项目、工作区、上传文件、任务记录和补丁清理后无法恢复。',
        ),
    );
    assert.match(settings, /name="confirmed"\s+value="yes"\s+required/);
    for (const path of ['/api/oidc/close', '/api/oidc/logout']) {
        await status(
            submit(path, firstCookie, 'confirmed=yes', 'http://127.0.0.1:8081'),
            400,
        );
    }
    await status(session(firstCookie), 200);
    checkLogout(await status(submit('/api/oidc/logout', firstCookie), 303));
    await status(session(firstCookie), 401);

    const secondCookie = await login('second');
    await status(submit('/api/oidc/close', secondCookie), 401);
    async function closeGrant(code: string, subject: string) {
        const result = await status(
            submit('/api/oidc/close', secondCookie, 'confirmed=yes'),
            303,
        );
        const target = location(result);
        assert.equal(target.searchParams.get('prompt'), 'login');
        assert.equal(target.searchParams.get('max_age'), '0');
        return grant(result, code, subject);
    }
    await status(
        callback(await closeGrant('wrong-subject', 'other'), secondCookie),
        401,
    );
    await status(session(secondCookie), 200);
    const closed = await status(
        callback(await closeGrant('close', 'fixture-subject'), secondCookie),
        303,
    );
    checkLogout(closed);
    assert.match(cookie(closed, 'bento_oidc'), /^bento_oidc=; .*Max-Age=0/);
    assert.equal((await records.byOwner(ownerId))?.closed, true);
    await status(session(secondCookie), 401);
    await status(
        callback(
            grant(await status(request('/api/oidc/start'), 303), 'closed'),
        ),
        401,
    );
});

test(
    'WEB-01 closes an OIDC account and resumes cleanup after trusted Task closure',
    { timeout: 25_000 },
    async (t) => {
        function barrier() {
            let resolve!: () => void;
            const promise = new Promise<void>((done) => {
                resolve = done;
            });
            return { promise, resolve };
        }
        const state = await mkdtemp(join(tmpdir(), 'bento-oidc-cleanup-'));
        const dbPath = join(state, 'space.sqlite');
        const token = 'fixture-only-bento-service-bearer';
        const owner = {
            ownerId: 'account-a',
            account: oidcFixtureEmail,
            inviteSha256: '',
        };
        const other = {
            ownerId: 'account-b',
            account: 'other@example.test',
            inviteSha256: '',
        };
        const accounts = mockAccounts([owner, other]);
        const fixture = await startOidcFixture();
        const store = {
            ...accounts,
            bindOidc: () => accounts.byOwner(owner.ownerId),
        };
        const origin = 'http://127.0.0.1:8080';
        const controllerPath = fileURLToPath(
            new URL(
                '../../../orchestrator/tests/execution-service/fixtures/controller.ts',
                import.meta.url,
            ),
        );
        const registerPaths = fileURLToPath(
            new URL('../../../../register-paths.mjs', import.meta.url),
        );
        const child = spawn(
            process.execPath,
            [
                '--import',
                registerPaths,
                '--experimental-strip-types',
                '--test-name-pattern=^$',
                controllerPath,
                '--task-crash-controller',
                state,
                'before-receipt',
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        const childClosed = once(child, 'close');
        const childLines = createInterface({ input: child.stdout });
        child.stderr.resume();
        let execution: Awaited<ReturnType<typeof serveExecution>> | undefined;
        let web: Awaited<ReturnType<typeof taskEntryServer>> | undefined;
        const workerEntered = barrier();
        const workerBarrier = barrier();
        const purgeBarrier = barrier();
        t.after(async () => {
            workerBarrier.resolve();
            purgeBarrier.resolve();
            child.kill('SIGKILL');
            await childClosed;
            childLines.close();
            await web?.close();
            await execution?.close();
            await fixture.close();
            await rm(state, { recursive: true, force: true });
        });

        const [address] = await Promise.race([
            once(childLines, 'line'),
            childClosed.then(() => {
                throw new Error('Crash controller exited before listening');
            }),
        ]);
        let executionUrl = address as string;
        async function privateCall(
            path: string,
            method = 'GET',
            body?: object,
        ) {
            const response = await fetch(executionUrl + '/v1' + path, {
                method,
                headers: {
                    Authorization: 'Bearer ' + token,
                    'X-Bento-Owner-Id': owner.ownerId,
                    ...(body
                        ? {
                              'Content-Type': 'application/json',
                              'Idempotency-Key': randomUUID(),
                          }
                        : {}),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(5000),
            });
            return { status: response.status, body: await response.json() };
        }
        async function until<T>(
            label: string,
            read: () => T | Promise<T>,
            matches: (value: T) => boolean,
        ) {
            for (let attempt = 0; attempt < 400; attempt++) {
                const value = await read();
                if (matches(value)) return value;
                await delay(25);
            }
            assert.fail('Timed out: ' + label);
        }
        async function createTask(name: string) {
            const created = await privateCall('/tasks', 'POST', {
                id: null,
                name,
                sourceSpaceId: null,
                inputFiles: [],
                inputManifest: [],
                inputDigest: snapshotSha256([]),
            });
            assert.equal(created.status, 202);
            const id = created.body.task.id as string;
            const path = '/tasks/' + id;
            await until(
                'Task preparation',
                () => privateCall(path),
                (view) => view.body.task?.status === 'ready',
            );
            return { id, path };
        }
        async function submitRun(path: string, prompt: string) {
            const submitted = await privateCall(path + '/runs', 'POST', {
                prompt,
            });
            assert.equal(submitted.status, 202);
            const id = submitted.body.run.id as string;
            return { id, path: path + '/runs/' + id };
        }
        async function openExecution() {
            const host = localHost(join(state, 'volume'));
            execution = await serveExecution({
                state,
                token,
                retryMs: 20,
                host: {
                    ...host,
                    async worker(request, signal, slot, exit) {
                        if (request.prompt === 'hold-until-account-closed') {
                            workerEntered.resolve();
                            await workerBarrier.promise;
                        }
                        return host.worker(request, signal, slot, exit);
                    },
                },
            });
            executionUrl = execution.url;
            return execution;
        }

        const blockedTask = await createTask('Needs review');
        const blockedRun = await submitRun(blockedTask.path, 'append once');
        assert.deepEqual(await childClosed, [79, null]);
        let service = await openExecution();
        await until(
            'Run recovery',
            () => privateCall(blockedRun.path),
            (view) => view.body.run?.status === 'needs_review',
        );
        const activeTask = await createTask('Active at closure');
        const activeRun = await submitRun(
            activeTask.path,
            'hold-until-account-closed',
        );
        await workerEntered.promise;
        assert.equal(
            (await privateCall(activeRun.path)).body.run.status,
            'running',
        );

        const objects = new Map<string, Buffer>();
        const multipart = new Set<string>();
        const aborts = new Map<string, number>();
        const removals = new Map<string, number>();
        const pendingId = randomUUID();
        const pendingKey = spaceObjectKey(pendingId);
        const pendingObject = Buffer.from('unfinished');
        let failRemoval = false;
        const removalFailed = barrier();
        const storage = spaceStorage(
            'https://fixture.invalid',
            'fixture',
            'us-east-1',
        );
        storage.create = async (key) => {
            multipart.add(key);
            return 'fixture-upload';
        };
        storage.signPart = async () => 'https://fixture.invalid/signed-part';
        storage.abort = async (key) => {
            aborts.set(key, (aborts.get(key) ?? 0) + 1);
            multipart.delete(key);
        };
        storage.size = async (key) => objects.get(key)?.length ?? null;
        storage.remove = async (key) => {
            removals.set(key, (removals.get(key) ?? 0) + 1);
            if (key === pendingKey && failRemoval) {
                failRemoval = false;
                removalFailed.resolve();
                throw new Error('Unconfirmed fixture object removal');
            }
            objects.delete(key);
        };

        let purgeRequestsPaused = false;
        const purgeEntered = barrier();
        const executionPurges: number[] = [];
        let drains = 0;
        let spacePurgeAttempts = 0;
        async function openWorkspace() {
            const real = httpBackend(executionUrl, token, 3000);
            const backend: typeof real = async (ownerId, operation) => {
                if (operation.kind === 'purgeOwner' && purgeRequestsPaused) {
                    purgeEntered.resolve();
                    await purgeBarrier.promise;
                    throw new Error(
                        'Fixture interrupted before execution purge',
                    );
                }
                const response = await real(ownerId, operation);
                if (operation.kind === 'drainOwner')
                    drains += Number(response.status === 204);
                if (operation.kind === 'purgeOwner')
                    executionPurges.push(response.status);
                return response;
            };
            const auth = sessionAuth(store, false, true);
            const oidc = await keycloakAuth({
                ...oidcFixtureClient,
                origin: new URL(origin),
                issuer: fixture.issuer,
                store,
                auth,
            });
            const space = mySpace(dbPath, storage, backend);
            web = await taskEntryServer({
                port: 0,
                origin,
                auth,
                oidc,
                backend,
                space: {
                    ...space,
                    async purge(ownerId) {
                        const result = await space.purge(ownerId);
                        spacePurgeAttempts++;
                        return result;
                    },
                },
            });
            return auth;
        }
        const auth = await openWorkspace();
        const otherCookie = auth
            .startSession(
                { headers: {} } as Parameters<typeof auth.startSession>[0],
                other,
            )
            .cookie.split(';', 1)[0]!;
        async function request(
            path: string,
            expected: number,
            options: RequestInit = {},
        ) {
            assert.ok(web);
            const response = await fetch(web.origin + path, {
                redirect: 'manual',
                signal: AbortSignal.timeout(5000),
                ...options,
            });
            assert.equal(
                response.status,
                expected,
                await response.clone().text(),
            );
            return response;
        }
        function cookie(response: Response, name: string) {
            const header = response.headers
                .getSetCookie()
                .find((item) => item.startsWith(name + '='));
            assert.ok(header);
            return header.split(';', 1)[0]!;
        }
        async function exchange(
            code: string,
            subject: string,
            priorSession?: string,
        ) {
            const start = priorSession
                ? await request('/api/oidc/close', 303, {
                      method: 'POST',
                      headers: { Origin: origin, Cookie: priorSession },
                      body: 'confirmed=yes',
                  })
                : await request('/api/oidc/start', 303);
            const target = new URL(start.headers.get('location')!, origin);
            fixture.authorization(target);
            fixture.setCode(code, subject, true);
            const query = new URLSearchParams({
                code,
                state: target.searchParams.get('state')!,
            });
            return request(
                '/api/oidc/callback?' + query,
                subject === 'other-subject' ? 401 : 303,
                {
                    headers: {
                        Cookie: [cookie(start, 'bento_oidc'), priorSession]
                            .filter(Boolean)
                            .join('; '),
                    },
                },
            );
        }
        const first = cookie(
            await exchange('first-session', 'fixture-subject'),
            'bento_one',
        );
        const second = cookie(
            await exchange('second-session', 'fixture-subject'),
            'bento_one',
        );
        const ownedProject = randomUUID();
        function readRows<T>(read: (db: DatabaseSync) => T) {
            const db = new DatabaseSync(dbPath, { readOnly: true });
            try {
                return read(db);
            } finally {
                db.close();
            }
        }
        function seedSavedFile(ownerId: string, project: string) {
            const id = randomUUID();
            const bytes = Buffer.from('saved fixture');
            const db = new DatabaseSync(dbPath);
            try {
                db.prepare(
                    "INSERT INTO space_projects VALUES (?,?,'Fixture')",
                ).run(project, ownerId);
                db.prepare(
                    "INSERT INTO space_uploads(id,project,owner,path,size,manifest,state,expires) VALUES (?,?,?,?,?,?,'saved',?)",
                ).run(
                    id,
                    project,
                    ownerId,
                    'saved.txt',
                    bytes.length,
                    '[]',
                    Date.now() + 60_000,
                );
                objects.set(spaceObjectKey(id), bytes);
                return id;
            } finally {
                db.close();
            }
        }
        const ownedFile = seedSavedFile(owner.ownerId, ownedProject);
        const otherProject = randomUUID();
        const otherFile = seedSavedFile(other.ownerId, otherProject);
        await request('/api/space/projects/' + ownedProject + '/uploads', 200, {
            method: 'POST',
            headers: {
                Cookie: first,
                Origin: origin,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                id: pendingId,
                path: 'partial.txt',
                size: pendingObject.length,
                checksums: [
                    createHash('sha256').update(pendingObject).digest('base64'),
                ],
            }),
        });
        await request('/api/space/uploads/' + pendingId + '/part', 200, {
            method: 'POST',
            headers: {
                Cookie: first,
                Origin: origin,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ number: 1 }),
        });
        const uploadRow = () =>
            readRows((db) =>
                db
                    .prepare('SELECT signedUntil FROM space_uploads WHERE id=?')
                    .get(pendingId),
            );
        const signedUntil = uploadRow()?.signedUntil;
        assert.equal(typeof signedUntil, 'number');
        objects.set(pendingKey, pendingObject);
        // Ignore the orphan-abort probe that precedes multipart creation.
        aborts.clear();

        await exchange('wrong-subject', 'other-subject', first);
        await request('/api/session', 200, { headers: { Cookie: first } });
        await request('/api/session', 200, { headers: { Cookie: second } });
        await exchange('close-account', 'fixture-subject', first);
        for (const session of [first, second]) {
            await request('/api/session', 401, {
                headers: { Cookie: session },
            });
        }
        await request('/api/session', 200, {
            headers: { Cookie: otherCookie },
        });
        await request('/api' + blockedRun.path, 401, {
            headers: { Cookie: first },
        });
        await until(
            'Sweep waits for execution',
            () => executionPurges.length,
            (count) => count > 0,
        );
        assert.ok(drains > 0);
        assert.equal(executionPurges.at(-1), 202);
        assert.deepEqual(await accounts.pendingPurges(), [
            { ownerId: owner.ownerId, spaceRequired: true },
        ]);
        assert.equal(
            (await privateCall(blockedRun.path)).body.run.status,
            'needs_review',
        );
        assert.ok(
            (await readdir(join(state, 'volume', blockedTask.id))).length,
        );
        assert.ok(objects.has(spaceObjectKey(ownedFile)));
        assert.equal(aborts.size + removals.size, 0);

        workerBarrier.resolve();
        await until(
            'Run submitted before closure completes',
            () => privateCall(activeRun.path),
            (view) => view.body.run?.status === 'succeeded',
        );
        const afterActiveRun = await privateCall('/account/purge', 'POST');
        assert.equal(afterActiveRun.status, 202);
        assert.deepEqual(afterActiveRun.body, { complete: false });
        const authority = new DatabaseSync(join(state, 'authority.sqlite'), {
            readOnly: true,
        });
        let generation;
        try {
            generation = authority
                .prepare(
                    "SELECT generation FROM execution_sessions WHERE project=? AND tenant=? AND state='READY'",
                )
                .get(blockedTask.id, owner.ownerId)?.generation;
        } finally {
            authority.close();
        }
        assert.equal(typeof generation, 'number');
        purgeRequestsPaused = true;
        await service.closeTaskRun({
            runId: blockedRun.id,
            decision: 'unconfirmed',
            expectedGeneration: generation as number,
        });
        const audit = service.readTaskClosure(blockedRun.id);
        assert.ok(audit);
        try {
            await purgeEntered.promise;
        } finally {
            purgeBarrier.resolve();
        }
        await web?.close();
        web = undefined;
        await service.close();
        execution = undefined;
        assert.equal((await accounts.pendingPurges()).length, 1);

        purgeRequestsPaused = false;
        service = await openExecution();
        await openWorkspace();
        await until(
            'Physical cleanup waits for signed address expiry',
            () => spacePurgeAttempts,
            (count) => count > 0,
        );
        assert.equal(executionPurges.at(-1), 200);
        assert.equal((await privateCall(blockedTask.path)).status, 404);
        assert.equal(uploadRow()?.signedUntil, signedUntil);
        assert.ok(multipart.has(pendingKey));
        assert.ok(objects.has(pendingKey));
        assert.equal(aborts.get(pendingKey), undefined);
        assert.equal(removals.get(pendingKey), undefined);
        assert.equal((await accounts.pendingPurges()).length, 1);

        t.mock.timers.enable({ apis: ['Date'] });
        t.mock.timers.setTime((signedUntil as number) + 1);
        failRemoval = true;
        await removalFailed.promise;
        assert.ok(objects.has(pendingKey));
        assert.equal((await accounts.pendingPurges()).length, 1);
        await until(
            'Sweep finishes after verified object removal',
            () => accounts.pendingPurges(),
            (requests) => requests.length === 0,
        );
        assert.equal((await accounts.byOwner(owner.ownerId))?.closed, true);
        assert.equal((await accounts.byOwner(other.ownerId))?.closed, false);
        for (const resource of [blockedTask, blockedRun, activeTask, activeRun])
            assert.equal((await privateCall(resource.path)).status, 404);
        assert.equal(uploadRow(), undefined);
        assert.deepEqual(
            readRows((db) =>
                db
                    .prepare('SELECT id FROM space_projects WHERE owner=?')
                    .all(owner.ownerId),
            ),
            [],
        );
        assert.deepEqual(
            readRows((db) =>
                db
                    .prepare('SELECT id FROM space_uploads WHERE owner=?')
                    .all(owner.ownerId),
            ),
            [],
        );
        assert.deepEqual(
            readRows((db) =>
                db
                    .prepare('SELECT id FROM space_uploads WHERE owner=?')
                    .all(other.ownerId)
                    .map((row) => row.id),
            ),
            [otherFile],
        );
        assert.equal(multipart.has(pendingKey), false);
        assert.equal(removals.get(pendingKey), 2);
        assert.deepEqual([...objects.keys()], [spaceObjectKey(otherFile)]);
        assert.deepEqual(service.readTaskClosure(blockedRun.id), audit);
    },
);
