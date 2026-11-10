import { readFileSync } from 'node:fs';
import { demoAccounts, readAccounts, sessionAuth } from './auth.ts';
import { mockBackend } from './mock.ts';
import { taskEntryServer } from './server.ts';
import { httpBackend } from './execution-service-http.ts';

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

function main() {
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
    const auth = sessionAuth(accounts, publicUrl.protocol === 'https:');
    const server = taskEntryServer({
        mode,
        origin: publicUrl.origin,
        backend,
        auth,
    });
    server.on('error', () => {
        console.error(
            'Bento task entry could not listen. Check its configured port.',
        );
        process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
        console.log(
            'Bento task entry (' + mode + ') listening on 127.0.0.1:' + port,
        );
    });
}

try {
    main();
} catch {
    console.error(
        'Invalid Bento task entry configuration. See src/task-entry/README.md.',
    );
    process.exitCode = 1;
}
