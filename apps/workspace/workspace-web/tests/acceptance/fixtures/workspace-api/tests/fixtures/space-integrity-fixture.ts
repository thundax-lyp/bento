import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { mockAccounts } from '@workspace-api-fixture/account-store.ts';
import { demoAccounts, sessionAuth } from '@workspace-api-fixture/auth.ts';
import { mockBackend } from '@workspace-api-fixture/mock.ts';
import type { Backend } from '@workspace-api-fixture/protocol.ts';
import { taskEntryServer } from '@workspace-api-fixture/server.ts';
import {
    spaceObjectKey,
    spaceStorage,
} from '@workspace-api-fixture/space/storage.ts';
import { mySpace } from '@workspace-api-fixture/space/index.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Row = Record<string, SQLOutputValue>;
type SpaceTable =
    | 'space_projects'
    | 'space_uploads'
    | 'space_file_deletions'
    | 'space_project_deletions'
    | 'space_tasks'
    | 'space_task_inputs';
type Call = {
    op:
        | 'create'
        | 'signPart'
        | 'putPart'
        | 'parts'
        | 'complete'
        | 'empty'
        | 'size'
        | 'read'
        | 'remove'
        | 'abort'
        | 'download'
        | 'preview';
    key: string;
    part: number | null;
};
type ObjectFile = { path: string; size: number; sha256: string };
type PartFile = ObjectFile & { number: number; etag: string; checksum: string };
type PartFault =
    { kind: 'size'; delta: -1 } | { kind: 'checksum'; value: string };
type CompleteFault = 'reject' | 'short';
export type SpaceIntegrityFixture = {
    readonly ownerId: string;
    readonly account: 'demo';
    readonly projectId: string;
    readonly dbPath: string;
    readonly apiOrigin: string;
    readonly storage: ReturnType<typeof spaceStorage>;
    readonly objects: ReadonlyMap<string, ObjectFile>;
    readonly parts: ReadonlyMap<string, ReadonlyMap<number, PartFile>>;
    readonly calls: readonly Call[];
    request(
        path: string,
        method?: string,
        body?: Json,
        key?: string,
    ): Promise<{ status: number; json: Json; location: string | null }>;
    putPart(uploadId: string, number: number, bytes: Buffer): Promise<void>;
    download(fileId: string): Promise<Buffer>;
    readObject(uploadId: string): Promise<Buffer | null>;
    readPart(uploadId: string, number: number): Promise<Buffer | null>;
    setPartFault(
        uploadId: string,
        number: number,
        fault: PartFault | null,
    ): void;
    setCompleteFault(uploadId: string, fault: CompleteFault | null): void;
    setCleanupFault(uploadId: string, fault: 'remove-reject' | null): void;
    rows(table: SpaceTable): Row[];
    suspend(): Promise<void>;
    reopen(): Promise<void>;
    close(): Promise<void>;
};
const sha = (bytes: Buffer, encoding: 'hex' | 'base64') =>
    createHash('sha256').update(bytes).digest(encoding);
const jsonObject = (value: Json): { [key: string]: Json } => {
    assert(
        value !== null && typeof value === 'object' && !Array.isArray(value),
    );
    return value;
};
async function optionalBytes(path: string): Promise<Buffer | null> {
    try {
        return await readFile(path);
    } catch (error) {
        if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
        )
            return null;
        throw error;
    }
}

