import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { spaceObjectKey, spaceStorage } from '../space-storage.ts';
import {
    recoveryDownload,
    spaceFixtureOrigin,
    openSpaceHttpFixture,
    assertUploadError,
    recoveryClock,
    recoveryBarrier,
} from './fixtures/space-upload.ts';

const recoveryBytes = 16777219;
const recoveryPath = 'nested/fixture.bin';

type UploadRecoveryFixture = Awaited<
    ReturnType<typeof openUploadRecoveryFixture>
>;

async function openUploadRecoveryFixture() {
    const id = randomUUID();
    const project = randomUUID();
    const projectUrl = '/api/space/projects/' + project;
    const uploadUrl = '/api/space/uploads/' + id;
    const objectKey = spaceObjectKey(id);
    const storageId = 'fixture-multipart';
    const chunks = [Buffer.alloc(16777216, 1), Buffer.alloc(3, 2)];
    const digest = (bytes: Buffer) =>
        createHash('sha256').update(bytes).digest('base64');
    const checksums = chunks.map(digest);
    const signatures = new Map<
        string,
        { number: number; size: number; checksum: string }
    >();
    const parts = new Map<
        number,
        {
            PartNumber: number;
            Size: number;
            ETag: string;
            ChecksumSHA256: string;
        }
    >();
    const calls: unknown[][] = [];
    const stored = { active: false, size: null as number | null, writes: 0 };
    const storage = spaceStorage(spaceFixtureOrigin, 'fixture', 'us-east-1');
    function record(operation: string, key: string, ...args: unknown[]) {
        assert.equal(key, objectKey);
        calls.push([operation, key, ...args]);
    }
    storage.create = async (key) => {
        record('create', key);
        assert.equal(stored.active, false);
        stored.active = true;
        return storageId;
    };
    storage.signPart = async (key, upload, number, size, checksum) => {
        record('signPart', key, upload, number, size, checksum);
        assert.equal(upload, storageId);
        assert(stored.active);
        assert.equal(size, chunks[number - 1]?.length);
        assert.equal(checksum, checksums[number - 1]);
        const url = `https://fixture.invalid/${key}?uploadId=${upload}&partNumber=${number}`;
        signatures.set(url, { number, size, checksum });
        return url;
    };
    function putPart(url: string, bytes: Buffer, checksum: string): void {
        const signature = signatures.get(url);
        assert(signature && stored.active);
        assert.equal(signature.size, bytes.length);
        assert.equal(signature.checksum, checksum);
        assert.equal(digest(bytes), checksum);
        parts.set(signature.number, {
            PartNumber: signature.number,
            Size: bytes.length,
            ETag: `"part-${signature.number}"`,
            ChecksumSHA256: checksum,
        });
    }
    storage.parts = async (key, upload) => {
        record('parts', key, upload);
        assert.equal(upload, storageId);
        return stored.active
            ? [...parts.values()].sort((a, b) => b.PartNumber - a.PartNumber)
            : null;
    };
    storage.complete = async (key, upload, completed) => {
        record('complete', key, upload, completed);
        assert.equal(upload, storageId);
        assert(stored.active);
        assert.equal(stored.writes, 0);
        assert.deepEqual(
            completed,
            [1, 2].map((number) => {
                const part = parts.get(number);
                assert(part);
                const { PartNumber, ETag, ChecksumSHA256 } = part;
                return { PartNumber, ETag, ChecksumSHA256 };
            }),
        );
        stored.active = false;
        parts.clear();
        stored.size = recoveryBytes;
        stored.writes++;
    };
    storage.size = async (key) => {
        record('size', key);
        return stored.size;
    };
    storage.abort = async (key, upload) => {
        record('abort', key, upload);
        if (upload !== undefined) assert.equal(upload, storageId);
        stored.active = false;
        parts.clear();
    };
    storage.remove = async (key) => {
        record('remove', key);
        stored.size = null;
    };
    storage.download = async (key, name) => {
        record('download', key, name);
        assert.notEqual(stored.size, null);
        return recoveryDownload;
    };
    storage.empty =
        storage.read =
        storage.preview =
            async () => {
                assert.fail('Unexpected storage call');
            };

    const { dbPath, request, reopen, close, dispose } =
        await openSpaceHttpFixture(storage, 'bento-upload-recovery-');
    function row() {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
            const rows = db
                .prepare(
                    'SELECT state, storageId, signedUntil, cleanup FROM space_uploads WHERE id=?',
                )
                .all(id);
            assert.equal(rows.length, 1);
            const row = rows[0];
            assert(row);
            assert.equal(row.storageId, storageId);
            return row;
        } finally {
            db.close();
        }
    }
    async function sendPart(number: number) {
        const before = Date.now();
        const response = await request(uploadUrl + '/part', 'POST', { number });
        assert.equal(response.status, 200);
        const bytes = chunks[number - 1];
        assert(bytes);
        putPart(response.json.url, bytes, response.json.checksum);
        const signedUntil = row().signedUntil;
        assert(typeof signedUntil === 'number');
        assert(
            signedUntil >= before + 605000 &&
                signedUntil <= Date.now() + 605000,
        );
    }
    async function view(state: string, expectedParts: number[]) {
        const response = await request(uploadUrl);
        assert.equal(response.status, 200);
        assert.equal(response.json.id, id);
        assert.equal(response.json.state, state);
        assert.deepEqual(response.json.parts, expectedParts);
        assert.equal(row().state, state);
        return response.json;
    }
    async function projection(saved: number, reserved: number) {
        const usage = await request('/api/space');
        assert.equal(usage.status, 200);
        assert.equal(usage.json.saved, saved);
        assert.equal(usage.json.reserved, reserved);
        const detail = await request(projectUrl);
        assert.equal(detail.status, 200);
        assert.deepEqual(
            detail.json.files,
            saved ? [{ id, path: recoveryPath, size: recoveryBytes }] : [],
        );
        const download = await request('/api/space/files/' + id + '/download');
        assert.equal(download.status, saved ? 302 : 404);
        assert.equal(download.location, saved ? recoveryDownload : null);
        if (!saved) assert.equal(download.json.error.code, 'not_found');
    }
    async function savedOnce() {
        await view('saved', []);
        await projection(recoveryBytes, 0);
        assert.deepEqual(stored, {
            active: false,
            size: recoveryBytes,
            writes: 1,
        });
    }
    const complete = (signal?: AbortSignal) =>
        request(uploadUrl + '/complete', 'POST', {}, signal);
    try {
        await reopen();
        assert.equal(
            (
                await request('/api/space/projects', 'POST', {
                    id: project,
                    name: 'Fixture',
                })
            ).status,
            200,
        );
        const started = await request(projectUrl + '/uploads', 'POST', {
            id,
            path: recoveryPath,
            size: recoveryBytes,
            checksums,
        });
        assert.equal(started.status, 200);
        assert.equal(started.json.state, 'uploading');
        assert.equal(started.json.id, id);
        assert(
            Number.isInteger(started.json.expires) &&
                started.json.expires > Date.now(),
        );
        return {
            storage,
            stored,
            calls,
            parts,
            request,
            projectUrl,
            uploadUrl,
            row,
            sendPart,
            view,
            projection,
            savedOnce,
            complete,
            close,
            reopen,
            dispose,
        };
    } catch (error) {
        await dispose();
        throw error;
    }
}

