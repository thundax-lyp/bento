import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { spaceObjectKey, spaceStorage } from '../src/space/storage.ts';
import {
    recoveryDownload,
    spaceFixtureOrigin,
    openSpaceHttpFixture,
    assertUploadError,
    recoveryClock,
    recoveryBarrier,
} from './fixtures/space-upload.ts';

const quotaPartSize = 16_777_216;
const fileLimit = 100_000_000;
const halfFile = 50_000_000;
const accountQuota = 200_000_000;

type QuotaInput = {
    id: string;
    path: string;
    size: number;
    checksums: string[];
};
type QuotaActor = 'a' | 'b';
type QuotaPart = {
    PartNumber: number;
    Size: number;
    ETag: string;
    ChecksumSHA256: string;
};

function quotaInput(path: string, size: number): QuotaInput {
    return {
        id: randomUUID(),
        path,
        size,
        checksums: Array.from(
            { length: Math.ceil(size / quotaPartSize) },
            (_, i) =>
                createHash('sha256')
                    .update('quota-fixture:' + (i + 1))
                    .digest('base64'),
        ),
    };
}

async function openQuotaFixture() {
    const storage = spaceStorage(spaceFixtureOrigin, 'fixture', 'us-east-1');
    const objects = new Map<
        string,
        {
            input: QuotaInput;
            storageId: string;
            active: boolean;
            parts: Map<number, QuotaPart>;
            signatures: Map<
                number,
                { url: string; size: number; checksum: string }
            >;
            size: number | null;
            writes: number;
            calls: string[];
        }
    >();
    function object(key: string) {
        const entry = objects.get(key);
        assert(entry, 'unexpected storage key: ' + key);
        return entry;
    }
    function register(path: string, size: number) {
        const input = quotaInput(path, size);
        objects.set(spaceObjectKey(input.id), {
            input,
            storageId: 'fixture-' + input.id,
            active: false,
            parts: new Map(),
            signatures: new Map(),
            size: null,
            writes: 0,
            calls: [],
        });
        return input;
    }
    const hooks: {
        abort?: (key: string, upload?: string) => Promise<void>;
        remove?: (key: string) => Promise<void>;
    } = {};
    storage.create = async (key) => {
        const entry = object(key);
        entry.calls.push('create');
        assert.equal(entry.active, false);
        entry.active = true;
        return entry.storageId;
    };
    storage.signPart = async (key, upload, n, size, checksum) => {
        const entry = object(key);
        entry.calls.push('signPart');
        assert(entry.active);
        assert.equal(upload, entry.storageId);
        assert.equal(
            size,
            Math.min(quotaPartSize, entry.input.size - (n - 1) * quotaPartSize),
        );
        assert.equal(checksum, entry.input.checksums[n - 1]);
        const url = `https://fixture.invalid/${key}?partNumber=${n}`;
        entry.signatures.set(n, { url, size, checksum });
        return url;
    };
    function acceptQuotaPart(
        input: QuotaInput,
        n: number,
        url: string,
        checksum: string,
    ): void {
        const entry = object(spaceObjectKey(input.id));
        const signature = entry.signatures.get(n);
        assert(signature && entry.active);
        assert.equal(url, signature.url);
        assert.equal(checksum, signature.checksum);
        entry.parts.set(n, {
            PartNumber: n,
            Size: signature.size,
            ETag: `"part-${n}"`,
            ChecksumSHA256: checksum,
        });
    }
    storage.parts = async (key, upload) => {
        const entry = object(key);
        entry.calls.push('parts');
        assert.equal(upload, entry.storageId);
        return entry.active ? [...entry.parts.values()].reverse() : null;
    };
    storage.complete = async (key, upload, completed) => {
        const entry = object(key);
        entry.calls.push('complete');
        assert(entry.active);
        assert.equal(upload, entry.storageId);
        assert.equal(entry.writes, 0);
        let bytes = 0;
        const expected = entry.input.checksums.map((_, index) => {
            const part = entry.parts.get(index + 1);
            assert(part);
            const { PartNumber, Size, ETag, ChecksumSHA256 } = part;
            bytes += Size;
            return { PartNumber, ETag, ChecksumSHA256 };
        });
        assert.deepEqual(completed, expected);
        entry.size = bytes;
        entry.parts.clear();
        entry.active = false;
        entry.writes++;
    };
    storage.size = async (key) => {
        const entry = object(key);
        entry.calls.push('size');
        return entry.size;
    };
    storage.abort = async (key, upload) => {
        const entry = object(key);
        entry.calls.push(upload === undefined ? 'abort-orphan' : 'abort');
        await hooks.abort?.(key, upload);
        if (upload !== undefined) assert.equal(upload, entry.storageId);
        entry.parts.clear();
        entry.active = false;
        entry.calls.push(
            upload === undefined ? 'abort-orphan-confirmed' : 'abort-confirmed',
        );
    };
    storage.remove = async (key) => {
        const entry = object(key);
        entry.calls.push('remove');
        await hooks.remove?.(key);
        entry.size = null;
        entry.calls.push('remove-confirmed');
    };
    storage.download = async (key) => {
        const entry = object(key);
        entry.calls.push('download');
        assert.notEqual(entry.size, null);
        return recoveryDownload;
    };
    storage.empty =
        storage.read =
        storage.preview =
            async () => {
                assert.fail('Unexpected storage call');
            };

    const http = await openSpaceHttpFixture(storage, 'bento-upload-quota-');
    const projects = { a: randomUUID(), b: randomUUID() };
    const projectUrl = (actor: QuotaActor) =>
        '/api/space/projects/' + projects[actor];
    const uploadUrl = (input: QuotaInput) => '/api/space/uploads/' + input.id;
    const fileUrl = (input: QuotaInput) => '/api/space/files/' + input.id;
    const start = (
        input: QuotaInput,
        actor: QuotaActor = 'a',
        project: QuotaActor = actor,
    ) =>
        http.request(
            projectUrl(project) + '/uploads',
            'POST',
            input,
            undefined,
            actor,
        );
    const complete = (input: QuotaInput) =>
        http.request(uploadUrl(input) + '/complete', 'POST', {});
    async function sendPart(input: QuotaInput, n: number) {
        const result = await http.request(uploadUrl(input) + '/part', 'POST', {
            number: n,
        });
        assert.equal(result.status, 200);
        acceptQuotaPart(input, n, result.json.url, result.json.checksum);
    }
    function rows(query: string, ...values: string[]) {
        const db = new DatabaseSync(http.dbPath, { readOnly: true });
        try {
            return db.prepare(query).all(...values);
        } finally {
            db.close();
        }
    }
    const uploadRows = (input: QuotaInput) =>
        rows('SELECT * FROM space_uploads WHERE id=?', input.id);
    function state(
        input: QuotaInput,
        expected: string,
        actor: QuotaActor = 'a',
    ) {
        const result = uploadRows(input);
        assert.equal(result.length, 1);
        const row = result[0]!;
        assert.equal(row.id, input.id);
        assert.equal(row.owner, 'owner-' + actor);
        assert.equal(row.project, projects[actor]);
        assert.equal(row.path, input.path);
        assert.equal(row.size, input.size);
        assert.equal(row.manifest, JSON.stringify(input.checksums));
        assert.equal(row.state, expected);
        return row;
    }
    function assertUpload(
        response: Awaited<ReturnType<typeof start>>,
        input: QuotaInput,
        expected: string,
        actor: QuotaActor = 'a',
    ) {
        assert.equal(response.status, 200);
        const row = state(input, expected, actor);
        assert(typeof row.expires === 'number');
        assert(Number.isInteger(row.expires));
        assert.deepEqual(response.json, {
            id: input.id,
            project: projects[actor],
            path: input.path,
            size: input.size,
            state: expected,
            expires: row.expires,
        });
        return response.json;
    }
    async function begin(input: QuotaInput, actor: QuotaActor = 'a') {
        const before = Date.now();
        const result = assertUpload(
            await start(input, actor),
            input,
            'uploading',
            actor,
        );
        assert(
            result.expires >= before + 86_400_000 &&
                result.expires <= Date.now() + 86_400_000,
        );
        return result;
    }
    async function save(input: QuotaInput) {
        for (let n = 1; n <= input.checksums.length; n++)
            await sendPart(input, n);
        const result = assertUpload(await complete(input), input, 'saved');
        const entry = object(spaceObjectKey(input.id));
        assert.equal(entry.size, input.size);
        assert.equal(entry.writes, 1);
        return result;
    }
    async function usage(
        saved: number,
        reserved: number,
        actor: QuotaActor = 'a',
    ) {
        const response = await http.request(
            '/api/space',
            'GET',
            undefined,
            undefined,
            actor,
        );
        assert.equal(response.status, 200);
        const view = response.json;
        assert.equal(view.quota, accountQuota);
        assert.equal(view.fileLimit, fileLimit);
        assert.equal(view.partSize, quotaPartSize);
        assert.equal(view.saved, saved);
        assert.equal(view.reserved, reserved);
        const accountRows = rows(
            'SELECT state,size FROM space_uploads WHERE owner=?',
            'owner-' + actor,
        );
        const total = (states: string[]) =>
            accountRows.reduce(
                (sum, row) =>
                    states.includes(String(row.state))
                        ? sum + Number(row.size)
                        : sum,
                0,
            );
        assert.equal(total(['saved', 'deleting']), saved);
        assert.equal(
            total(['preparing', 'uploading', 'completing', 'cleaning']),
            reserved,
        );
        assert(saved + reserved <= accountQuota);
        return view;
    }
    function noEffects(input: QuotaInput) {
        assert.deepEqual(uploadRows(input), []);
        assert.deepEqual(object(spaceObjectKey(input.id)).calls, []);
    }
    try {
        await http.reopen();
        for (const actor of ['a', 'b'] as const) {
            const response = await http.request(
                '/api/space/projects',
                'POST',
                { id: projects[actor], name: 'Quota ' + actor.toUpperCase() },
                undefined,
                actor,
            );
            assert.equal(response.status, 200);
            assert.deepEqual(response.json, { id: projects[actor] });
        }
    } catch (error) {
        await http.dispose();
        throw error;
    }
    return {
        ...http,
        projects,
        projectUrl,
        uploadUrl,
        fileUrl,
        register,
        object,
        hooks,
        start,
        complete,
        begin,
        save,
        usage,
        state,
        assertUpload,
        noEffects,
        sendPart,
        rows,
    };
}

