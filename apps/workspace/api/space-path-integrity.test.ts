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