async function withUploadRecoveryFixture(
    t: TestContext,
    run: (fixture: UploadRecoveryFixture) => Promise<void>,
): Promise<void> {
    t.signal.throwIfAborted();
    const fixture = await openUploadRecoveryFixture();
    try {
        await run(fixture);
    } finally {
        await fixture.dispose();
    }
}

test(
    'WEB-A04 missing multipart parts recover',
    { timeout: 20000 },
    async (t) => {
        await withUploadRecoveryFixture(t, async (f) => {
            await f.sendPart(2);
            await f.view('uploading', [2]);
            await f.projection(0, recoveryBytes);
            assertUploadError(await f.complete(), 409, 'space_conflict');
            await f.view('uploading', [2]);
            assert(!f.calls.some(([operation]) => operation === 'complete'));
            await f.projection(0, recoveryBytes);
            await f.sendPart(1);
            const first = f.parts.get(1);
            assert(first);
            first.Size--;
            await f.view('uploading', [2]);
            assertUploadError(await f.complete(), 409, 'space_conflict');
            assert(!f.calls.some(([operation]) => operation === 'complete'));
            first.Size++;
            await f.view('uploading', [1, 2]);
            assert.equal((await f.complete()).status, 200);
            await f.savedOnce();
        });
    },
);

async function uploadRecoveryParts(f: UploadRecoveryFixture) {
    await f.sendPart(1);
    await f.sendPart(2);
}

const recoveryCallCount = (f: UploadRecoveryFixture, operation: string) =>
    f.calls.filter(([name]) => name === operation).length;

