import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import console from 'node:console';
import { access, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import {
    oidcFixtureClient,
    oidcFixtureEmail,
    startOidcFixture,
} from './oidc-fixture.ts';

const origin = 'http://127.0.0.1:8080';
const assets = '/app/apps/workspace/workspace-auth/';
const missing = process.argv[2] === '--missing-artifacts';
const spaceConfigured = process.argv[2] === '--space-reads';
const subject = spaceConfigured ? 'fixture-space-subject' : 'fixture-subject';
const fixture = await startOidcFixture();
let snapshotSubmissions = 0;
let lastProjectOwner;
const purgedOwners = new Set();
const executionProject = 'fixture-execution-project';
const closedSnapshotKey = '00000000-0000-4000-8000-000000000034';
const closedSnapshot = '00000000-0000-4000-8000-000000000035';
const closedSnapshotDigest = '1'.repeat(64);
let closedSnapshotReceipts = 0;
let releaseSpacePurge = false;
let spaceDrainStarted = false;
let releaseSpaceDrain;
let fileDeleteHeld = false;
let fileDeleteReleased = false;
const execution = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (
        req.headers.authorization !== 'Bearer fixture-execution' ||
        !/^[a-f0-9]{48}$/.test(req.headers['x-bento-owner-id'] ?? '')
    ) {
        res.writeHead(401).end('{}');
        return;
    }
    if (
        req.method === 'GET' &&
        ['/v1/projects', '/v1/tasks'].includes(req.url)
    ) {
        if (!req.headers['user-agent']?.startsWith('Go-http-client/')) {
            res.writeHead(500).end('{}');
            return;
        }
        if (req.url === '/v1/projects')
            lastProjectOwner = req.headers['x-bento-owner-id'];
        res.end(
            JSON.stringify(
                req.url === '/v1/projects' ? { projects: [] } : { items: [] },
            ),
        );
        return;
    }
    if (
        req.method === 'GET' &&
        req.url === '/v1/tasks?creationKey=' + closedSnapshotKey
    ) {
        assert.ok(req.headers['user-agent']?.startsWith('Go-http-client/'));
        closedSnapshotReceipts++;
        res.end(
            JSON.stringify({
                items: [
                    {
                        id: closedSnapshot,
                        name: 'Closing Snapshot',
                        inputDigest: closedSnapshotDigest,
                        sourceSpaceId: '00000000-0000-4000-8000-000000000031',
                        environmentVersion: 'sha256:' + '0'.repeat(64),
                        status: 'preparing',
                        prepareError: null,
                        closedReason: null,
                        reconciliation: null,
                        createdAt: '2026-11-27T00:00:00Z',
                        updatedAt: '2026-11-27T00:00:00Z',
                        inputs: [],
                    },
                ],
            }),
        );
        return;
    }
    if (req.method === 'POST' && req.url === '/v1/projects') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(chunks.join(''));
        if (
            !req.headers['user-agent']?.startsWith('Go-http-client/') ||
            !/^space-init-[a-f0-9]{64}$/.test(req.headers['idempotency-key']) ||
            JSON.stringify(payload) !==
                JSON.stringify({
                    name: 'Smoke Space',
                    files: [{ path: 'empty.txt', text: '' }],
                })
        ) {
            res.writeHead(500).end('{}');
            return;
        }
        res.writeHead(201).end(
            JSON.stringify({
                id: executionProject,
                name: payload.name,
                status: 'ready',
                createdAt: '2026-11-27T00:00:00Z',
            }),
        );
        return;
    }
    if (req.method === 'POST' && req.url === '/v1/tasks') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(chunks.join(''));
        const { name, inputDigest } = payload;
        const snapshot = payload.sourceSpaceId !== null;
        const blank =
            !snapshot &&
            req.headers['user-agent']?.startsWith('Go-http-client/') &&
            req.headers['idempotency-key'] ===
                '00000000-0000-4000-8000-000000000010' &&
            name === 'Smoke Task' &&
            inputDigest === createHash('sha256').update('[]').digest('hex') &&
            payload.id === null &&
            Array.isArray(payload.inputFiles) &&
            payload.inputFiles.length === 0 &&
            Array.isArray(payload.inputManifest) &&
            payload.inputManifest.length === 0;
        const frozen =
            snapshot &&
            req.headers['user-agent']?.startsWith('Go-http-client/') &&
            req.headers['idempotency-key'] ===
                '00000000-0000-4000-8000-000000000023' &&
            name === 'Smoke Snapshot' &&
            payload.sourceSpaceId === '00000000-0000-4000-8000-000000000020' &&
            JSON.stringify(
                payload.inputFiles.map(({ path, text }) => ({ path, text })),
            ) === '[{"path":"empty.txt","text":""}]' &&
            inputDigest ===
                createHash('sha256')
                    .update('[{"path":"empty.txt","text":""}]')
                    .digest('hex') &&
            payload.inputManifest[0]?.fileId ===
                '00000000-0000-4000-8000-000000000022';
        if (!blank && !frozen) {
            res.writeHead(500).end('{}');
            return;
        }
        if (frozen) snapshotSubmissions++;
        res.writeHead(202).end(
            JSON.stringify({
                task: {
                    id: snapshot
                        ? payload.id
                        : '00000000-0000-4000-8000-000000000011',
                    name,
                    inputDigest,
                    sourceSpaceId: payload.sourceSpaceId,
                    environmentVersion: 'sha256:' + '0'.repeat(64),
                    status:
                        snapshot && snapshotSubmissions > 1
                            ? 'ready'
                            : 'preparing',
                    prepareError: null,
                    closedReason: null,
                    reconciliation: null,
                    createdAt: '2026-11-27T00:00:00Z',
                    updatedAt: '2026-11-27T00:00:00Z',
                    inputs: payload.inputManifest,
                },
            }),
        );
        return;
    }
    if (
        req.url?.startsWith(
            '/v1/task-sources/00000000-0000-4000-8000-000000000020/files/00000000-0000-4000-8000-000000000022/deletion-holds/',
        ) &&
        req.headers['user-agent']?.startsWith('Go-http-client/')
    ) {
        if (req.method === 'POST') {
            fileDeleteHeld = true;
            res.end(JSON.stringify({ state: 'held' }));
            return;
        }
        if (req.method === 'DELETE' && fileDeleteHeld && !emptyUploadWritten) {
            fileDeleteReleased = true;
            res.end(JSON.stringify({ state: 'released' }));
            return;
        }
    }
    if (
        req.method === 'DELETE' &&
        req.url ===
            '/v1/task-sources/00000000-0000-4000-8000-000000000020?legacyProjectId=' +
                executionProject +
                '&phase=hold' &&
        req.headers['user-agent']?.startsWith('Go-http-client/') &&
        /^[a-f0-9-]{36}$/.test(req.headers['idempotency-key'] ?? '')
    ) {
        res.writeHead(204).end();
        return;
    }
    if (
        req.method === 'GET' &&
        req.url ===
            '/v1/task-sources/00000000-0000-4000-8000-000000000020/deletion?legacyProjectId=' +
                executionProject
    ) {
        res.end(JSON.stringify({ runCount: 2, diffCount: 1, blockers: [] }));
        return;
    }
    if (
        req.method === 'POST' &&
        req.url === '/v1/account/drain' &&
        req.headers['user-agent']?.startsWith('Go-http-client/')
    ) {
        if (spaceConfigured && !spaceDrainStarted) {
            spaceDrainStarted = true;
            await new Promise((resolve) => {
                releaseSpaceDrain = resolve;
            });
        }
        res.writeHead(204).end();
        return;
    }
    if (
        req.method === 'POST' &&
        req.url === '/v1/account/purge' &&
        req.headers['user-agent']?.startsWith('Go-http-client/')
    ) {
        const complete = !spaceConfigured || releaseSpacePurge;
        if (complete) purgedOwners.add(req.headers['x-bento-owner-id']);
        res.writeHead(complete ? 200 : 202).end(JSON.stringify({ complete }));
        return;
    }
    res.writeHead(404).end('{}');
});
execution.listen(0, '127.0.0.1');
await once(execution, 'listening');
const executionOrigin = 'http://127.0.0.1:' + execution.address().port;
const emptyUploadPath =
    '/fixture-bucket/space/00000000-0000-4000-8000-000000000022';