test(
    'WEB-A03 exact limits and owner isolation',
    { timeout: 20000 },
    async () => {
        const f = await openQuotaFixture();
        try {
            const a = f.register('a.bin', fileLimit);
            const b = f.register('b.bin', fileLimit);
            const oversize = f.register('oversize.bin', fileLimit + 1);
            const one = f.register('one.bin', 1);
            const other = f.register('b-owner.bin', 1);
            const foreign = f.register('foreign.bin', 1);
            assertUploadError(await f.start(oversize), 413, 'file_limit');
            f.noEffects(oversize);
            const first = await f.begin(a);
            await f.usage(0, fileLimit);
            const objectA = f.object(spaceObjectKey(a.id));
            const startCalls = [...objectA.calls];
            assert.deepEqual(
                f.assertUpload(await f.start(a), a, 'uploading'),
                first,
            );
            assertUploadError(
                await f.start({ ...a, path: 'different.bin' }),
                409,
                'space_conflict',
            );
            assert.deepEqual(objectA.calls, startCalls);
            await f.usage(0, fileLimit);
            const saved = await f.save(a);
            await f.usage(fileLimit, 0);
            await f.begin(b);
            await f.usage(fileLimit, fileLimit);
            await f.save(b);
            await f.usage(2 * fileLimit, 0);
            await f.usage(accountQuota, 0);
            const detail = await f.request(f.projectUrl('a'));
            assert.equal(detail.status, 200);
            assert.deepEqual(
                detail.json.files,
                [a, b]
                    .sort((left, right) => left.id.localeCompare(right.id))
                    .map(({ id, path, size }) => ({ id, path, size })),
            );
            const savedCalls = [...objectA.calls];
            assert.deepEqual(
                f.assertUpload(await f.start(a), a, 'saved'),
                saved,
            );
            assert.deepEqual(
                f.assertUpload(await f.complete(a), a, 'saved'),
                saved,
            );
            assert.deepEqual(objectA.calls, savedCalls);
            assertUploadError(await f.start(one), 409, 'space_quota');
            f.noEffects(one);
            await f.usage(accountQuota, 0);
            const otherUpload = await f.begin(other, 'b');
            assertUploadError(
                await f.start(foreign, 'b', 'a'),
                404,
                'not_found',
            );
            assertUploadError(await f.start(a, 'b'), 404, 'not_found');
            for (const [path, method, body] of [
                [f.uploadUrl(a), 'GET', undefined],
                [f.uploadUrl(a) + '/part', 'POST', { number: 1 }],
                [f.uploadUrl(a) + '/complete', 'POST', {}],
                [f.uploadUrl(a) + '/cancel', 'POST', {}],
                [f.fileUrl(a) + '/download', 'GET', undefined],
                [f.fileUrl(a), 'DELETE', undefined],
            ] as const) {
                assertUploadError(
                    await f.request(path, method, body, undefined, 'b'),
                    404,
                    'not_found',
                );
            }
            f.noEffects(foreign);
            assert.deepEqual(objectA.calls, savedCalls);
            const viewB = await f.usage(0, 1, 'b');
            assert.deepEqual(viewB.projects, [
                { id: f.projects.b, name: 'Quota B' },
            ]);
            assert.deepEqual(viewB.uploads, [otherUpload]);
            const viewA = await f.usage(accountQuota, 0);
            assert.deepEqual(viewA.projects, [
                { id: f.projects.a, name: 'Quota A' },
            ]);
            assert.deepEqual(
                viewA.uploads.map((entry: { id: string }) => entry.id),
                [b.id, a.id],
            );
            for (const input of [a, b]) f.state(input, 'saved');
        } finally {
            await f.dispose();
        }
    },
);

