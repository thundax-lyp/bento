import { readFileSync } from 'node:fs';
import { demoAccounts, readAccounts, sessionAuth } from './auth.ts';
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

    const file = env.BENTO_ONE_ACCOUNTS_FILE;
    const accounts = file
        ? readAccounts(JSON.parse(readFileSync(file, 'utf8')))
        : mode === 'mock'
          ? demoAccounts()
          : undefined;
    if (!accounts) throw new Error('Missing invited accounts');

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
    const credentialPath =
        env.BENTO_ONE_CREDENTIALS_DB ?? (file ? file + '.sqlite' : ':memory:');
    if (mode === 'http' && credentialPath === ':memory:')
        throw new Error('Credential storage must persist');
    const auth = sessionAuth(
        accounts,
        publicUrl.protocol === 'https:',
        credentialPath,
    );
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
            !file
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
} catch {
    console.error(
        'Invalid Bento task entry configuration or listener unavailable. See apps/workspace/api/README.md.',
    );
    process.exitCode = 1;
}
