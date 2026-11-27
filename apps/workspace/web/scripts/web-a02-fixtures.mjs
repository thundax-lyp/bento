import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import dns from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const size = 100_000_000;
export const partSize = 16_777_216;
export const partCount = Math.ceil(size / partSize);
export const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export function origin(value) {
    const url = new URL(value);
    assert.equal(url.origin, value);
    assert(
        url.protocol === 'https:' ||
            (url.protocol === 'http:' &&
                ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)),
    );
    return url.origin;
}

export async function digest(file) {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    return hash.digest('hex');
}

export async function fixtures(directory, size) {
    const partCount = Math.ceil(size / partSize);
    const files = [];
    for (const variant of ['original', 'changed', 'oversize']) {
        const folder = join(directory, variant);
        await fs.mkdir(folder, { mode: 0o700 });
        const file = join(
            folder,
            variant === 'oversize' ? 'oversize.bin' : 'web-a02.bin',
        );
        const handle = await fs.open(file, 'wx', 0o600);
        try {
            await handle.truncate(size + Number(variant === 'oversize'));
            if (variant !== 'oversize') {
                for (let i = 0; i < partCount; i++) {
                    const end = Math.min((i + 1) * partSize, size) - 1;
                    await handle.write(
                        Buffer.from([i + 1]),
                        0,
                        1,
                        i * partSize,
                    );
                    await handle.write(Buffer.from([255 - i]), 0, 1, end);
                }
                if (variant === 'changed') {
                    await handle.write(Buffer.from([0]), 0, 1, size - 1);
                }
            }
        } finally {
            await handle.close();
        }
        files.push(file);
    }
    return files;
}

export async function verifyExpiredPut(url, original, checksum) {
    const bytes = Buffer.alloc(partSize);
    const file = await fs.open(original, 'r');
    try {
        const { bytesRead } = await file.read(bytes, 0, partSize, partSize);
        assert.equal(bytesRead, partSize);
    } finally {
        await file.close();
    }
    assert.equal(createHash('sha256').update(bytes).digest('base64'), checksum);
    const address = await dns.lookup(new URL(url).hostname, { family: 4 });
    const { status, body, sent } = await new Promise((resolve, reject) => {
        let sent = false;
        const request = httpsRequest(
            url,
            {
                method: 'PUT',
                signal: globalThis.AbortSignal.timeout(30_000),
                lookup: (_hostname, options, callback) =>
                    options.all
                        ? callback(null, [address])
                        : callback(null, address.address, address.family),
                headers: {
                    Expect: '100-continue',
                    'content-length': String(bytes.length),
                    'x-amz-checksum-sha256': checksum,
                },
            },
            (response) => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => {
                    if (body.length < 4096) body += chunk;
                });
                response.on('error', reject);
                response.on('end', () =>
                    resolve({ status: response.statusCode, body, sent }),
                );
            },
        );
        request.once('continue', () => {
            sent = true;
            request.end(bytes);
        });
        request.on('error', reject);
        request.flushHeaders();
    });
    console.log('WEB_A02_EXPIRED_NODE_PUT', status, bytes.length, Number(sent));
    assert(sent, 'expired PUT sent the original block');
    assert.equal(status, 403);
    assert.match(body, /<Code>AccessDenied<\/Code>/);
    assert.match(body, /<Message>[^<]*expired/i);
}

export async function poll(read, accept, timeout = 30_000) {
    const end = Date.now() + timeout;
    do {
        const value = await read();
        if (accept(value)) return value;
        await delay(250);
    } while (Date.now() < end);
    throw Error('poll timeout');
}
