import assert from 'node:assert/strict';

import { connect } from 'node:http2';
import { setTimeout as delay } from 'node:timers/promises';
import { serveExecution } from '@/apps/orchestrator/src/execution-service/service.ts';
import {
    type ExecutionHost,
    type FileText,
    type WorkerRequest,
} from '@/apps/orchestrator/src/execution-service/types.ts';

export const testToken = 'fixture-only-bento-service-bearer';
export const readme = [{ path: 'README.md', text: '# Fixture\n' }];
export function barrier() {
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
export const fixtureSdk = {
    upstream: new URL('https://127.0.0.1:1'),
    credentials: {
        ca: Buffer.alloc(0),
        cert: Buffer.alloc(0),
        key: Buffer.alloc(0),
    },
    workspace: 'default',
    decode: () => {
        throw new Error('Denied probes should not reach the decoder');
    },
};

export type ResponseBody = {
    id: string;
    status: string;
    sessionId: string;
    projects?: { id: string }[];
};
export function client(url: string, owner = 'account-a', token = testToken) {
    return async (
        path: string,
        method = 'GET',
        body?: unknown,
        key?: string,
    ) => {
        const response = await fetch(url + '/v1/projects' + path, {
            method,
            headers: {
                authorization: 'Bearer ' + token,
                'x-bento-owner-id': owner,
                ...(body === undefined
                    ? {}
                    : { 'content-type': 'application/json' }),
                ...(key === undefined ? {} : { 'idempotency-key': key }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(5000),
        });
        const type = response.headers.get('content-type');
        const text = await response.text();
        return {
            status: response.status,
            type,
            text,
            json: () => JSON.parse(text) as ResponseBody,
        };
    };
}

export async function until<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    label: string,
) {
    for (let i = 0; i < 250; i++) {
        const value = await read();
        if (done(value)) return value;
        await delay(20);
    }
    throw new Error('Timed out: ' + label);
}

export async function project(
    api: ReturnType<typeof client>,
    files: FileText[] = readme,
) {
    const created = await api('', 'POST', { name: 'Text project', files });
    assert.equal(created.status, 201);
    const path = '/' + created.json().id;
    await until(
        () => api(path),
        (r) => r.json().status === 'ready',
        'project ready',
    );
    return path;
}

export async function submit(
    api: ReturnType<typeof client>,
    projectPath: string,
    prompt: string,
    key: string,
) {
    const response = await api(projectPath + '/runs', 'POST', { prompt }, key);
    assert.equal(response.status, 202);
    return projectPath + '/runs/' + response.json().id;
}

export async function rpc(
    request: WorkerRequest,
    method: string,
    fields: object = {},
) {
    return fetch(new URL('/rpc', request.persistenceUrl), {
        method: 'POST',
        headers: { authorization: 'Bearer ' + request.grant.token },
        body: JSON.stringify({ method, id: request.grant.session, ...fields }),
        signal: AbortSignal.timeout(5000),
    });
}

export async function operation(request: WorkerRequest) {
    return fetch(new URL('/operations', request.operationUrl), {
        method: 'POST',
        headers: { authorization: 'Bearer ' + request.grant.token },
        body: JSON.stringify({ id: 'forbidden', input: 'probe' }),
        signal: AbortSignal.timeout(5000),
    });
}

export async function sdk(request: WorkerRequest) {
    assert(request.gateway);
    const transport = connect(request.gateway);
    return new Promise<string>((resolve, reject) => {
        const call = transport.request({
            ':method': 'POST',
            ':path': '/openshell.v1.OpenShell/ExecSandbox',
            'content-type': 'application/grpc',
            authorization: 'Bearer ' + request.grant.token,
        });
        const timeout = setTimeout(
            () => transport.destroy(new Error('SDK probe timed out')),
            3000,
        );
        transport.once('error', reject);
        transport.once('close', () => clearTimeout(timeout));
        call.once('error', reject);
        call.once('response', (headers) => {
            resolve(String(headers['grpc-status']));
            transport.destroy();
        });
        call.resume();
        call.end(Buffer.alloc(5));
    });
}

export async function start(state: string, host: ExecutionHost) {
    return serveExecution({
        state,
        host,
        token: testToken,
        retryMs: 20,
        workerTimeoutMs: 15_000,
    });
}