let emptyUploadWritten = false;
const objectStore = createServer((req, res) => {
    if (req.url?.split('?', 1)[0] !== emptyUploadPath) {
        res.writeHead(404).end();
        return;
    }
    if (req.method === 'HEAD' || req.method === 'GET') {
        res.writeHead(emptyUploadWritten ? 200 : 404, {
            'Content-Length': '0',
        }).end();
        return;
    }
    if (
        req.method === 'PUT' &&
        req.headers['user-agent']?.startsWith('aws-sdk-go-v2/') &&
        req.headers['content-length'] === '0' &&
        req.headers['if-none-match'] === '*'
    ) {
        emptyUploadWritten = true;
        res.writeHead(200).end();
        return;
    }
    if (req.method === 'DELETE' && fileDeleteHeld) {
        emptyUploadWritten = false;
        res.writeHead(204).end();
        return;
    }
    console.error(
        'unexpected object fixture request',
        req.method,
        req.headers['content-length'],
        req.headers['if-none-match'],
        req.headers['user-agent']?.split(' ')[0],
    );
    res.writeHead(400).end();
});
objectStore.listen(0, '127.0.0.1');
await once(objectStore, 'listening');
const objectStoreOrigin = 'http://127.0.0.1:' + objectStore.address().port;

let entry;

