import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
    openSpaceIntegrityFixture,
    type SpaceIntegrityFixture,
} from './space-integrity-fixture.ts';

const chunks = [Buffer.alloc(16777216, 1), Buffer.alloc(3, 2)];
const total = 16777219;
const sha = (bytes: Buffer) =>
    createHash('sha256').update(bytes).digest('base64');
function object(value: unknown): Record<string, unknown> {
    assert(
        value !== null && typeof value === 'object' && !Array.isArray(value),
    );
    return value as Record<string, unknown>;
}
async function waitFor(check: () => Promise<boolean>) {
    const start = performance.now();
    while (!(await check())) {
        if (performance.now() - start >= 5000)
            assert.fail('Fixture state deadline exceeded');
        await delay(20);
    }
}
function integrityClock(t: TestContext) {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1800000000000 });
    return {
        async sweep() {
            t.mock.timers.tick(30000);
            await new Promise<void>((resolve) => setImmediate(resolve));
        },
        expireSignature(f: SpaceIntegrityFixture, id: string) {
            const row = f.rows('space_uploads').find((row) => row.id === id);
            assert(row && typeof row.signedUntil === 'number');
            t.mock.timers.setTime(row.signedUntil + 1);
        },
    };
}
async function begin(f: SpaceIntegrityFixture) {
    const id = randomUUID();
    const response = await f.request(
        `/api/space/projects/${f.projectId}/uploads`,
        'POST',
        {
            id,
            path: 'nested/object.bin',
            size: total,
            checksums: chunks.map(sha),
        },
    );
    assert.equal(response.status, 200);
    return id;
}
const complete = (f: SpaceIntegrityFixture, id: string) =>
    f.request(`/api/space/uploads/${id}/complete`, 'POST', {});
async function hidden(
    f: SpaceIntegrityFixture,
    id: string,
    state: string,
    reserved = total,
    expectedParts: number[] = [],
) {
    const upload = await f.request('/api/space/uploads/' + id);
    assert.equal(upload.status, 200);
    assert.equal(object(upload.json).state, state);
    assert.deepEqual(object(upload.json).parts, expectedParts);
    assert.equal(
        f.rows('space_uploads').find((row) => row.id === id)?.state,
        state,
    );
    const tree = await f.request('/api/space/projects/' + f.projectId);
    assert.deepEqual(object(tree.json).files, []);
    const summary = await f.request('/api/space');
    assert.equal(object(summary.json).saved, 0);
    assert.equal(object(summary.json).reserved, reserved);
    const download = await f.request(`/api/space/files/${id}/download`);
    assert.equal(download.status, 404);
    assert.equal(object(object(download.json).error).code, 'not_found');
}
async function saved(f: SpaceIntegrityFixture, id: string) {
    assert.equal((await complete(f, id)).status, 200);
    const bytes = Buffer.concat(chunks);
    assert.deepEqual(await f.readObject(id), bytes);
    const download = await f.download(id);
    assert.equal(sha(download), sha(bytes));
    const summary = await f.request('/api/space');
    assert.equal(object(summary.json).saved, total);
    assert.equal(object(summary.json).reserved, 0);
    assert.equal(f.rows('space_uploads').length, 1);
    const calls = f.calls.length;
    assert.equal((await complete(f, id)).status, 200);
    assert.equal(f.calls.length, calls);
}
for (const kind of [
    'missing',
    'part size',
    'checksum',
    'Complete rejected',
] as const) {
    test(
        `WEB-02-08 ${kind}: physical parts remain hidden until valid completion`,
        { timeout: 20000 },
        async () => {
            const f = await openSpaceIntegrityFixture();
            try {
                const id = await begin(f);
                await f.putPart(id, 2, chunks[1]!);
                if (kind !== 'missing') await f.putPart(id, 1, chunks[0]!);
                if (kind === 'part size')
                    f.setPartFault(id, 1, { kind: 'size', delta: -1 });
                if (kind === 'checksum')
                    f.setPartFault(id, 1, {
                        kind: 'checksum',
                        value: sha(Buffer.from('wrong')),
                    });
                if (kind === 'Complete rejected')
                    f.setCompleteFault(id, 'reject');
                const rejected = await complete(f, id);
                assert.equal(
                    rejected.status,
                    kind === 'Complete rejected' ? 500 : 409,
                );
                assert.equal(
                    object(object(rejected.json).error).code,
                    kind === 'Complete rejected'
                        ? 'server_error'
                        : 'space_conflict',
                );
                await hidden(
                    f,
                    id,
                    kind === 'Complete rejected' ? 'completing' : 'uploading',
                    total,
                    kind === 'Complete rejected' ? [] : [2],
                );
                assert.equal(await f.readObject(id), null);
                assert.deepEqual(await f.readPart(id, 2), chunks[1]);
                assert.equal(
                    f.calls.filter((call) => call.op === 'complete').length,
                    kind === 'Complete rejected' ? 1 : 0,
                );
                await f.reopen();
                await hidden(
                    f,
                    id,
                    kind === 'Complete rejected' ? 'completing' : 'uploading',
                    total,
                    kind === 'Complete rejected' ? [] : [2],
                );
                if (kind === 'missing') await f.putPart(id, 1, chunks[0]!);
                else
                    assert.equal(
                        sha((await f.readPart(id, 1))!),
                        sha(chunks[0]!),
                    );
                f.setPartFault(id, 1, null);
                f.setCompleteFault(id, null);
                if (kind !== 'Complete rejected') {
                    const progress = await f.request(
                        '/api/space/uploads/' + id,
                    );
                    assert.deepEqual(object(progress.json).parts, [1, 2]);
                }
                await saved(f, id);
            } finally {
                await f.close();
            }
        },
    );
}

test(
    'WEB-02-08 wrong object size preserves reservation until physical cleanup confirms',
    { timeout: 20000 },
    async (t) => {
        const clock = integrityClock(t);
        const f = await openSpaceIntegrityFixture();
        try {
            const id = await begin(f);
            for (const [index, chunk] of chunks.entries())
                await f.putPart(id, index + 1, chunk);
            f.setCompleteFault(id, 'short');
            assert.equal((await complete(f, id)).status, 409);
            await hidden(f, id, 'cleaning');
            assert.equal(f.rows('space_uploads')[0]?.cleanup, 'failed');
            assert.equal((await f.readObject(id))?.length, total - 1);
            assert.equal(await f.readPart(id, 1), null);
            assert.equal(await f.readPart(id, 2), null);
            await clock.sweep();
            await hidden(f, id, 'cleaning');
            assert.equal(
                f.calls.filter((call) => call.op === 'remove').length,
                0,
            );
            f.setCleanupFault(id, 'remove-reject');
            clock.expireSignature(f, id);
            await clock.sweep();
            await waitFor(async () =>
                f.calls.some((call) => call.op === 'remove'),
            );
            await hidden(f, id, 'cleaning');
            assert.equal((await f.readObject(id))?.length, total - 1);
            f.setCleanupFault(id, null);
            await clock.sweep();
            await waitFor(
                async () => f.rows('space_uploads')[0]?.state === 'failed',
            );
            await hidden(f, id, 'failed', 0);
            assert.equal(await f.readObject(id), null);
            assert.equal(await f.readPart(id, 1), null);
            f.setCompleteFault(id, null);
            await f.reopen();
            await hidden(f, id, 'failed', 0);
            assert.equal((await complete(f, id)).status, 409);
            await hidden(f, id, 'failed', 0);
        } finally {
            await f.close();
        }
    },
);
