import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { mockAccounts } from './account-store.ts';
import { sessionAuth } from './auth.ts';
import { mockBackend } from './mock.ts';
import {
    oidcFixtureClient,
    oidcFixtureEmail,
    startOidcFixture,
} from './oidc-fixture.ts';
import { keycloakAuth } from './oidc.ts';
import { taskEntryServer } from './server.ts';

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
            await readFile(new URL('../auth/dist/' + file, import.meta.url)),
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