async function assertRecoveryGate(f: UploadRecoveryFixture, pending: boolean) {
    const result = await f.request(f.projectUrl + '/deletion');
    assert.equal(result.status, 200);
    assert.equal(result.json.uploadCount, pending ? 1 : 0);
    assert.deepEqual(result.json.blockers, pending ? ['upload_pending'] : []);
    if (pending) {
        assert.equal(result.json.fileCount, 0);
        assertUploadError(
            await f.request(f.projectUrl, 'DELETE'),
            409,
            'upload_pending',
        );
    }
}

test(
    'WEB-A04 wrong object size stays hidden',
    { timeout: 20000 },
    async (t) => {
        const clock = recoveryClock(t);
        await withUploadRecoveryFixture(t, async (f) => {
            await uploadRecoveryParts(f);
            const complete = f.storage.complete;
            f.storage.complete = async (...args) => {
                await complete(...args);
                f.stored.size = recoveryBytes - 1;
            };
            assertUploadError(await f.complete(), 409, 'space_conflict');
            await f.view('cleaning', []);
            assert.equal(f.row().cleanup, 'failed');
            assert.equal(recoveryCallCount(f, 'complete'), 1);
            await f.projection(0, recoveryBytes);
            await assertRecoveryGate(f, true);
            await clock.sweep();
            assert.equal(recoveryCallCount(f, 'abort'), 1); // Preparation only.
            assert.equal(recoveryCallCount(f, 'remove'), 0);
            await f.projection(0, recoveryBytes);
            clock.expireSignature(f);
            await clock.sweep();
            await f.view('failed', []);
            assert.equal(f.stored.active, false);
            assert.equal(f.stored.size, null);
            assert.equal(recoveryCallCount(f, 'remove'), 1);
            await f.projection(0, 0);
            await assertRecoveryGate(f, false);
            const cancel = await f.request(f.uploadUrl + '/cancel', 'POST', {});
            assert.equal(cancel.status, 200);
            assert.equal(cancel.json.state, 'failed');
            assertUploadError(await f.complete(), 409, 'space_conflict');
            await f.projection(0, 0);
        });
    },
);

const lostRecoveryReceipt = () =>
    new Error('Fixture lost storage completion receipt');

test(
    'WEB-A04 lost storage completion receipt replays',
    { timeout: 20000 },
    async (t) => {
        await withUploadRecoveryFixture(t, async (f) => {
            await uploadRecoveryParts(f);
            const complete = f.storage.complete;
            f.storage.complete = async (...args) => {
                await complete(...args);
                throw lostRecoveryReceipt();
            };
            assertUploadError(await f.complete(), 500, 'server_error');
            await f.view('completing', []);
            await f.projection(0, recoveryBytes);
            await assertRecoveryGate(f, true);
            const start = f.calls.length;
            const first = await f.complete();
            assert.equal(first.status, 200);
            assert.deepEqual(
                f.calls.slice(start).map(([name]) => name),
                ['size'],
            );
            const second = await f.complete();
            assert.equal(second.status, 200);
            assert.deepEqual(second.json, first.json);
            assert.equal(f.calls.length, start + 1);
            await f.savedOnce();
        });
        await withUploadRecoveryFixture(t, async (f) => {
            await uploadRecoveryParts(f);
            const barrier = recoveryBarrier();
            const complete = f.storage.complete;
            f.storage.complete = async (...args) => {
                await complete(...args);
                await barrier.pause();
            };
            const controller = new AbortController();
            const aborted = assert.rejects(f.complete(controller.signal), {
                name: 'AbortError',
            });
            void aborted.catch(() => {});
            try {
                await barrier.waitForEntry();
                assert.equal(f.row().state, 'completing');
                controller.abort();
                await aborted;
                barrier.release();
                const deadline = Date.now() + 5000;
                let read = await f.request(f.uploadUrl);
                while (read.json.state !== 'saved' && Date.now() < deadline) {
                    await delay(20);
                    read = await f.request(f.uploadUrl);
                }
                assert.equal(read.status, 200);
                assert.equal(read.json.state, 'saved');
                assert.equal(f.row().state, 'saved');
                const { parts, ...upload } = read.json;
                assert.deepEqual(parts, []);
                const start = f.calls.length;
                const retry = await f.complete();
                assert.equal(retry.status, 200);
                assert.deepEqual(retry.json, upload);
                assert.equal(f.calls.length, start);
                await f.savedOnce();
            } finally {
                controller.abort();
                barrier.release();
                await Promise.allSettled([aborted]);
            }
        });
    },
);