test(
    'WEB-A03 concurrent reserves cannot oversubscribe',
    { timeout: 20000 },
    async () => {
        const f = await openQuotaFixture();
        try {
            const seed = f.register('seed.bin', fileLimit);
            const pending = f.register('pending.bin', halfFile);
            const a = f.register('race-a.bin', halfFile);
            const b = f.register('race-b.bin', halfFile);
            await f.begin(seed);
            await f.save(seed);
            await f.usage(fileLimit, 0);
            await f.begin(pending);
            await f.usage(fileLimit, halfFile);
            const barrier = recoveryBarrier();
            f.hooks.abort = async (key, upload) => {
                if (
                    upload === undefined &&
                    [spaceObjectKey(a.id), spaceObjectKey(b.id)].includes(key)
                ) {
                    await barrier.pause();
                }
            };
            const requests = [a, b].map(async (input) => ({
                input,
                response: await f.start(input),
            }));
            let loser: QuotaInput;
            let winner: QuotaInput;
            try {
                await barrier.waitForEntry();
                const first = await Promise.race(requests);
                assertUploadError(first.response, 409, 'space_quota');
                loser = first.input;
                winner = loser === a ? b : a;
                f.noEffects(loser);
                f.state(winner, 'preparing');
                await f.usage(fileLimit, 2 * halfFile);
            } finally {
                barrier.release();
                await Promise.allSettled(requests);
            }
            const outcomes = await Promise.all(requests);
            assert.deepEqual(
                outcomes.map(({ response }) => response.status).sort(),
                [200, 409],
            );
            const winning = outcomes.find(({ input }) => input === winner)!;
            const upload = f.assertUpload(
                winning.response,
                winner,
                'uploading',
            );
            const entry = f.object(spaceObjectKey(winner.id));
            assert.equal(
                entry.calls.filter((call) => call === 'create').length,
                1,
            );
            const calls = [...entry.calls];
            assert.deepEqual(
                f.assertUpload(await f.start(winner), winner, 'uploading'),
                upload,
            );
            assert.deepEqual(entry.calls, calls);
            assertUploadError(await f.start(loser), 409, 'space_quota');
            f.noEffects(loser);
            await f.usage(fileLimit, 2 * halfFile);
        } finally {
            await f.dispose();
        }
    },
);

