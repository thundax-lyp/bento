import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { test } from 'node:test';
import { openSpaceIntegrityFixture } from './space-integrity-fixture.ts';

test('space integrity physical HTTP fixture saves and downloads original bytes once', async () => {
    const f = await openSpaceIntegrityFixture();
    const id = randomUUID();
    const bytes = Buffer.from('abc');
    const checksums = [createHash('sha256').update(bytes).digest('base64')];
    const path = 'nested/source.txt';
    const url = '/api/space/uploads/' + id;
    const apiOrigin = f.apiOrigin;
    const objectOrigin = f.storage.origin;
    try {
        const registered = await f.request(
            `/api/space/projects/${f.projectId}/uploads`,
            'POST',
            { id, path, size: bytes.length, checksums },
        );
        assert.equal(registered.status, 200);
        await f.putPart(id, 1, bytes);
        assert.deepEqual(await f.readPart(id, 1), bytes);
        assert.equal(
            (await f.request(url + '/complete', 'POST', {})).status,
            200,
        );
        const row = f.rows('space_uploads');
        assert.equal(row.length, 1);
        assert.equal(row[0]?.state, 'saved');
        assert.equal(row[0]?.manifest, JSON.stringify(checksums));
        assert.deepEqual(await f.readObject(id), bytes);
        assert.deepEqual(await f.download(id), bytes);
        const summary = await f.request('/api/space');
        assert(
            summary.json &&
                typeof summary.json === 'object' &&
                !Array.isArray(summary.json),
        );
        assert.equal(summary.json.saved, 3);
        assert.equal(summary.json.reserved, 0);
        const tree = await f.request('/api/space/projects/' + f.projectId);
        assert(
            tree.json &&
                typeof tree.json === 'object' &&
                !Array.isArray(tree.json),
        );
        assert.deepEqual(tree.json.files, [{ id, path, size: 3 }]);
        const calls = f.calls.length;
        assert.equal(
            (await f.request(url + '/complete', 'POST', {})).status,
            200,
        );
        assert.equal(f.calls.length, calls);
        await f.reopen();
        assert.equal(f.rows('space_uploads').length, 1);
        assert.deepEqual(await f.download(id), bytes);
    } finally {
        await f.close();
    }
    await assert.rejects(access(f.dbPath));
    for (const origin of [apiOrigin, objectOrigin]) {
        await assert.rejects(
            fetch(origin, { signal: AbortSignal.timeout(1000) }),
        );
    }
});

const digest = (bytes: Buffer) =>
    createHash('sha256').update(bytes).digest('base64');
for (const [label, savedPath, candidatePath, expectedStatus, expectedCode] of [
    [
        'parent traversal',
        'nested/source.txt',
        '../x',
        400,
        'invalid_space_input',
    ],
    ['absolute path', 'nested/source.txt', '/x', 400, 'invalid_space_input'],
    ['empty segment', 'nested/source.txt', 'a//b', 400, 'invalid_space_input'],
    ['dot segment', 'nested/source.txt', 'a/./b', 400, 'invalid_space_input'],
    ['backslash', 'nested/source.txt', 'a\\b', 400, 'invalid_space_input'],
    [
        'control character',
        'nested/source.txt',
        'a\u0001b',
        400,
        'invalid_space_input',
    ],
    [
        'overlong path',
        'nested/source.txt',
        'x'.repeat(1025),
        400,
        'invalid_space_input',
    ],
    [
        'duplicate saved target',
        'nested/source.txt',
        'nested/source.txt',
        409,
        'space_conflict',
    ],
    ['file blocks directory', 'nested', 'nested/x', 409, 'space_conflict'],
    ['directory blocks file', 'nested/x', 'nested', 409, 'space_conflict'],
] as const) {
    test(`WEB-02-02 ${label}: rejected without changing original bytes or reservation`, async () => {
        const f = await openSpaceIntegrityFixture();
        try {
            const savedId = randomUUID();
            const candidateId = randomUUID();
            const bytes = Buffer.from('abc');
            const root = `/api/space/projects/${f.projectId}/uploads`;
            assert.equal(
                (
                    await f.request(root, 'POST', {
                        id: savedId,
                        path: savedPath,
                        size: 3,
                        checksums: [digest(bytes)],
                    })
                ).status,
                200,
            );
            await f.putPart(savedId, 1, bytes);
            assert.equal(
                (
                    await f.request(
                        `/api/space/uploads/${savedId}/complete`,
                        'POST',
                        {},
                    )
                ).status,
                200,
            );
            const beforeRows = f.rows('space_uploads');
            const beforeSpace = await f.request('/api/space');
            const beforeTree = await f.request(
                `/api/space/projects/${f.projectId}`,
            );
            const beforeCalls = [...f.calls];
            const rejected = await f.request(root, 'POST', {
                id: candidateId,
                path: candidatePath,
                size: 3,
                checksums: [digest(bytes)],
            });
            assert.equal(rejected.status, expectedStatus);
            assert.deepEqual(
                rejected.json &&
                    typeof rejected.json === 'object' &&
                    !Array.isArray(rejected.json)
                    ? rejected.json.error
                    : null,
                {
                    code: expectedCode,
                    message:
                        expectedStatus === 400
                            ? '文件路径无效。'
                            : '目标路径已有文件或上传。',
                },
            );
            assert.deepEqual(f.rows('space_uploads'), beforeRows);
            assert.deepEqual(f.calls, beforeCalls);
            assert.deepEqual(await f.request('/api/space'), beforeSpace);
            assert.deepEqual(
                await f.request(`/api/space/projects/${f.projectId}`),
                beforeTree,
            );
            assert.equal(await f.readObject(candidateId), null);
            assert.deepEqual(await f.readObject(savedId), bytes);
            const downloaded = await f.download(savedId);
            assert.deepEqual(downloaded, bytes);
            assert.equal(digest(downloaded), digest(bytes));
        } finally {
            await f.close();
        }
    });
}

test('WEB-02-02 active target rejects a new upload and exact replay reserves once', async () => {
    const f = await openSpaceIntegrityFixture();
    try {
        const body = {
            id: randomUUID(),
            path: 'pending.txt',
            size: 3,
            checksums: [digest(Buffer.from('abc'))],
        };
        const root = `/api/space/projects/${f.projectId}/uploads`;
        const first = await f.request(root, 'POST', body);
        assert.equal(first.status, 200);
        const before = f.rows('space_uploads');
        const calls = [...f.calls];
        assert.deepEqual(await f.request(root, 'POST', body), first);
        assert.equal(
            (await f.request(root, 'POST', { ...body, id: randomUUID() }))
                .status,
            409,
        );
        assert.deepEqual(f.rows('space_uploads'), before);
        assert.deepEqual(f.calls, calls);
        const space = await f.request('/api/space');
        assert(
            space.json &&
                typeof space.json === 'object' &&
                !Array.isArray(space.json),
        );
        assert.equal(space.json.saved, 0);
        assert.equal(space.json.reserved, 3);
    } finally {
        await f.close();
    }
});
