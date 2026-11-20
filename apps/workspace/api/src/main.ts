import { mockAccounts, mysqlAccounts } from './account-store.ts';
import { demoAccounts, sessionAuth } from './auth.ts';
import { keycloakAuth, WorkspaceAuthArtifactsError } from './oidc.ts';
import { mockBackend } from './mock.ts';
import { taskEntryServer } from './server.ts';
import { httpBackend } from './execution-service-http.ts';
import { mySpace } from './space.ts';
import { spaceStorage } from './space-storage.ts';

function positiveInteger(value: string, max: number, label: string): number {
    const result = Number(value);
    if (!Number.isInteger(result) || result < 1 || result > max)
        throw new Error('Invalid ' + label);
    return result;
}

function origin(value: string): URL {
    const url = new URL(value);
    if (
        !['https:', 'http:'].includes(url.protocol) ||
        value.replace(/\/$/, '') !== url.origin
    ) {
        throw new Error('Invalid origin');
    }
    return url;
}

async function main() {
    const env = process.env;
    const mode = env.BENTO_ONE_MODE ?? 'mock';
    if (mode !== 'mock' && mode !== 'http')
        throw new Error('Invalid BENTO_ONE_MODE');

    const port = positiveInteger(
        env.BENTO_ONE_PORT ?? '4101',
        65535,
        'BENTO_ONE_PORT',
    );
    const publicUrl = origin(
        env.BENTO_ONE_ORIGIN ?? 'http://127.0.0.1:' + port,
    );
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(
        publicUrl.hostname,
    );
    if (
        (!local && publicUrl.protocol !== 'https:') ||
        (mode === 'mock' && !local)
    ) {
        throw new Error('Invalid public origin for mode');
    }

    const mysql = env.BENTO_MYSQL_HOST ? mysqlAccounts() : undefined;
    const issuer = env.BENTO_OIDC_ISSUER;
    if (env.BENTO_AUTH_MODE === 'keycloak' && !issuer)
        throw new Error('Keycloak issuer is required');
    if (issuer && !mysql)
        throw new Error('Keycloak requires MySQL account storage');
    if (mode === 'http' && !mysql)
        throw new Error('MySQL account storage is required in HTTP mode');

    let backend;
    if (mode === 'mock') {
        backend = mockBackend();
    } else {
        const executionServiceUrl = env.BENTO_ONE_TWO_URL;
        const bearer = env.BENTO_ONE_TWO_BEARER;
        if (
            !executionServiceUrl ||
            !bearer ||
            !/^[A-Za-z0-9._~+/=-]+$/.test(bearer)
        ) {
            throw new Error(
                'Missing or invalid execution service configuration',
            );
        }
        const timeout = positiveInteger(
            env.BENTO_ONE_TWO_TIMEOUT_MS ?? '10000',
            30000,
            'BENTO_ONE_TWO_TIMEOUT_MS',
        );
        backend = httpBackend(
            origin(executionServiceUrl).origin,
            bearer,
            timeout,
        );
    }
    const auth = sessionAuth(
        mysql ?? mockAccounts(demoAccounts()),
        publicUrl.protocol === 'https:',
        !!issuer,
    );
    const oidc =
        issuer && mysql
            ? await keycloakAuth({
                  issuer,
                  origin: publicUrl,
                  clientId: env.BENTO_OIDC_CLIENT_ID ?? '',
                  clientSecret: env.BENTO_OIDC_CLIENT_SECRET ?? '',
                  organization: env.BENTO_OIDC_ORGANIZATION ?? '',
                  store: mysql,
                  auth,
              })
            : undefined;
    const endpoint = env.BENTO_SPACE_S3_ENDPOINT;
    const bucket = env.BENTO_SPACE_S3_BUCKET;
    const database = env.BENTO_SPACE_DB;
    let space;
    if (endpoint || bucket || database) {
        if (
            !endpoint ||
            !bucket ||
            !database ||
            database === ':memory:' ||
            !mysql
        )
            throw new Error('Incomplete space configuration');
        const storageUrl = origin(endpoint);
        if (
            storageUrl.protocol !== 'https:' &&
            (!local ||
                !['127.0.0.1', 'localhost', '[::1]'].includes(
                    storageUrl.hostname,
                ))
        )
            throw new Error('Space storage requires HTTPS');
        if (!local && storageUrl.hostname === publicUrl.hostname)
            throw new Error('Space storage requires a separate hostname');
        space = mySpace(
            database,
            spaceStorage(
                storageUrl.origin,
                bucket,
                env.AWS_REGION ?? 'us-east-1',
            ),
            backend,
        );
    }
    const server = await taskEntryServer({
        port,
        origin: publicUrl.origin,
        backend,
        auth,
        ...(oidc ? { oidc } : {}),
        ...(space ? { space } : {}),
    });
    const stop = () => {
        void server.close().catch(() => {
            console.error('Bento task entry did not shut down cleanly.');
            process.exitCode = 1;
        });
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    console.log(
        'Bento task entry (' +
            mode +
            ') listening on ' +
            new URL(server.origin).host,
    );
}

try {
    await main();
} catch (error) {
    if (error instanceof WorkspaceAuthArtifactsError) {
        console.error('Workspace auth build artifacts are unavailable');
    }
    console.error(
        'Invalid Bento task entry configuration or listener unavailable. See apps/workspace/api/README.md.',
    );
    process.exitCode = 1;
}
