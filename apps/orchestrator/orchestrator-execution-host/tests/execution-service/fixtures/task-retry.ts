import { createHash, randomUUID } from 'node:crypto';
import { snapshotSha256 } from '@orchestrator/execution-service/service.ts';
import { testToken, readme } from './service.ts';

export function taskRetryTestClient(url: () => string) {
    return async (
        path: string,
        method = 'GET',
        body?: unknown,
        key?: string,
        owner = 'account-a',
    ) => {
        const response = await fetch(url() + '/v1' + path, {
            method,
            headers: {
                authorization: 'Bearer ' + testToken,
                'x-bento-owner-id': owner,
                ...(key ? { 'idempotency-key': key } : {}),
                ...(body === undefined
                    ? {}
                    : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(5000),
        });
        const text = await response.text();
        return {
            status: response.status,
            text,
            json: () => JSON.parse(text),
        };
    };
}

export function taskRetryTestInput() {
    return {
        id: randomUUID(),
        name: 'Retry task',
        sourceSpaceId: randomUUID(),
        inputFiles: readme,
        inputManifest: [
            {
                fileId: randomUUID(),
                path: 'README.md',
                bytes: Buffer.byteLength(readme[0]!.text),
                sha256: createHash('sha256')
                    .update(readme[0]!.text)
                    .digest('hex'),
            },
        ],
        inputDigest: snapshotSha256(readme),
    };
}