// Identity and signed storage capabilities are synthetic. API, SQLite and bytes are real.
export async function openSpaceIntegrityFixture(
    options: { port?: number; origin?: string; backend?: Backend } = {},
): Promise<SpaceIntegrityFixture> {
    const directory = await mkdtemp(join(tmpdir(), 'bento-space-integrity-'));
    const dbPath = join(directory, 'space.sqlite');
    const accounts = demoAccounts();
    const demo = accounts.find((account) => account.account === 'demo')!;
    const auth = sessionAuth(mockAccounts(accounts), false, false);
    const backend = options.backend ?? mockBackend();
    const origin = options.origin ?? 'http://127.0.0.1:4354';
    const projectId = randomUUID();
    const objects = new Map<string, ObjectFile>();
    const parts = new Map<string, Map<number, PartFile>>();
    const multipart = new Map<string, string>();
    const calls: Call[] = [];
    const partFaults = new Map<string, PartFault>();
    const completeFaults = new Map<string, CompleteFault>();
    const cleanupFaults = new Set<string>();
    const partTokens = new Map<
        string,
        {
            key: string;
            upload: string;
            number: number;
            size: number;
            checksum: string;
            expires: number;
        }
    >();
    const objectTokens = new Map<string, { key: string; expires: number }>();
    const filePath = (key: string) => join(directory, 'objects', key.slice(6));
    const partPath = (key: string, number: number) =>
        join(directory, 'parts', key.slice(6), String(number));
    const record = (
        op: Call['op'],
        key: string,
        part: number | null = null,
    ) => {
        calls.push({ op, key, part });
    };
    async function saveObject(key: string, bytes: Buffer) {
        const path = filePath(key);
        await mkdir(join(directory, 'objects'), { recursive: true });
        await writeFile(path, bytes);
        objects.set(key, {
            path,
            size: bytes.length,
            sha256: sha(bytes, 'hex'),
        });
    }
    async function clearParts(key: string) {
        await rm(join(directory, 'parts', key.slice(6)), {
            recursive: true,
            force: true,
        });
        parts.delete(key);
        multipart.delete(key);
    }
    const objectServer = createServer(async (request, response) => {
        try {
            const url = new URL(request.url ?? '/', 'http://fixture.invalid');
            if (request.headers.origin === origin) {
                response.setHeader('Access-Control-Allow-Origin', origin);
                response.setHeader(
                    'Access-Control-Allow-Methods',
                    'PUT, GET, OPTIONS',
                );
                response.setHeader(
                    'Access-Control-Allow-Headers',
                    'x-amz-checksum-sha256, content-type',
                );
            }
            if (request.method === 'OPTIONS') {
                response
                    .writeHead(request.headers.origin === origin ? 204 : 403)
                    .end();
                return;
            }
            const token = url.searchParams.get('token') ?? '';
            const signature = partTokens.get(token);
            if (
                request.method === 'PUT' &&
                signature &&
                url.pathname ===
                    `/parts/${signature.key.slice(6)}/${signature.number}`
            ) {
                if (
                    signature.expires <= Date.now() ||
                    multipart.get(signature.key) !== signature.upload ||
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
                    sha(bytes, 'base64') !== signature.checksum
                ) {
                    response.writeHead(403).end();
                    return;
                }
                record('putPart', signature.key, signature.number);
                const path = partPath(signature.key, signature.number);
                await mkdir(join(directory, 'parts', signature.key.slice(6)), {
                    recursive: true,
                });
                await writeFile(path, bytes);
                const entry: PartFile = {
                    path,
                    size: bytes.length,
                    sha256: sha(bytes, 'hex'),
                    checksum: sha(bytes, 'base64'),
                    number: signature.number,
                    etag: `"part-${signature.number}"`,
                };
                const entries =
                    parts.get(signature.key) ?? new Map<number, PartFile>();
                entries.set(signature.number, entry);
                parts.set(signature.key, entries);
                response.writeHead(200).end();
                return;
            }
            const read = objectTokens.get(token);
            if (
                request.method === 'GET' &&
                read &&
                read.expires > Date.now() &&
                url.pathname === '/objects/' + read.key.slice(6)
            ) {
                const bytes = await optionalBytes(filePath(read.key));
                if (bytes === null) response.writeHead(404).end();
                else
                    response
                        .writeHead(200, {
                            'Content-Type': 'application/octet-stream',
                        })
                        .end(bytes);
                return;
            }
            response.writeHead(403).end();
        } catch {
            response.writeHead(500).end();
        }
    });
    let web: Awaited<ReturnType<typeof taskEntryServer>> | undefined;
    let cookie = '';
    async function suspend() {
        await web?.close();
        web = undefined;
    }
    async function close() {
        try {
            await suspend();
        } finally {
            try {
                await new Promise<void>((resolve, reject) => {
                    objectServer.close((error) =>
                        error ? reject(error) : resolve(),
                    );
                    objectServer.closeAllConnections();
                });
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        }
    }
    try {
        const listening = once(objectServer, 'listening');
        objectServer.listen(0, '127.0.0.1');
        await listening;
        const address = objectServer.address();
        assert(address && typeof address !== 'string');
        const objectOrigin = 'http://127.0.0.1:' + address.port;
        const storage = spaceStorage(objectOrigin, 'fixture', 'us-east-1');
        storage.create = async (key) => {
            record('create', key);
            assert(!multipart.has(key));
            const upload = randomUUID();
            multipart.set(key, upload);
            return upload;
        };
        storage.signPart = async (key, upload, number, size, checksum) => {
            record('signPart', key, number);
            assert.equal(multipart.get(key), upload);
            const token = randomUUID();
            partTokens.set(token, {
                key,
                upload,
                number,
                size,
                checksum,
                expires: Date.now() + 600000,
            });
            return `${objectOrigin}/parts/${key.slice(6)}/${number}?token=${token}`;
        };
        storage.parts = async (key, upload) => {
            record('parts', key);
            if (multipart.get(key) !== upload) return null;
            return await Promise.all(
                [...(parts.get(key)?.values() ?? [])].map(async (part) => {
                    const bytes = await readFile(part.path);
                    const fault = partFaults.get(key + ':' + part.number);
                    return {
                        PartNumber: part.number,
                        ETag: part.etag,
                        Size:
                            bytes.length +
                            (fault?.kind === 'size' ? fault.delta : 0),
                        ChecksumSHA256:
                            fault?.kind === 'checksum'
                                ? fault.value
                                : sha(bytes, 'base64'),
                    };
                }),
            );
        };
        storage.complete = async (key, upload, completed) => {
            record('complete', key);
            assert.equal(multipart.get(key), upload);
            if (completeFaults.get(key) === 'reject')
                throw new Error('Fixture integrity rejection');
            const chunks: Buffer[] = [];
            for (const part of completed) {
                assert(part.PartNumber);
                const entry = parts.get(key)?.get(part.PartNumber);
                assert(entry);
                const bytes = await readFile(entry.path);
                assert.equal(part.ETag, entry.etag);
                assert.equal(part.ChecksumSHA256, sha(bytes, 'base64'));
                chunks.push(bytes);
            }
            let bytes = Buffer.concat(chunks);
            if (completeFaults.get(key) === 'short')
                bytes = bytes.subarray(0, bytes.length - 1);
            await saveObject(key, bytes);
            await clearParts(key);
        };
        storage.empty = async (key) => {
            record('empty', key);
            await saveObject(key, Buffer.alloc(0));
        };
        storage.size = async (key) => {
            record('size', key);
            return (await optionalBytes(filePath(key)))?.length ?? null;
        };
        storage.read = async (key, size) => {
            record('read', key);
            const bytes = await readFile(filePath(key));
            assert.equal(bytes.length, size);
            return bytes;
        };
        storage.abort = async (key) => {
            record('abort', key);
            await clearParts(key);
        };
        storage.remove = async (key) => {
            record('remove', key);
            if (cleanupFaults.has(key))
                throw new Error('Fixture cleanup rejection');
            await rm(filePath(key), { force: true });
            assert.equal(await optionalBytes(filePath(key)), null);
            objects.delete(key);
        };
        function objectUrl(key: string) {
            const token = randomUUID();
            objectTokens.set(token, { key, expires: Date.now() + 300000 });
            return `${objectOrigin}/objects/${key.slice(6)}?token=${token}`;
        }
        storage.download = async (key) => {
            record('download', key);
            return objectUrl(key);
        };
        storage.preview = async (key) => {
            record('preview', key);
            return objectUrl(key);
        };
        async function reopen() {
            await suspend();
            cookie = auth
                .startSession(
                    { headers: {} } as Parameters<typeof auth.startSession>[0],
                    demo,
                )
                .cookie.split(';')[0]!;
            const space = mySpace(dbPath, storage, backend);
            web = await taskEntryServer({
                port: options.port ?? 0,
                origin,
                auth,
                backend,
                space,
            });
        }
        async function request(
            path: string,
            method = 'GET',
            body?: Json,
            key?: string,
        ) {
            assert(web);
            const response = await fetch(web.origin + path, {
                method,
                redirect: 'manual',
                signal: AbortSignal.timeout(5000),
                headers: {
                    Cookie: cookie,
                    Origin: origin,
                    ...(body === undefined
                        ? {}
                        : { 'Content-Type': 'application/json' }),
                    ...(key ? { 'Idempotency-Key': key } : {}),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            const text = await response.text();
            return {
                status: response.status,
                json: text ? (JSON.parse(text) as Json) : null,
                location: response.headers.get('location'),
            };
        }
        const result: SpaceIntegrityFixture = {
            ownerId: demo.ownerId,
            account: 'demo',
            projectId,
            dbPath,
            get apiOrigin() {
                assert(web);
                return web.origin;
            },
            storage,
            objects,
            parts,
            calls,
            request,
            suspend,
            reopen,
            close,
            async putPart(id, number, bytes) {
                const signed = await request(
                    `/api/space/uploads/${id}/part`,
                    'POST',
                    { number },
                );
                assert.equal(signed.status, 200);
                const receipt = jsonObject(signed.json);
                assert(
                    typeof receipt.url === 'string' &&
                        typeof receipt.checksum === 'string',
                );
                const put = await fetch(receipt.url, {
                    method: 'PUT',
                    body: new Uint8Array(bytes),
                    headers: { 'x-amz-checksum-sha256': receipt.checksum },
                    signal: AbortSignal.timeout(5000),
                });
                await put.body?.cancel();
                assert([200, 204].includes(put.status));
            },
            async download(id) {
                const signed = await request(`/api/space/files/${id}/download`);
                assert.equal(signed.status, 302);
                assert(signed.location);
                const read = await fetch(signed.location, {
                    signal: AbortSignal.timeout(5000),
                });
                assert.equal(read.status, 200);
                return Buffer.from(await read.arrayBuffer());
            },
            readObject: (id) => optionalBytes(filePath(spaceObjectKey(id))),
            readPart: (id, number) =>
                optionalBytes(partPath(spaceObjectKey(id), number)),
            setPartFault(id, number, fault) {
                const key = spaceObjectKey(id) + ':' + number;
                if (fault === null) partFaults.delete(key);
                else partFaults.set(key, fault);
            },
            setCompleteFault(id, fault) {
                const key = spaceObjectKey(id);
                if (fault === null) completeFaults.delete(key);
                else completeFaults.set(key, fault);
            },
            setCleanupFault(id, fault) {
                const key = spaceObjectKey(id);
                if (fault === null) cleanupFaults.delete(key);
                else cleanupFaults.add(key);
            },
            rows(table) {
                assert(
                    [
                        'space_projects',
                        'space_uploads',
                        'space_file_deletions',
                        'space_project_deletions',
                        'space_tasks',
                        'space_task_inputs',
                    ].includes(table),
                );
                const db = new DatabaseSync(dbPath, { readOnly: true });
                try {
                    return db
                        .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
                        .all();
                } finally {
                    db.close();
                }
            },
        };
        await reopen();
        const created = await request('/api/space/projects', 'POST', {
            id: projectId,
            name: 'Integrity fixture',
        });
        assert.equal(created.status, 200);
        return result;
    } catch (error) {
        await close();
        throw error;
    }
}
