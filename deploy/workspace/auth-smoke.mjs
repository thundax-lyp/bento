import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import console from 'node:console';
import { access, readFile } from 'node:fs/promises';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import {
    oidcFixtureClient,
    oidcFixtureEmail,
    startOidcFixture,
} from './oidc-fixture.ts';

const origin = 'http://127.0.0.1:8080';
const accounts = 'http://127.0.0.1:4103/internal/accounts';
const assets = '/app/apps/workspace/auth/';
const missing = process.argv[2] === '--missing-artifacts';
const subject = 'fixture-subject';
const fixture = await startOidcFixture();
let entry;

function startEntry() {
    const child = spawn('/usr/bin/tini', ['--', '/usr/local/bin/bento-web'], {
        env: {
            ...process.env,
            BENTO_ONE_MODE: 'mock',
            BENTO_AUTH_MODE: 'keycloak',
            BENTO_ONE_ORIGIN: origin,
            BENTO_OIDC_ISSUER: fixture.issuer,
            BENTO_OIDC_CLIENT_ID: oidcFixtureClient.clientId,
            BENTO_OIDC_CLIENT_SECRET: oidcFixtureClient.clientSecret,
            BENTO_OIDC_ORGANIZATION: oidcFixtureClient.organization,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
        stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
        stderr += chunk;
    });
    const result = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) =>
            resolve({ code, signal, stdout, stderr }),
        );
    });
    return { child, result };
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
        [
            /Invalid Bento task entry configuration or listener unavailable\./,
            'task-entry-startup-failed',
        ],
        [/Bento task entry \(mock\) listening on/, 'task-entry-listening'],
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
        try {
            const statuses = await Promise.all(
                ['/', '/api/session', '/auth'].map(async (path) => {
                    const response = await request(path);
                    await response.body?.cancel();
                    return response.status;
                }),
            );
            if (statuses.join(',') === '200,401,200') return;
        } catch {
            // The loopback listeners may still be starting.
        }
        await delay(250);
    }
    throw new Error('Image entrypoint did not become ready');
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
    return value;
}

async function binding() {
    const row = await status(
        globalThis.fetch(accounts + '/oidc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                issuer: fixture.issuer,
                subject,
                account: oidcFixtureEmail,
            }),
        }),
        200,
        'Bound account',
    );
    const identity = await row.json();
    assert.equal(identity.account, oidcFixtureEmail);
    assert.equal(identity.closed, false);
    assert.match(identity.ownerId, /^[a-f0-9]{48}$/);
    await checkOwner(identity.ownerId, false);
    return identity.ownerId;
}

async function checkOwner(ownerId, closed) {
    const row = await status(
        globalThis.fetch(accounts + '/by-owner/' + ownerId),
        200,
        'Account by owner',
    );
    const result = await row.json();
    assert.equal(result.ownerId, ownerId);
    assert.equal(result.closed, closed);
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
    const ownerId = await binding();
    checkEndSession(
        await status(submit('/api/oidc/logout', firstSession), 303, 'Logout'),
    );
    await status(session(firstSession), 401, 'Revoked logout cookie');

    const beforeRestart = await login(
        await authorize(request('/api/oidc/start'), 'before-restart'),
    );
    const pending = await authorize(request('/api/oidc/start'), 'pending');
    await stopEntry();
    entry = startEntry();
    await waitReady();
    await status(session(beforeRestart), 401, 'Session lost on restart');
    await status(callback(pending), 401, 'Transaction lost on restart');
    const afterRestart = await login(
        await authorize(request('/api/oidc/start'), 'after-restart'),
    );
    assert.equal(await binding(), ownerId);

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
    entry = startEntry();
    await waitReady();
    const closed = await authorize(request('/api/oidc/start'), 'closed');
    await status(callback(closed), 401, 'Closed identity denied after restart');
    await checkOwner(ownerId, true);
}

try {
    entry = startEntry();
    if (missing) {
        const result = await waitExit();
        assert.ok(Number.isInteger(result.code) && result.code !== 0);
        assert.equal(result.signal, null);
        assert.ok(
            result.stderr
                .split('\n')
                .includes('Workspace auth build artifacts are unavailable'),
        );
        console.log('Missing auth artifacts rejected at image startup');
    } else {
        await checkRuntime();
        console.log(
            'Auth pages, OIDC lifecycle, restart and persisted account assertions passed',
        );
    }
} finally {
    try {
        await stopEntry();
    } finally {
        await fixture.close();
    }
}