async function startEntry() {
    const directory = await mkdtemp(join(tmpdir(), 'bento-auth-entry-'));
    const spaceDb = join(directory, 'space.sqlite');
    const stdoutPath = join(directory, 'stdout.log');
    const stderrPath = join(directory, 'stderr.log');
    let stdoutFile;
    let stderrFile;
    try {
        stdoutFile = await open(stdoutPath, 'a', 0o600);
        stderrFile = await open(stderrPath, 'a', 0o600);
        const child = spawn(
            '/usr/bin/tini',
            ['--', '/usr/local/bin/bento-web'],
            {
                env: {
                    ...process.env,
                    BENTO_ONE_TWO_URL: executionOrigin,
                    BENTO_ONE_TWO_BEARER: 'fixture-execution',
                    ...(spaceConfigured
                        ? {
                              BENTO_SPACE_DB: spaceDb,
                              BENTO_SPACE_S3_ENDPOINT: objectStoreOrigin,
                              BENTO_SPACE_S3_BUCKET: 'fixture-bucket',
                              AWS_ACCESS_KEY_ID: 'fixture-access-key',
                              AWS_SECRET_ACCESS_KEY: 'fixture-secret-key',
                              AWS_EC2_METADATA_DISABLED: 'true',
                          }
                        : {}),
                    BENTO_AUTH_MODE: 'keycloak',
                    BENTO_ONE_ORIGIN: origin,
                    BENTO_OIDC_ISSUER: fixture.issuer,
                    BENTO_OIDC_CLIENT_ID: oidcFixtureClient.clientId,
                    BENTO_OIDC_CLIENT_SECRET: oidcFixtureClient.clientSecret,
                    BENTO_OIDC_ORGANIZATION: oidcFixtureClient.organization,
                },
                stdio: ['ignore', stdoutFile.fd, stderrFile.fd],
            },
        );
        const result = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({ code, signal }));
        })
            .then(async ({ code, signal }) => {
                const [stdout, stderr] = await Promise.all([
                    readFile(stdoutPath, 'utf8'),
                    readFile(stderrPath, 'utf8'),
                ]);
                return { code, signal, stdout, stderr };
            })
            .finally(() => rm(directory, { recursive: true, force: true }));
        // The readiness or shutdown path consumes the settled result.
        void result.catch(() => {});
        return { child, result, spaceDb };
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    } finally {
        await Promise.all([stdoutFile?.close(), stderrFile?.close()]);
    }
}

function request(path, options) {
    return globalThis.fetch(origin + path, {
        redirect: 'manual',
        signal: globalThis.AbortSignal.timeout(3000),
        ...options,
    });
}

function startupDiagnostics({ code, signal, stdout, stderr }) {
    const lines = (stdout + '\n' + stderr).split('\n');
    const markers = [
        [/nginx: the configuration file.*syntax is ok/, 'nginx-config-parsed'],
        [
            /nginx: configuration file.*test is successful/,
            'nginx-config-test-ok',
        ],
        [/(?:nginx:.*(?:\[emerg\]|test failed)|\[emerg\])/, 'nginx-fatal'],
        [/(?:nginx:|\[emerg\]).*Permission denied/, 'nginx-permission-denied'],
        [/(?:nginx:|\[emerg\]).*Address already in use/, 'nginx-bind-in-use'],
        [
            /(?:\/dev\/stdout|\/dev\/stderr).*No such device or address/,
            'nginx-stdio-reopen-failed',
        ],
        [
            /incomplete MySQL account configuration/,
            'go-mysql-config-incomplete',
        ],
        [/invalid MySQL account configuration/, 'go-mysql-config-invalid'],
        [/could not initialize MySQL accounts/, 'go-mysql-initialize-failed'],
        [/listen tcp.*bind:.*address already in use/, 'go-bind-in-use'],
        [
            /Workspace auth build artifacts are unavailable/,
            'auth-artifacts-unavailable',
        ],
        [/ERR_MODULE_NOT_FOUND/, 'node-module-not-found'],
        [
            /Bento local OIDC discovery did not become ready\./,
            'oidc-discovery-not-ready',
        ],
    ];
    const matched = markers
        .filter(([pattern]) => lines.some((line) => pattern.test(line)))
        .map(([, marker]) => marker);
    return (
        'exit=' +
        (code ?? 'none') +
        ', signal=' +
        (signal ?? 'none') +
        ', markers=' +
        (matched.join(',') || 'no-startup-marker')
    );
}