test(
    'WEB-A04 pending completion survives reopen',
    { timeout: 20000 },
    async (t) => {
        const clock = recoveryClock(t);
        await withUploadRecoveryFixture(t, async (f) => {
            await uploadRecoveryParts(f);
            const barrier = recoveryBarrier();
            const complete = f.storage.complete;
            f.storage.complete = async (...args) => {
                await complete(...args);
                await barrier.pause();
                throw lostRecoveryReceipt();
            };
            const controller = new AbortController();
            const aborted = assert.rejects(f.complete(controller.signal), {
                name: 'AbortError',
            });
            void aborted.catch(() => {});
            try {
                await barrier.waitForEntry();
                controller.abort();
                await aborted;
            } finally {
                controller.abort();
                barrier.release();
                await Promise.allSettled([aborted]);
            }
            await f.close();
            assert.equal(f.row().state, 'completing');
            const start = f.calls.length;
            await f.reopen();
            await f.view('completing', []);
            await f.projection(0, recoveryBytes);
            await clock.sweep();
            const { parts, ...upload } = await f.view('saved', []);
            assert.deepEqual(parts, []);
            const retry = await f.complete();
            assert.equal(retry.status, 200);
            assert.deepEqual(retry.json, upload);
            assert.deepEqual(
                f.calls.slice(start).map(([name]) => name),
                ['size'],
            );
            await f.savedOnce();
        });
    },
);

const cancelRecovery = (f: UploadRecoveryFixture) =>
    f.request(f.uploadUrl + '/cancel', 'POST', {});

test('WEB-A04 complete wins over cancel', { timeout: 20000 }, async (t) => {
    await withUploadRecoveryFixture(t, async (f) => {
        await uploadRecoveryParts(f);
        const barrier = recoveryBarrier();
        const complete = f.storage.complete;
        f.storage.complete = async (...args) => {
            await barrier.pause();
            await complete(...args);
        };
        const pending = f.complete();
        void pending.catch(() => {});
        try {
            await barrier.waitForEntry();
            await f.view('completing', []);
            await f.projection(0, recoveryBytes);
            await assertRecoveryGate(f, true);
            assertUploadError(await cancelRecovery(f), 409, 'space_conflict');
            assert.equal(f.stored.size, null);
            assert.equal(recoveryCallCount(f, 'abort'), 1);
            assert.equal(recoveryCallCount(f, 'remove'), 0);
            barrier.release();
            assert.equal((await pending).status, 200);
            await f.savedOnce();
            assert.equal(recoveryCallCount(f, 'abort'), 1);
            assert.equal(recoveryCallCount(f, 'remove'), 0);
            await assertRecoveryGate(f, false);
            assertUploadError(await cancelRecovery(f), 409, 'space_conflict');
            await f.savedOnce();
        } finally {
            barrier.release();
            await Promise.allSettled([pending]);
        }
    });
});

test('WEB-A04 cancel wins over complete', { timeout: 20000 }, async (t) => {
    const clock = recoveryClock(t);
    await withUploadRecoveryFixture(t, async (f) => {
        await uploadRecoveryParts(f);
        const initial = await cancelRecovery(f);
        assert.equal(initial.status, 200);
        assert.equal(initial.json.state, 'cleaning');
        await f.view('cleaning', []);
        assert.equal(f.row().cleanup, 'cancelled');
        await f.projection(0, recoveryBytes);
        await assertRecoveryGate(f, true);
        assert.equal(recoveryCallCount(f, 'abort'), 1);
        clock.expireSignature(f);
        const barrier = recoveryBarrier();
        const abort = f.storage.abort;
        f.storage.abort = async (...args) => {
            await barrier.pause();
            await abort(...args);
        };
        const pending = cancelRecovery(f);
        void pending.catch(() => {});
        try {
            await barrier.waitForEntry();
            assertUploadError(await f.complete(), 409, 'space_conflict');
            await f.projection(0, recoveryBytes);
            assert.equal(recoveryCallCount(f, 'complete'), 0);
            assert.equal(f.stored.active, true);
            barrier.release();
            const cancelled = await pending;
            assert.equal(cancelled.status, 200);
            assert.equal(cancelled.json.state, 'cancelled');
            await f.view('cancelled', []);
            assert.deepEqual(f.stored, {
                active: false,
                size: null,
                writes: 0,
            });
            assert.equal(recoveryCallCount(f, 'abort'), 2);
            await f.projection(0, 0);
            await assertRecoveryGate(f, false);
            const start = f.calls.length;
            assertUploadError(await f.complete(), 409, 'space_conflict');
            const repeated = await cancelRecovery(f);
            assert.equal(repeated.status, 200);
            assert.equal(repeated.json.state, 'cancelled');
            await f.projection(0, 0);
            assert.equal(f.calls.length, start);
        } finally {
            barrier.release();
            await Promise.allSettled([pending]);
        }
    });
});
