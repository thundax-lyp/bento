import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as oidc from 'openid-client';
import type { mysqlAccounts } from './account-store.ts';
import type { sessionAuth } from './auth.ts';
import { authPage, authStyles } from '../auth/auth-page.ts';
import { notFound, RequestError } from './protocol.ts';

const prefix = '/api/oidc/';
const transactionAge = 300;
const digest = (value: string) =>
    createHash('sha256').update(value).digest('hex');
const denied = () =>
    new RequestError(
        401,
        'oidc_denied',
        '此身份没有有效的 Bento 邀请，请从登录页重试。',
    );
const loopback = (url: URL) =>
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

type Options = {
    origin: URL;
    issuer: string;
    clientId: string;
    clientSecret: string;
    organization: string;
    store: ReturnType<typeof mysqlAccounts>;
    auth: ReturnType<typeof sessionAuth>;
};

export async function keycloakAuth({
    origin,
    issuer,
    clientId,
    clientSecret,
    organization,
    store,
    auth,
}: Options) {
    const provider = new URL(issuer);
    const insecure =
        provider.protocol === 'http:' && loopback(provider) && loopback(origin);
    if (
        (!insecure && provider.protocol !== 'https:') ||
        provider.username ||
        provider.password ||
        provider.search ||
        provider.hash ||
        !clientId ||
        !clientSecret ||
        !organization
    ) {
        throw new Error('Invalid Keycloak settings');
    }
    const config = await oidc.discovery(
        provider,
        clientId,
        clientSecret,
        undefined,
        {
            execute: [
                ...(insecure ? [oidc.allowInsecureRequests] : []),
                oidc.enableNonRepudiationChecks,
            ],
        },
    );
    config.timeout = 8;
    const callback = origin.origin + prefix + 'callback';
    const secure = origin.protocol === 'https:';
    const cookieName = secure ? '__Host-bento_oidc' : 'bento_oidc';
    const transactionCookie = (value: string, age: number) =>
        cookieName +
        '=' +
        value +
        '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' +
        age +
        (secure ? '; Secure' : '');
    type Transaction = {
        state: string;
        nonce: string;
        verifier: string;
        expires: number;
        closing?: Awaited<ReturnType<typeof auth.session>>;
    };
    const transactions = new Map<string, Transaction>();

    function transactionKey(request: IncomingMessage) {
        const marker = cookieName + '=';
        const matches = request.headers.cookie
            ?.split(';')
            .map((part) => part.trim())
            .filter((part) => part.startsWith(marker));
        const value = matches?.[0]?.slice(marker.length);
        return matches?.length === 1 &&
            value &&
            /^[A-Za-z0-9_-]{43}$/.test(value)
            ? digest(value)
            : undefined;
    }

    function redirect(
        response: ServerResponse,
        url: string | URL,
        cookies: string[],
    ) {
        response.writeHead(303, {
            Location: String(url),
            'Set-Cookie': cookies,
        });
        response.end();
    }

    function endSession(idToken: string) {
        return oidc.buildEndSessionUrl(config, {
            id_token_hint: idToken,
            post_logout_redirect_uri: origin.origin + '/auth',
        });
    }

    return async (
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
        spaceRequired: boolean,
    ) => {
        const path = url.pathname;
        if (request.method === 'GET' && path === '/auth/style.css') {
            response.setHeader('Content-Type', 'text/css; charset=utf-8');
            response.end(authStyles);
            return;
        }
        if (request.method === 'GET' && path === '/auth') {
            const signedIn = await auth.account(request).then(
                () => true,
                (error: unknown) => {
                    if (error instanceof RequestError && error.status === 401)
                        return false;
                    throw error;
                },
            );
            response.setHeader('Referrer-Policy', 'same-origin');
            response.setHeader(
                'Content-Security-Policy',
                "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' " +
                    provider.origin,
            );
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end(authPage(signedIn));
            return;
        }
        if (request.method === 'POST' && path === prefix + 'logout') {
            const session = await auth.session(request);
            if (!session.oidc) throw denied();
            redirect(response, endSession(session.oidc.idToken), [
                auth.logout(request),
            ]);
            return;
        }
        const isLogin = request.method === 'GET' && path === prefix + 'start';
        const isClose = request.method === 'POST' && path === prefix + 'close';
        if (isLogin || isClose) {
            const closing = isClose ? await auth.session(request) : undefined;
            if (isClose) {
                let form = '';
                for await (const chunk of request) {
                    form += String(chunk);
                    if (form.length > 128) throw denied();
                }
                if (form !== 'confirmed=yes') throw denied();
            }
            const prior = transactionKey(request);
            if (prior) transactions.delete(prior);
            const now = Date.now();
            for (const [key, transaction] of transactions) {
                if (transaction.expires <= now) transactions.delete(key);
            }
            if (transactions.size >= 2048)
                throw new RequestError(
                    503,
                    'auth_busy',
                    '登录请求较多，请稍后重试。',
                );
            const value = randomBytes(32).toString('base64url');
            const transaction = {
                state: oidc.randomState(),
                nonce: oidc.randomNonce(),
                verifier: oidc.randomPKCECodeVerifier(),
                expires: now + transactionAge * 1000,
                ...(closing ? { closing } : {}),
            };
            const challenge = await oidc.calculatePKCECodeChallenge(
                transaction.verifier,
            );
            transactions.set(digest(value), transaction);
            redirect(
                response,
                oidc.buildAuthorizationUrl(config, {
                    redirect_uri: callback,
                    scope: 'openid email organization:*',
                    state: transaction.state,
                    nonce: transaction.nonce,
                    code_challenge: challenge,
                    code_challenge_method: 'S256',
                    ...(closing ? { max_age: '0', prompt: 'login' } : {}),
                }),
                [transactionCookie(value, transactionAge)],
            );
            return;
        }
        if (request.method !== 'GET' || path !== prefix + 'callback')
            throw notFound();
        const key = transactionKey(request);
        const transaction = key ? transactions.get(key) : undefined;
        if (
            !key ||
            !transaction ||
            transaction.expires <= Date.now() ||
            url.searchParams.get('state') !== transaction.state
        )
            throw denied();
        transactions.delete(key);
        const clear = transactionCookie('', 0);
        response.setHeader('Set-Cookie', clear);
        const tokens = await oidc
            .authorizationCodeGrant(config, url, {
                pkceCodeVerifier: transaction.verifier,
                expectedState: transaction.state,
                expectedNonce: transaction.nonce,
                ...(transaction.closing ? { maxAge: 0 } : {}),
            })
            .catch((error: unknown) => {
                if (
                    error instanceof oidc.AuthorizationResponseError ||
                    (error instanceof oidc.ResponseBodyError &&
                        error.error === 'invalid_grant')
                ) {
                    throw denied();
                }
                throw error;
            });
        const claims = tokens.claims();
        const membership = claims?.organization;
        const invited = Array.isArray(membership)
            ? membership.includes(organization)
            : !!membership &&
              typeof membership === 'object' &&
              Object.hasOwn(membership, organization);
        if (
            !tokens.id_token ||
            !claims ||
            claims.email_verified !== true ||
            typeof claims.email !== 'string' ||
            !invited
        )
            throw denied();
        // Check the original session before any account operation on a close callback.
        if (
            transaction.closing &&
            ((await auth.session(request)) !== transaction.closing ||
                transaction.closing.oidc?.subject !== claims.sub)
        )
            throw denied();
        const identity = await store.bindOidc(
            claims.iss,
            claims.sub,
            claims.email,
        );
        if (!identity || identity.closed) throw denied();
        if (transaction.closing) {
            if (identity.ownerId !== transaction.closing.account.ownerId)
                throw denied();
            const expired = await auth.closeVerified(
                request,
                identity.ownerId,
                spaceRequired,
            );
            redirect(response, endSession(tokens.id_token), [clear, expired]);
            return;
        }
        redirect(response, '/', [
            clear,
            auth.startSession(request, identity, {
                idToken: tokens.id_token,
                subject: claims.sub,
            }).cookie,
        ]);
    };
}