async function waitReady() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
            const result = await waitExit();
            throw new Error(
                'Image entrypoint exited before readiness: ' +
                    startupDiagnostics(result),
            );
        }
        let ready = false;
        try {
            const statuses = await Promise.all(
                ['/', '/api/session', '/auth'].map(async (path) => {
                    const response = await request(path);
                    await response.body?.cancel();
                    return response.status;
                }),
            );
            const health = await globalThis.fetch(
                'http://127.0.0.1:4102/healthz',
                {
                    signal: globalThis.AbortSignal.timeout(1000),
                },
            );
            if (statuses.join(',') === '200,401,200' && health.status === 204) {
                ready = true;
            }
        } catch {
            // The loopback listeners may still be starting.
        }
        if (ready) {
            await assertGoProcess();
            console.log('One Go API process with legacy API ports closed');
            return;
        }
        await delay(250);
    }
    throw new Error('Image entrypoint did not become ready');
}

async function assertGoProcess() {
    for (const port of [4101, 4103]) {
        await assert.rejects(
            globalThis.fetch('http://127.0.0.1:' + port, {
                signal: globalThis.AbortSignal.timeout(1000),
            }),
            (error) => error.cause?.code === 'ECONNREFUSED',
        );
    }
    const processes = new Map();
    for (const pid of await readdir('/proc')) {
        if (!/^\d+$/.test(pid)) continue;
        try {
            const status = await readFile('/proc/' + pid + '/status', 'utf8');
            const name = /^Name:\s+(\S+)/m.exec(status)?.[1];
            const parent = /^PPid:\s+(\d+)/m.exec(status)?.[1];
            processes.set(pid, { name, parent });
        } catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
        }
    }
    const pending = [String(entry.child.pid)];
    const descendants = [];
    while (pending.length) {
        const parent = pending.pop();
        for (const [pid, info] of processes) {
            if (info.parent !== parent) continue;
            pending.push(pid);
            descendants.push(info.name);
        }
    }
    assert.equal(
        descendants.filter((name) => name === 'bento-web-api').length,
        1,
    );
    assert.ok(!descendants.includes('node'));
}

async function waitExit() {
    const timeout = new globalThis.AbortController();
    try {
        return await Promise.race([
            entry.result,
            delay(30_000, undefined, { signal: timeout.signal }).then(() => {
                throw new Error('Image entrypoint did not exit');
            }),
        ]);
    } finally {
        timeout.abort();
    }
}

async function stopEntry() {
    if (!entry) return;
    entry.child.kill('SIGTERM');
    await waitExit();
    entry = undefined;
}

async function status(response, expected, label) {
    const result = await response;
    assert.equal(result.status, expected, label);
    return result;
}

function cookie(response, name) {
    const value = response.headers
        .getSetCookie()
        .find((value) => value.startsWith(name + '='));
    assert.ok(value, 'Expected response cookie ' + name);
    return value.split(';', 1)[0];
}

function location(response) {
    const target = response.headers.get('location');
    assert.ok(target, 'Expected redirect location');
    return new globalThis.URL(target, origin);
}

const session = (value) =>
    request('/api/session', { headers: { Cookie: value } });
const submit = (path, value, body = '', from = origin) =>
    request(path, {
        method: 'POST',
        body,
        headers: { Origin: from, Cookie: value },
    });

async function authorize(response, code) {
    const redirect = await status(response, 303, 'Authorization redirect');
    const target = location(redirect);
    assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
    fixture.authorization(target);
    fixture.setCode(code, subject, true);
    const callback = new globalThis.URL('/api/oidc/callback', origin);
    callback.searchParams.set('state', target.searchParams.get('state'));
    callback.searchParams.set('code', code);
    return { callback, transaction: cookie(redirect, 'bento_oidc'), target };
}