type QuotaFixture = Awaited<ReturnType<typeof openQuotaFixture>>;
type QuotaClock = ReturnType<typeof recoveryClock>;

async function waitForQuotaState(
    f: QuotaFixture,
    input: QuotaInput,
    expected: string,
) {
    const deadline = performance.now() + 5000;
    while (
        f.rows('SELECT state FROM space_uploads WHERE id=?', input.id)[0]
            ?.state !== expected
    ) {
        assert(
            performance.now() < deadline,
            'SQLite did not reach ' + expected,
        );
        await delay(10);
    }
    return f.state(input, expected);
}

async function quotaView(f: QuotaFixture, input: QuotaInput, expected: string) {
    const response = await f.request(f.uploadUrl(input));
    const { parts, ...json } = response.json;
    assert.deepEqual(parts, []);
    return f.assertUpload({ ...response, json }, input, expected);
}

async function rejectQuota(f: QuotaFixture, input: QuotaInput) {
    assertUploadError(await f.start(input), 409, 'space_quota');
    f.noEffects(input);
}

async function reuseQuota(f: QuotaFixture, input: QuotaInput) {
    const first = await f.begin(input);
    const entry = f.object(spaceObjectKey(input.id));
    const calls = [...entry.calls];
    assert.deepEqual(
        f.assertUpload(await f.start(input), input, 'uploading'),
        first,
    );
    assert.deepEqual(entry.calls, calls);
    await f.usage(0, fileLimit + halfFile + 1);
}

