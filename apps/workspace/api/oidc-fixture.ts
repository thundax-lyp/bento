import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

export const oidcFixtureClient = {
    clientId: 'bento-auth-fixture',
    clientSecret: 'fixture-only',
    organization: 'bento-fixture',
};
export const oidcFixtureEmail = 'fixture@example.test';

export async function startOidcFixture() {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
    });
    const key = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture' };
    let issuer = '';
    let requestCount = 0;
    let current:
        { nonce: string; challenge: string; state: string } | undefined;
    const codes = new Map<
        string,
        NonNullable<typeof current> & {
            subject: string;
            invited: boolean;
        }
    >();

    const server = createServer(async (request, response) => {
        const path = request.url;
        function json(status: number, value: object) {
            response.writeHead(status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(value));
        }
        if (path === '/.well-known/openid-configuration') {
            return json(200, {
                issuer,
                authorization_endpoint: issuer + '/authorize',
                token_endpoint: issuer + '/token',
                jwks_uri: issuer + '/jwks',
                end_session_endpoint: issuer + '/end-session',
                response_types_supported: ['code'],
                subject_types_supported: ['public'],
                id_token_signing_alg_values_supported: ['RS256'],
                token_endpoint_auth_methods_supported: ['client_secret_basic'],
                code_challenge_methods_supported: ['S256'],
            });
        }
        if (path === '/jwks') return json(200, { keys: [key] });
        if (path !== '/token' || request.method !== 'POST') {
            response.writeHead(404).end();
            return;
        }
        requestCount++;
        let body = '';
        for await (const chunk of request) body += String(chunk);
        const params = new URLSearchParams(body);
        const code = params.get('code') ?? '';
        const grant = codes.get(code);
        const verifier = params.get('code_verifier');
        if (
            !grant ||
            !verifier ||
            createHash('sha256').update(verifier).digest('base64url') !==
                grant.challenge
        ) {
            return json(400, { error: 'invalid_grant' });
        }
        codes.delete(code);
        const iat = Math.floor(Date.now() / 1000);
        const claims = {
            iss: issuer,
            sub: grant.subject,
            aud: oidcFixtureClient.clientId,
            iat,
            exp: iat + 60,
            auth_time: iat,
            nonce: grant.nonce,
            email: oidcFixtureEmail,
            email_verified: true,
            organization: grant.invited ? [oidcFixtureClient.organization] : [],
        };
        const encode = (value: object) =>
            Buffer.from(JSON.stringify(value)).toString('base64url');
        const signed =
            encode({ alg: 'RS256', kid: 'fixture' }) + '.' + encode(claims);
        return json(200, {
            access_token: 'fixture',
            token_type: 'Bearer',
            id_token:
                signed +
                '.' +
                sign('RSA-SHA256', Buffer.from(signed), privateKey).toString(
                    'base64url',
                ),
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('Fixture listener unavailable');
    issuer = 'http://127.0.0.1:' + address.port;
    return {
        issuer,
        authorization(url: URL) {
            const nonce = url.searchParams.get('nonce');
            const challenge = url.searchParams.get('code_challenge');
            const state = url.searchParams.get('state');
            if (!nonce || !challenge || !state)
                throw new Error('Incomplete authorization URL');
            current = { nonce, challenge, state };
        },
        setCode(code: string, subject: string, invited: boolean) {
            if (!current) throw new Error('Missing authorization URL');
            codes.set(code, { ...current, subject, invited });
            current = undefined;
        },
        tokenRequests: () => requestCount,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}