function callback({ callback: url, transaction }, value = '') {
    return request(url.pathname + url.search, {
        headers: { Cookie: [transaction, value].filter(Boolean).join('; ') },
    });
}

async function login(grant) {
    const result = await status(callback(grant), 303, 'Login callback');
    assert.equal(location(result).href, origin + '/');
    const value = cookie(result, 'bento_one');
    const current = await status(
        session(value),
        200,
        'Authenticated API session',
    );
    assert.deepEqual(await current.json(), { account: oidcFixtureEmail });
    const projects = await status(
        request('/api/projects', { headers: { Cookie: value } }),
        200,
        'Go session accepted by the Workspace business API',
    );
    assert.ok(Array.isArray((await projects.json()).projects));
    const tasks = await status(
        request('/api/tasks', { headers: { Cookie: value } }),
        200,
        'Go session accepted by the Task API',
    );
    assert.deepEqual(await tasks.json(), { items: [] });
    const blank = await status(
        request('/api/tasks', {
            method: 'POST',
            headers: {
                Origin: origin,
                Cookie: value,
                'Content-Type': 'application/json',
                'Idempotency-Key': '00000000-0000-4000-8000-000000000010',
            },
            body: JSON.stringify({
                name: ' Smoke Task ',
                source: { kind: 'blank' },
            }),
        }),
        202,
        'Go forwards a blank Task',
    );
    assert.equal((await blank.json()).task.name, 'Smoke Task');
    await status(
        request('/api/tasks', {
            method: 'POST',
            headers: {
                Origin: origin,
                Cookie: value,
                'Content-Type': 'application/json',
                'Idempotency-Key': '00000000-0000-4000-8000-000000000012',
            },
            body: JSON.stringify({
                name: 'Snapshot',
                source: {
                    kind: 'space_snapshot',
                    spaceId: 'fixture-space',
                    fileIds: ['fixture-file'],
                },
            }),
        }),
        spaceConfigured ? 404 : 503,
        'Snapshot bridge retains the existing unavailable-source response',
    );
    return value;
}

async function binding(value) {
    lastProjectOwner = undefined;
    await status(
        request('/api/projects', { headers: { Cookie: value } }),
        200,
        'Read projects with the persisted account',
    );
    assert.match(lastProjectOwner, /^[a-f0-9]{48}$/);
    return lastProjectOwner;
}