async function confirmQuotaAbort(
    f: QuotaFixture,
    clock: QuotaClock,
    input: QuotaInput,
    one: QuotaInput,
    outcome: 'cancelled' | 'expired',
) {
    const key = spaceObjectKey(input.id);
    const entry = f.object(key);
    const row = f.state(input, 'cleaning');
    assert.equal(row.cleanup, outcome);
    assert(typeof row.signedUntil === 'number' && row.signedUntil > Date.now());
    await quotaView(f, input, 'cleaning');
    assert(entry.active);
    assert.equal(entry.parts.size, 1);
    assert(!entry.calls.includes('abort'));
    await f.usage(0, accountQuota);
    await rejectQuota(f, one);
    const barrier = recoveryBarrier();
    f.hooks.abort = async (candidate, upload) => {
        if (candidate === key && upload !== undefined) await barrier.pause();
    };
    try {
        clock.advanceTo(row.signedUntil + 1);
        await clock.sweep();
        await barrier.waitForEntry();
        assert.equal(f.state(input, 'cleaning').cleanup, outcome);
        assert(entry.active);
        assert.equal(entry.parts.size, 1);
        assert(!entry.calls.includes('abort-confirmed'));
        await f.usage(0, accountQuota);
        await rejectQuota(f, one);
    } finally {
        barrier.release();
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await waitForQuotaState(f, input, outcome);
    assert.equal(entry.calls.filter((call) => call === 'abort').length, 1);
    assert.equal(
        entry.calls.filter((call) => call === 'abort-confirmed').length,
        1,
    );
    assert.equal(entry.active, false);
    assert.equal(entry.parts.size, 0);
    assert.equal(entry.size, null);
    await f.usage(0, fileLimit + halfFile);
    return quotaView(f, input, outcome);
}

test(
    'WEB-A03 cancelled quota releases after storage confirmation',
    { timeout: 20000 },
    async (t) => {
        const clock = recoveryClock(t);
        const f = await openQuotaFixture();
        try {
            const fill1 = f.register('fill1.bin', fileLimit);
            const fill2 = f.register('fill2.bin', halfFile);
            const fill3 = f.register('fill3.bin', halfFile);
            const one = f.register('one.bin', 1);
            for (const input of [fill1, fill2, fill3]) await f.begin(input);
            await f.sendPart(fill3, 1);
            await f.usage(0, accountQuota);
            const cancel = () =>
                f.request(f.uploadUrl(fill3) + '/cancel', 'POST', {});
            const cleaning = f.assertUpload(await cancel(), fill3, 'cleaning');
            assert.deepEqual(
                f.assertUpload(await cancel(), fill3, 'cleaning'),
                cleaning,
            );
            const cancelled = await confirmQuotaAbort(
                f,
                clock,
                fill3,
                one,
                'cancelled',
            );
            const entry = f.object(spaceObjectKey(fill3.id));
            const calls = [...entry.calls];
            assert.deepEqual(
                f.assertUpload(await cancel(), fill3, 'cancelled'),
                cancelled,
            );
            assert.deepEqual(entry.calls, calls);
            await reuseQuota(f, one);
        } finally {
            await f.dispose();
        }
    },
);

test(
    'WEB-A03 expired quota releases after storage confirmation',
    { timeout: 20000 },
    async (t) => {
        const clock = recoveryClock(t);
        const f = await openQuotaFixture();
        try {
            const expired = f.register('expired.bin', halfFile);
            const fill1 = f.register('fill1.bin', fileLimit);
            const fill2 = f.register('fill2.bin', halfFile);
            const one = f.register('one.bin', 1);
            const upload = await f.begin(expired);
            clock.advanceTo(upload.expires - 60_000);
            f.renewSession('a');
            await f.begin(fill1);
            await f.begin(fill2);
            await f.sendPart(expired, 1);
            await f.usage(0, accountQuota);
            clock.advanceTo(upload.expires);
            await clock.sweep();
            const cleaning = await quotaView(f, expired, 'cleaning');
            assert.equal(f.state(expired, 'cleaning').cleanup, 'expired');
            const entry = f.object(spaceObjectKey(expired.id));
            assert(entry.active);
            assert.equal(entry.parts.size, 1);
            assert(!entry.calls.includes('abort'));
            await rejectQuota(f, one);
            assertUploadError(
                await f.request(f.uploadUrl(expired) + '/part', 'POST', {
                    number: 1,
                }),
                409,
                'space_conflict',
            );
            assert.deepEqual(
                f.assertUpload(await f.start(expired), expired, 'cleaning'),
                cleaning,
            );
            const terminal = await confirmQuotaAbort(
                f,
                clock,
                expired,
                one,
                'expired',
            );
            for (const input of [fill1, fill2]) f.state(input, 'uploading');
            const calls = [...entry.calls];
            assert.deepEqual(
                f.assertUpload(await f.start(expired), expired, 'expired'),
                terminal,
            );
            assert.deepEqual(entry.calls, calls);
            await reuseQuota(f, one);
        } finally {
            await f.dispose();
        }
    },
);

test(
    'WEB-A03 deleted quota releases after storage confirmation',
    { timeout: 20000 },
    async (t) => {
        const clock = recoveryClock(t);
        const f = await openQuotaFixture();
        try {
            const deleted = f.register('delete.bin', halfFile);
            const fill1 = f.register('fill1.bin', fileLimit);
            const fill2 = f.register('fill2.bin', halfFile);
            const one = f.register('one.bin', 1);
            await f.begin(deleted);
            await f.save(deleted);
            await f.begin(fill1);
            await f.begin(fill2);
            await f.usage(halfFile, fileLimit + halfFile);
            const key = spaceObjectKey(deleted.id);
            const entry = f.object(key);
            const barrier = recoveryBarrier();
            f.hooks.remove = async (candidate) => {
                if (candidate === key) await barrier.pause();
            };
            const remove = () => f.request(f.fileUrl(deleted), 'DELETE');
            const intents = () =>
                f.rows(
                    'SELECT * FROM space_file_deletions WHERE fileId=?',
                    deleted.id,
                );
            async function pending() {
                f.state(deleted, 'deleting');
                const rows = intents();
                assert.equal(rows.length, 1);
                assert.equal(rows[0]?.phase, 'deleting');
                assert.equal(rows[0]?.executionProjectId, null);
                assertUploadError(
                    await f.request(f.fileUrl(deleted) + '/download'),
                    404,
                    'not_found',
                );
                const detail = await f.request(f.projectUrl('a'));
                assert.equal(detail.status, 200);
                assert.deepEqual(detail.json.files, []);
                assert.equal(entry.size, halfFile);
                await f.usage(halfFile, fileLimit + halfFile);
                await rejectQuota(f, one);
            }
            try {
                for (let attempt = 0; attempt < 2; attempt++) {
                    const response = await remove();
                    assert.equal(response.status, 202);
                    assert.deepEqual(response.json, { state: 'deleting' });
                }
                await pending();
                await clock.sweep();
                await barrier.waitForEntry();
                assert(!entry.calls.includes('remove-confirmed'));
                await pending();
            } finally {
                barrier.release();
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
            await waitForQuotaState(f, deleted, 'deleted');
            assert.deepEqual(intents(), []);
            assert.equal(entry.size, null);
            assert.equal(entry.active, false);
            assert.equal(entry.parts.size, 0);
            assert.equal(
                entry.calls.filter((call) => call === 'remove-confirmed')
                    .length,
                1,
            );
            const view = await f.usage(0, fileLimit + halfFile);
            assert(
                !view.uploads.some(
                    (upload: { id: string }) => upload.id === deleted.id,
                ),
            );
            const calls = [...entry.calls];
            for (let attempt = 0; attempt < 2; attempt++) {
                const response = await remove();
                assert.equal(response.status, 204);
                assert.equal(response.json, null);
            }
            assert.deepEqual(entry.calls, calls);
            await reuseQuota(f, one);
        } finally {
            await f.dispose();
        }
    },
);
