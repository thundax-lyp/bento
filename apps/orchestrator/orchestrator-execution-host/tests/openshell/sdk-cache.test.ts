import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cachedSdkArchive } from './binding-grants/sdk.ts';

const bytes = Buffer.from('fixed official archive fixture');
const digest = createHash('sha256').update(bytes).digest('hex');

test('downloads once and reuses verified bytes without a network call', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'bento-sdk-cache-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let downloads = 0;
    const download = async (path: string) => {
        downloads++;
        await writeFile(path, bytes);
    };
    assert.deepEqual(
        await cachedSdkArchive(directory, digest, download),
        bytes,
    );
    assert.deepEqual(
        await cachedSdkArchive(directory, digest, download),
        bytes,
    );
    assert.equal(downloads, 1);
    assert.deepEqual(await readdir(directory), ['source.tar.gz']);
});

test('rejects corrupt cached content without silently replacing it', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'bento-sdk-cache-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, 'source.tar.gz'), 'corrupt');
    await assert.rejects(
        cachedSdkArchive(directory, digest, async () => {
            assert.fail('Corrupt cache must not trigger a download');
        }),
        /checksum mismatch/,
    );
    assert.equal(
        await readFile(join(directory, 'source.tar.gz'), 'utf8'),
        'corrupt',
    );
});

for (const failure of ['interrupted', 'checksum']) {
    test(`does not publish a ${failure} download`, async (t) => {
        const directory = await mkdtemp(
            join(tmpdir(), 'bento-sdk-cache-test-'),
        );
        t.after(() => rm(directory, { recursive: true, force: true }));
        await assert.rejects(
            cachedSdkArchive(directory, digest, async (path) => {
                await writeFile(path, 'partial');
                if (failure === 'interrupted') throw new Error('interrupted');
            }),
        );
        assert.deepEqual(await readdir(directory), []);
    });
}

test('concurrent preparations publish only verified content', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'bento-sdk-cache-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const results = await Promise.all(
        Array.from({ length: 3 }, () =>
            cachedSdkArchive(directory, digest, (path) =>
                writeFile(path, bytes),
            ),
        ),
    );
    for (const result of results) assert.deepEqual(result, bytes);
    assert.deepEqual(await readdir(directory), ['source.tar.gz']);
});