async function checkAsset(path, file, value = '') {
    const result = await status(
        request(path, { headers: { Cookie: value } }),
        200,
        'Auth asset',
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
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(
        result.headers.get('content-security-policy'),
        css
            ? "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
            : "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' " +
                  fixture.issuer,
    );
    assert.deepEqual(
        new Uint8Array(await result.arrayBuffer()),
        new Uint8Array(await readFile(assets + 'dist/' + file)),
    );
}

function checkEndSession(result) {
    const target = location(result);
    assert.equal(
        target.origin + target.pathname,
        fixture.issuer + '/end-session',
    );
    assert.ok(target.searchParams.has('id_token_hint'));
    assert.equal(
        target.searchParams.get('post_logout_redirect_uri'),
        origin + '/auth',
    );
    assert.equal(cookie(result, 'bento_one'), 'bento_one=');
}

async function checkRuntime() {
    for (const source of [
        'login.html',
        'account.html',
        'style.css',
        'build.mjs',
        'auth-page.ts',
    ]) {
        await assert.rejects(access(assets + source), { code: 'ENOENT' });
    }
    await waitReady();
    await checkAsset('/auth', 'login.html');
    await checkAsset('/auth/style.css', 'style.css');

    const first = await authorize(request('/api/oidc/start'), 'first');
    const wrongState = new globalThis.URL(first.callback);
    wrongState.searchParams.set('state', 'wrong');
    await status(
        callback({ ...first, callback: wrongState }),
        401,
        'Invalid state',
    );
    assert.equal(fixture.tokenRequests(), 0);
    const firstSession = await login(first);
    await status(callback(first), 401, 'Callback replay');
    assert.equal(fixture.tokenRequests(), 1);
    await checkAsset('/auth', 'account.html', firstSession);
    const ownerId = await binding(firstSession);
    checkEndSession(
        await status(submit('/api/oidc/logout', firstSession), 303, 'Logout'),
    );
    await status(session(firstSession), 401, 'Revoked logout cookie');

    const beforeRestart = await login(
        await authorize(request('/api/oidc/start'), 'before-restart'),
    );
    const pending = await authorize(request('/api/oidc/start'), 'pending');
    await stopEntry();
    entry = await startEntry();
    await waitReady();
    await status(session(beforeRestart), 401, 'Session lost on restart');
    await status(callback(pending), 401, 'Transaction lost on restart');
    const afterRestart = await login(
        await authorize(request('/api/oidc/start'), 'after-restart'),
    );
    assert.equal(await binding(afterRestart), ownerId);

    await status(
        submit(
            '/api/oidc/close',
            afterRestart,
            'confirmed=yes',
            'http://127.0.0.1:8081',
        ),
        400,
        'Cross-origin closure',
    );
    const closing = await authorize(
        submit('/api/oidc/close', afterRestart, 'confirmed=yes'),
        'close',
    );
    assert.equal(closing.target.searchParams.get('prompt'), 'login');
    assert.equal(closing.target.searchParams.get('max_age'), '0');
    checkEndSession(
        await status(callback(closing, afterRestart), 303, 'Close callback'),
    );
    await status(session(afterRestart), 401, 'Revoked closure cookie');
    await stopEntry();
    entry = await startEntry();
    await waitReady();
    const closed = await authorize(request('/api/oidc/start'), 'closed');
    await status(callback(closed), 401, 'Closed identity denied after restart');
    const deadline = Date.now() + 15_000;
    while (!purgedOwners.has(ownerId) && Date.now() < deadline)
        await delay(200);
    assert.ok(purgedOwners.has(ownerId), 'Go schedules account purge');
}

async function checkSpaceReads() {
    await waitReady();
    const value = await login(
        await authorize(request('/api/oidc/start'), 'space-reads'),
    );
    const owner = await binding(value);
    const project = '00000000-0000-4000-8000-000000000020';
    const file = '00000000-0000-4000-8000-000000000021';
    const db = new DatabaseSync(entry.spaceDb);
    try {
        const projectRegistration = await status(
            request('/api/space/projects', {
                method: 'POST',
                headers: {
                    Cookie: value,
                    Origin: origin,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ id: project, name: 'Smoke Space' }),
            }),
            200,
            'Go registers a space project',
        );
        assert.deepEqual(await projectRegistration.json(), { id: project });
        db.prepare(
            'INSERT INTO space_uploads (id,project,owner,path,size,manifest,state,expires) VALUES (?,?,?,?,?,?,?,?)',
        ).run(
            file,
            project,
            owner,
            'readme.txt',
            100,
            '[]',
            'saved',
            Date.now() + 60_000,
        );
        const headers = { Cookie: value };
        const overview = await status(
            request('/api/space', { headers }),
            200,
            'Go SQLite space overview',
        );
        const result = await overview.json();
        assert.equal(result.saved, 100);
        assert.deepEqual(result.projects, [
            { id: project, name: 'Smoke Space' },
        ]);
        assert.equal(result.uploads[0].id, file);
        for (const action of ['preview', 'download']) {
            const response = await status(
                request('/api/space/files/' + file + '/' + action, { headers }),
                302,
                'Signed file redirect',
            );
            const target = location(response);
            assert.equal(target.pathname, '/fixture-bucket/space/' + file);
            assert.equal(target.searchParams.get('X-Amz-Expires'), '300');
            if (action === 'preview')
                assert.equal(
                    target.searchParams.get('response-cache-control'),
                    'no-store',
                );
            else
                assert.equal(
                    target.searchParams.get('response-content-disposition'),
                    "attachment; filename*=UTF-8''readme.txt",
                );
        }

        const emptyFile = '00000000-0000-4000-8000-000000000022';
        const uploadHeaders = {
            ...headers,
            Origin: origin,
            'Content-Type': 'application/json',
        };
        const reserved = await status(
            request('/api/space/projects/' + project + '/uploads', {
                method: 'POST',
                headers: uploadHeaders,
                body: JSON.stringify({
                    id: emptyFile,
                    path: 'empty.txt',
                    size: 0,
                    checksums: [],
                }),
            }),
            200,
            'Go reserves empty upload',
        );
        assert.equal((await reserved.json()).state, 'uploading');
        const finished = await status(
            request('/api/space/uploads/' + emptyFile + '/complete', {
                method: 'POST',
                headers: uploadHeaders,
            }),
            200,
            'Go completes the stored empty upload',
        );
        assert.equal((await finished.json()).state, 'saved');
        assert.ok(emptyUploadWritten);
        const frozen = await status(
            request('/api/tasks', {
                method: 'POST',
                headers: {
                    ...uploadHeaders,
                    'Idempotency-Key': '00000000-0000-4000-8000-000000000023',
                },
                body: JSON.stringify({
                    name: 'Smoke Snapshot',
                    source: {
                        kind: 'space_snapshot',
                        spaceId: project,
                        fileIds: [emptyFile],
                    },
                }),
            }),
            202,
            'Go freezes the uploaded file snapshot',
        );
        const submitted = (await frozen.json()).task;
        assert.equal(submitted.sourceSpaceId, project);
        assert.equal(submitted.status, 'preparing');
        const snapshotCutoff = Date.now() + 10_000;
        while (snapshotSubmissions < 2 && Date.now() < snapshotCutoff)
            await delay(250);
        assert.ok(
            snapshotSubmissions >= 2,
            'Go retries the submitted snapshot',
        );
        // Give the API time to persist the ready receipt and release the pin.
        await delay(250);
        const projectPath = '/api/space/projects/' + project;
        const initializationHeaders = {
            ...uploadHeaders,
            'Idempotency-Key': 'workspace-init-smoke',
        };
        const initialize = () =>
            request(projectPath + '/execution', {
                method: 'POST',
                headers: initializationHeaders,
                body: JSON.stringify({ fileIds: [emptyFile] }),
            });
        const enrolled = await status(
            initialize(),
            202,
            'Go enrolls project initialization',
        );
        assert.equal((await enrolled.json()).state, 'validating');
        const initializationCutoff = Date.now() + 10_000;
        let detail;
        do {
            const response = await status(
                request(projectPath, { headers }),
                200,
                'Space project detail',
            );
            detail = await response.json();
            if (detail.execution.state !== 'ready') await delay(250);
        } while (
            detail.execution.state !== 'ready' &&
            Date.now() < initializationCutoff
        );
        assert.equal(detail.execution.state, 'ready');
        assert.equal(detail.execution.projectId, executionProject);
        const replay = await status(
            initialize(),
            200,
            'Go replays project initialization',
        );
        assert.equal((await replay.json()).state, 'ready');
        const impact = await status(
            request(projectPath + '/deletion', { headers }),
            200,
            'Go combines local and upstream deletion impact',
        );
        assert.deepEqual(await impact.json(), {
            fileCount: 2,
            uploadCount: 0,
            runCount: 2,
            diffCount: 1,
            blockers: [],
        });
        const deleteRequest = () =>
            request('/api/space/files/' + emptyFile, {
                method: 'DELETE',
                headers: uploadHeaders,
            });
        const deleting = await status(
            deleteRequest(),
            202,
            'Go requests the file deletion hold',
        );
        assert.deepEqual(await deleting.json(), { state: 'deleting' });
        assert.ok(fileDeleteHeld);
        const cutoff = Date.now() + 35_000;
        while (!fileDeleteReleased && Date.now() < cutoff) await delay(250);
        assert.ok(
            fileDeleteReleased,
            'Go must release the hold after deleting the object',
        );
        await status(
            deleteRequest(),
            204,
            'Go replays completed file deletion',
        );
        db.prepare(
            'INSERT INTO space_project_deletions (spaceId,owner,operationId,phase) VALUES (?,?,?,?)',
        ).run(project, owner, 'fixture-deletion', 'holding');
        await status(
            request('/api/space/files/' + file + '/preview', { headers }),
            404,
            'Deleting space hides file',
        );
        db.prepare('DELETE FROM space_project_deletions WHERE spaceId=?').run(
            project,
        );
        await status(
            request('/api/space/projects/' + project, {
                method: 'DELETE',
                headers: uploadHeaders,
            }),
            204,
            'Go confirms project deletion and clears metadata',
        );
        await status(
            request('/api/space/projects/' + project, {
                method: 'DELETE',
                headers: uploadHeaders,
            }),
            204,
            'Go replays a completed project deletion',
        );
        assert.ok(
            db
                .prepare('SELECT id FROM space_retired_upload_ids WHERE id=?')
                .get(file),
        );
        const retainedProject = '00000000-0000-4000-8000-000000000031';
        const retainedFile = '00000000-0000-4000-8000-000000000032';
        db.prepare('INSERT INTO space_projects VALUES (?,?,?)').run(
            retainedProject,
            owner,
            'Closing Space',
        );
        db.prepare(
            `INSERT INTO space_uploads (id,project,owner,path,size,manifest,state,expires)
            VALUES (?,?,?,'retained.txt',0,'[]','saved',0)`,
        ).run(retainedFile, retainedProject, owner);
        const addTask = db.prepare(`INSERT INTO space_tasks
            (id,owner,spaceId,key,hash,name,fileIds,state,canonicalBody,lastError)
            VALUES (?,?,?,?,?,'Closing Snapshot',?,?,?,NULL)`);
        const pinned = '00000000-0000-4000-8000-000000000036';
        const closing = await authorize(
            submit('/api/oidc/close', value, 'confirmed=yes'),
            'close-space',
        );
        checkEndSession(
            await status(
                callback(closing, value),
                303,
                'Close workspace with snapshot intents',
            ),
        );
        await status(session(value), 401, 'Workspace session revoked');
        const drainCutoff = Date.now() + 10_000;
        while (!spaceDrainStarted && Date.now() < drainCutoff) await delay(250);
        assert.ok(spaceDrainStarted, 'Go initiates Orchestrator drain');
        assert.ok(
            db
                .prepare(
                    'SELECT owner FROM space_draining_owners WHERE owner=?',
                )
                .get(owner),
        );
        addTask.run(
            closedSnapshot,
            owner,
            retainedProject,
            closedSnapshotKey,
            'hash',
            JSON.stringify([retainedFile]),
            'submitted',
            JSON.stringify({ inputDigest: closedSnapshotDigest }),
        );
        addTask.run(
            pinned,
            owner,
            retainedProject,
            'pinned-key',
            'hash',
            JSON.stringify([retainedFile]),
            'pinned',
            null,
        );
        const pin = db.prepare('INSERT INTO space_task_inputs VALUES (?,?,1)');
        pin.run(closedSnapshot, retainedFile);
        pin.run(pinned, retainedFile);
        releaseSpaceDrain();
        const reconcileCutoff = Date.now() + 10_000;
        const task = db.prepare(
            'SELECT state,lastError FROM space_tasks WHERE id=?',
        );
        while (
            task.get(closedSnapshot)?.lastError !== 'owner_closed' &&
            Date.now() < reconcileCutoff
        )
            await delay(250);
        assert.equal(closedSnapshotReceipts, 1);
        assert.equal(task.get(closedSnapshot)?.state, 'submitted');
        assert.equal(task.get(pinned)?.state, 'abandoned');
        assert.equal(
            db
                .prepare(
                    'SELECT readPinned FROM space_task_inputs WHERE taskId=?',
                )
                .get(pinned)?.readPinned,
            0,
        );
        assert.equal(purgedOwners.has(owner), false);
        releaseSpacePurge = true;
        const cleanupCutoff = Date.now() + 10_000;
        const retired = db.prepare(
            'SELECT id FROM space_retired_upload_ids WHERE id=?',
        );
        while (!retired.get(retainedFile) && Date.now() < cleanupCutoff)
            await delay(250);
        assert.ok(purgedOwners.has(owner));
        assert.ok(retired.get(retainedFile));
        while (task.get(closedSnapshot) && Date.now() < cleanupCutoff)
            await delay(250);
        assert.equal(task.get(closedSnapshot), undefined);
        assert.equal(
            db
                .prepare('SELECT id FROM space_projects WHERE id=?')
                .get(retainedProject),
            undefined,
        );
    } finally {
        db.close();
    }
}

try {
    entry = await startEntry();
    if (missing) {
        const result = await waitExit();
        assert.ok(Number.isInteger(result.code) && result.code !== 0);
        assert.equal(result.signal, null);
        assert.match(
            result.stderr,
            /^(?:\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} )?Workspace auth build artifacts are unavailable$/m,
        );
        console.log('Missing auth artifacts rejected at image startup');
    } else if (spaceConfigured) {
        await checkSpaceReads();
        console.log(
            'Go space registration, initialization, upload, deletion, snapshots and account cleanup passed',
        );
    } else {
        await checkRuntime();
        console.log(
            'Auth pages, OIDC lifecycle, restart and persisted account assertions passed',
        );
    }
} finally {
    releaseSpaceDrain?.();
    try {
        await stopEntry();
    } finally {
        execution.close();
        objectStore.close();
        await fixture.close();
    }
}
