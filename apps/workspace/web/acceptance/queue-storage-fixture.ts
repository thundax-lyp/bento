import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { spaceStorage } from '@/apps/workspace/api/src/space/storage.ts';

const digest = (bytes: Buffer) =>
    createHash('sha256').update(bytes).digest('base64');

// Synthetic signed capabilities; multipart requests and stored bytes are real.
export async function startQueueStorageFixture(
    directory: string,
    origin: string,
) {
    type Part = {
        number: number;
        size: number;
        checksum: string;
        etag: string;
    };
    type Signature = Part & { key: string; upload: string; expires: number };
    const uploads = new Map<string, string>();
    const parts = new Map<string, Map<number, Part>>();
    const signatures = new Map<string, Signature>();
    const downloads = new Map<string, { key: string; expires: number }>();
    const handlers = new Set<Promise<void>>();
    let createdUploads = 0;
    let signedParts = 0;
    let inFlight = 0;
    let partsWritten = 0;
    let objectsWritten = 0;
    let bytesWritten = 0;
    let released = false;
    let held = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let entered!: (value: {
        key: string;
        number: number;
        bytes: number;
    }) => void;
    const holding = new Promise<{ key: string; number: number; bytes: number }>(
        (resolve) => {
            entered = resolve;
        },
    );
    const path = (key: string, part?: number) => {
        assert.match(key, /^space\/[0-9a-f-]{36}$/);
        return part === undefined
            ? join(directory, 'objects', key.slice(6))
            : join(directory, 'parts', key.slice(6), String(part));
    };
    async function save(key: string, bytes: Buffer) {
        await mkdir(join(directory, 'objects'), { recursive: true });
        await writeFile(path(key), bytes);
        objectsWritten++;
        bytesWritten += bytes.length;
    }
    async function clear(key: string) {
        await rm(join(directory, 'parts', key.slice(6)), {
            recursive: true,
            force: true,
        });
        parts.delete(key);
        uploads.delete(key);
    }
    const server = createServer((request, response) => {
        const work = (async () => {
            try {
                const url = new URL(request.url ?? '/', 'http://localhost');
                if (request.headers.origin === origin) {
                    response.setHeader('Access-Control-Allow-Origin', origin);
                    response.setHeader(
                        'Access-Control-Allow-Methods',
                        'PUT, GET, OPTIONS',
                    );
                    response.setHeader(
                        'Access-Control-Allow-Headers',
                        'content-length, x-amz-checksum-sha256, content-type',
                    );
                }
                if (request.method === 'OPTIONS') {
                    response
                        .writeHead(
                            request.headers.origin === origin ? 204 : 403,
                        )
                        .end();
                    return;
                }
                const token = url.searchParams.get('token') ?? '';
                const signature = signatures.get(token);
                if (
                    request.method === 'PUT' &&
                    signature &&
                    url.pathname ===
                        `/parts/${signature.key.slice(6)}/${signature.number}`
                ) {
                    if (
                        signature.expires <= Date.now() ||
                        uploads.get(signature.key) !== signature.upload ||
                        Number(request.headers['content-length']) !==
                            signature.size ||
                        request.headers['x-amz-checksum-sha256'] !==
                            signature.checksum
                    ) {
                        response.writeHead(403).end();
                        return;
                    }
                    const chunks: Buffer[] = [];
                    for await (const chunk of request)
                        chunks.push(Buffer.from(chunk));
                    const bytes = Buffer.concat(chunks);
                    if (
                        bytes.length !== signature.size ||
                        digest(bytes) !== signature.checksum
                    ) {
                        response.writeHead(403).end();
                        return;
                    }
                    inFlight++;
                    try {
                        if (
                            !released &&
                            !held &&
                            signature.number === 1 &&
                            bytes.length === 16_777_216
                        ) {
                            held = true;
                            entered({
                                key: signature.key,
                                number: 1,
                                bytes: bytes.length,
                            });
                            await gate;
                        }
                        await mkdir(
                            join(directory, 'parts', signature.key.slice(6)),
                            { recursive: true },
                        );
                        await writeFile(
                            path(signature.key, signature.number),
                            bytes,
                        );
                        const entries =
                            parts.get(signature.key) ?? new Map<number, Part>();
                        entries.set(signature.number, signature);
                        parts.set(signature.key, entries);
                        partsWritten++;
                        bytesWritten += bytes.length;
                        response.writeHead(200).end();
                    } finally {
                        inFlight--;
                    }
                    return;
                }
                const download = downloads.get(token);
                if (
                    request.method === 'GET' &&
                    download &&
                    download.expires > Date.now() &&
                    url.pathname === '/objects/' + download.key.slice(6)
                ) {
                    try {
                        const bytes = await readFile(path(download.key));
                        response
                            .writeHead(200, {
                                'Content-Type': 'application/octet-stream',
                            })
                            .end(bytes);
                    } catch (error) {
                        if (
                            error instanceof Error &&
                            'code' in error &&
                            error.code === 'ENOENT'
                        )
                            response.writeHead(404).end();
                        else throw error;
                    }
                    return;
                }
                response.writeHead(403).end();
            } catch {
                response.writeHead(500).end();
            }
        })().finally(() => handlers.delete(work));
        handlers.add(work);
    });
    const releaseParts = () => {
        released = true;
        release();
    };
    let closing: Promise<void> | undefined;
    const close = () =>
        (closing ??= (async () => {
            releaseParts();
            await new Promise<void>((resolve, reject) => {
                if (!server.listening) {
                    resolve();
                    return;
                }
                server.close((error) => (error ? reject(error) : resolve()));
                server.closeAllConnections();
            });
            await Promise.all(handlers);
        })());
    try {
        const listening = once(server, 'listening');
        server.listen(0, '127.0.0.1');
        await listening;
        const address = server.address();
        assert(address && typeof address !== 'string');
        const objectOrigin = 'http://127.0.0.1:' + address.port;
        const storage = spaceStorage(objectOrigin, 'fixture', 'us-east-1');
        storage.create = async (key) => {
            assert(!uploads.has(key));
            const upload = randomUUID();
            uploads.set(key, upload);
            createdUploads++;
            return upload;
        };
        storage.signPart = async (key, upload, number, size, checksum) => {
            assert.equal(uploads.get(key), upload);
            const token = randomUUID();
            signatures.set(token, {
                key,
                upload,
                number,
                size,
                checksum,
                expires: Date.now() + 600000,
                etag: `"part-${number}"`,
            });
            signedParts++;
            return `${objectOrigin}/parts/${key.slice(6)}/${number}?token=${token}`;
        };
        storage.parts = async (key, upload) => {
            if (uploads.get(key) !== upload) return null;
            return Promise.all(
                [...(parts.get(key)?.values() ?? [])].map(async (part) => {
                    const bytes = await readFile(path(key, part.number));
                    return {
                        PartNumber: part.number,
                        ETag: part.etag,
                        Size: bytes.length,
                        ChecksumSHA256: digest(bytes),
                    };
                }),
            );
        };
        storage.complete = async (key, upload, completed) => {
            assert.equal(uploads.get(key), upload);
            const chunks: Buffer[] = [];
            for (const [index, part] of completed.entries()) {
                assert.equal(part.PartNumber, index + 1);
                const entry = parts.get(key)?.get(index + 1);
                assert(entry);
                const bytes = await readFile(path(key, index + 1));
                assert.equal(part.ETag, entry.etag);
                assert.equal(part.ChecksumSHA256, digest(bytes));
                chunks.push(bytes);
            }
            await save(key, Buffer.concat(chunks));
            await clear(key);
        };
        storage.empty = async (key) => {
            await save(key, Buffer.alloc(0));
        };
        storage.size = async (key) => {
            try {
                return (await stat(path(key))).size;
            } catch (error) {
                if (
                    error instanceof Error &&
                    'code' in error &&
                    error.code === 'ENOENT'
                )
                    return null;
                throw error;
            }
        };
        storage.read = async (key, size) => {
            const bytes = await readFile(path(key));
            assert.equal(bytes.length, size);
            return bytes;
        };
        storage.abort = async (key) => {
            await clear(key);
        };
        storage.remove = async (key) => {
            await rm(path(key), { force: true });
        };
        const download = async (key: string) => {
            const token = randomUUID();
            downloads.set(token, { key, expires: Date.now() + 300000 });
            return `${objectOrigin}/objects/${key.slice(6)}?token=${token}`;
        };
        storage.download = storage.preview = download;
        return {
            storage,
            async waitHeldPart() {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    return await Promise.race([
                        holding,
                        new Promise<never>((_, reject) => {
                            timer = setTimeout(
                                () =>
                                    reject(
                                        Error(
                                            'Multipart gate not entered within 10 seconds',
                                        ),
                                    ),
                                10000,
                            );
                        }),
                    ]);
                } finally {
                    clearTimeout(timer);
                }
            },
            releaseParts,
            observe: () => ({
                inFlight,
                createdUploads,
                signedParts,
                partsWritten,
                objectsWritten,
                bytesWritten,
            }),
            close,
        };
    } catch (error) {
        await close();
        throw error;
    }
}
